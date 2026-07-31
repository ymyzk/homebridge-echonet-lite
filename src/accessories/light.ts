import type { Logging, PlatformAccessory, Service } from "homebridge";

import type { EchonetDevice } from "../echonet-device.js";
import { LIGHT_EPC, SUPER_EPC } from "../epc.js";
import type { ELPlatform } from "../platform.js";
import { formatProperties } from "../utils.js";

// The illuminance level is read from the raw property buffer: some devices
// answer with an EDT that node-echonet-lite does not decode into `data.level`.
function illuminanceLevelOf(buffer: Buffer | undefined): number | null {
  return buffer != null && buffer.length > 0 ? buffer.readUInt8(0) : null;
}

// Returns the settable EPCs, logging everything the device reports it supports
// along the way.
async function readSettableProperties(log: Logging, device: EchonetDevice): Promise<number[]> {
  const maps = (await device.getPropertyMaps()).message.data;
  log.debug("INF properties for", device.logId, formatProperties(maps?.inf));
  log.debug("Get properties for", device.logId, formatProperties(maps?.get));
  log.debug("Set properties for", device.logId, formatProperties(maps?.set));
  return maps?.set ?? [];
}

// Returns null when the device does not answer, which marks it unusable.
async function readStatus(log: Logging, device: EchonetDevice): Promise<boolean | null> {
  try {
    return (await device.getData(SUPER_EPC.OPERATION_STATUS)).status ?? null;
  } catch {
    log.warn("Failed to get initial status from", device.logId);
    return null;
  }
}

// Falls back to 0 so an unreadable level does not block registration.
async function readBrightness(log: Logging, device: EchonetDevice): Promise<number> {
  try {
    const level = illuminanceLevelOf((await device.get(LIGHT_EPC.ILLUMINANCE_LEVEL)).message.prop?.[0]?.buffer);
    if (level != null) {
      log.debug("Initialized brightness:", device.logId, level);
      return level;
    }
  } catch (err) {
    log.warn("Failed to get initial brightness from", device.logId, err);
  }
  return 0;
}

// A general lighting (0x02/0x90) or mono functional lighting (0x02/0x91) device
// exposed as a HomeKit Lightbulb.
export class LightAccessory {
  private readonly service: Service;
  private readonly log: Logging;
  private status = false;
  private brightness = 0;

  // Probes the device before wiring characteristics; returns null when the
  // device does not respond so it is not registered.
  static async create(
    platform: ELPlatform,
    accessory: PlatformAccessory,
    device: EchonetDevice,
  ): Promise<LightAccessory | null> {
    const { log } = platform;
    log.info("Initializing a light accessory:", device.logId);

    const settableProperties = await readSettableProperties(log, device);
    const status = await readStatus(log, device);
    if (status == null) {
      return null;
    }

    const supportsBrightness = settableProperties.includes(LIGHT_EPC.ILLUMINANCE_LEVEL);
    const brightness = supportsBrightness ? await readBrightness(log, device) : 0;
    log.info("Initialized light accessory:", device.logId, "status:", status, "brightness:", brightness);

    return new LightAccessory(platform, accessory, device, supportsBrightness, status, brightness);
  }

  private constructor(
    private readonly platform: ELPlatform,
    accessory: PlatformAccessory,
    private readonly device: EchonetDevice,
    supportsBrightness: boolean,
    initialStatus: boolean,
    initialBrightness: number,
  ) {
    this.log = platform.log;
    this.service = accessory.getService(platform.Service.Lightbulb) ?? accessory.addService(platform.Service.Lightbulb);

    this.setUpPower(initialStatus);
    if (supportsBrightness) {
      this.setUpBrightness(initialBrightness);
    }
    this.subscribeToNotifications();
  }

  private setUpPower(initialStatus: boolean): void {
    this.updateStatus(initialStatus);
    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(async (value) => {
        const status = value as boolean;
        await this.device.set(SUPER_EPC.OPERATION_STATUS, { status });
        this.updateStatus(status);
        this.log.info("Set status", status, "for", this.device.logId);
      })
      .onGet(async () => {
        this.log.debug("Getting status from", this.device.logId);
        try {
          const status = (await this.device.getData(SUPER_EPC.OPERATION_STATUS)).status;
          if (status != null) {
            this.updateStatus(status);
            this.log.debug("Got status:", this.device.logId, status);
          }
        } catch (err) {
          this.log.error("Failed to get status from", this.device.logId, err);
        }
        return this.status;
      });
  }

  private setUpBrightness(initialBrightness: number): void {
    this.updateBrightness(initialBrightness);
    this.service
      .getCharacteristic(this.platform.Characteristic.Brightness)
      .onSet(async (value) => {
        const level = value as number;
        if (level === this.brightness) {
          this.log.debug("Setting brightness no-op", level, "for", this.device.logId);
          return;
        }
        this.log.debug("Setting brightness", level, "for", this.device.logId);
        this.updateBrightness(level);
        await this.device.set(LIGHT_EPC.ILLUMINANCE_LEVEL, { level });
      })
      .onGet(() => {
        this.log.debug("Getting brightness from", this.device.logId);
        // Refresh in the background; respond immediately with the cached value.
        void this.refreshBrightness();
        return this.brightness;
      });
  }

  // Keeps HomeKit in sync when the device is operated by other means, e.g. its
  // physical remote.
  private subscribeToNotifications(): void {
    this.device.onNotify((res) => {
      this.log.debug("Received a notification from", this.device.logId);

      for (const property of res.message.prop ?? []) {
        this.log.debug("Notification property:", this.device.logId, property.epc, property.edt);

        if (property.epc === SUPER_EPC.OPERATION_STATUS && property.edt?.status != null) {
          this.updateStatus(property.edt.status);
          this.log.info("Received and updated status:", this.device.logId, property.edt.status);
        } else if (property.epc === LIGHT_EPC.ILLUMINANCE_LEVEL) {
          const level = illuminanceLevelOf(property.buffer);
          if (level != null) {
            this.log.info("Received and updated brightness:", this.device.logId, level);
            this.updateBrightness(level);
          }
        }
      }
    });
  }

  private updateStatus(value: boolean): void {
    this.status = value;
    this.service.updateCharacteristic(this.platform.Characteristic.On, value);
  }

  private updateBrightness(value: number): void {
    this.brightness = value;
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, value);
  }

  private async refreshBrightness(): Promise<void> {
    try {
      const level = illuminanceLevelOf((await this.device.get(LIGHT_EPC.ILLUMINANCE_LEVEL)).message.prop?.[0]?.buffer);
      this.log.debug("Got brightness:", this.device.logId, level);
      if (level != null) {
        this.updateBrightness(level);
      }
    } catch (err) {
      this.log.error("Failed to get brightness from", this.device.logId, err);
    }
  }
}
