import type { Characteristic, Logging, PlatformAccessory, Service } from "homebridge";

import { IlluminanceLevel, OperationStatus } from "../codec.js";
import type { EchonetDevice } from "../echonet-device.js";
import type { ELPlatform } from "../platform.js";
import { formatProperties, toHex } from "../utils.js";

// Returns the settable EPCs, logging everything the device reports it supports
// along the way.
async function readSettableProperties(log: Logging, device: EchonetDevice): Promise<number[]> {
  const maps = await device.getPropertyMaps();
  log.debug("INF properties for", device.logId, formatProperties(maps.inf));
  log.debug("Get properties for", device.logId, formatProperties(maps.get));
  log.debug("Set properties for", device.logId, formatProperties(maps.set));
  return maps.set;
}

// Returns null when the device does not answer, which marks it unusable.
async function readStatus(log: Logging, device: EchonetDevice): Promise<boolean | null> {
  try {
    return await device.get(OperationStatus);
  } catch (err) {
    log.warn("Failed to get initial status from", device.logId, err);
    return null;
  }
}

// Falls back to 0 so an unreadable level does not block registration.
async function readBrightness(log: Logging, device: EchonetDevice): Promise<number> {
  try {
    const level = await device.get(IlluminanceLevel);
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
  private readonly Characteristic: typeof Characteristic;
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

    const supportsBrightness = settableProperties.includes(IlluminanceLevel.epc);
    const brightness = supportsBrightness ? await readBrightness(log, device) : 0;
    log.info("Initialized light accessory:", device.logId, "status:", status, "brightness:", brightness);

    return new LightAccessory(platform, accessory, device, supportsBrightness, status, brightness);
  }

  private constructor(
    platform: ELPlatform,
    accessory: PlatformAccessory,
    private readonly device: EchonetDevice,
    supportsBrightness: boolean,
    initialStatus: boolean,
    initialBrightness: number,
  ) {
    this.Characteristic = platform.Characteristic;
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
      .getCharacteristic(this.Characteristic.On)
      .onSet(async (value) => {
        const status = value as boolean;
        await this.device.set(OperationStatus, status);
        this.updateStatus(status);
        this.log.info("Set status:", this.device.logId, status);
      })
      .onGet(async () => {
        this.log.debug("Getting status from", this.device.logId);
        try {
          const status = await this.device.get(OperationStatus);
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
      .getCharacteristic(this.Characteristic.Brightness)
      .onSet(async (value) => {
        const level = value as number;
        // Dragging the brightness slider sends a write per step and sets run
        // one at a time, so the cache is updated before the write rather than
        // after it: the repeats are dropped here instead of queueing up.
        if (level === this.brightness) {
          this.log.debug("Setting brightness no-op:", this.device.logId, level);
          return;
        }
        this.log.debug("Setting brightness:", this.device.logId, level);
        this.updateBrightness(level);
        await this.device.set(IlluminanceLevel, level);
      })
      .onGet(async () => {
        this.log.debug("Getting brightness from", this.device.logId);
        try {
          const level = await this.device.get(IlluminanceLevel);
          this.log.debug("Got brightness:", this.device.logId, level);
          if (level != null) {
            this.updateBrightness(level);
          }
        } catch (err) {
          this.log.error("Failed to get brightness from", this.device.logId, err);
        }
        return this.brightness;
      });
  }

  // Keeps HomeKit in sync when the device is operated by other means, e.g. its
  // physical remote.
  private subscribeToNotifications(): void {
    this.device.onNotify((notification) => {
      this.log.debug("Received a notification from", this.device.logId);

      for (const [epc, edt] of notification.properties) {
        this.log.debug("Notification property:", this.device.logId, toHex(epc), edt.toString("hex"));

        if (epc === OperationStatus.epc) {
          const status = OperationStatus.decode(edt);
          if (status != null) {
            this.updateStatus(status);
            this.log.info("Received and updated status:", this.device.logId, status);
          }
        } else if (epc === IlluminanceLevel.epc) {
          const level = IlluminanceLevel.decode(edt);
          if (level != null) {
            this.updateBrightness(level);
            this.log.info("Received and updated brightness:", this.device.logId, level);
          }
        }
      }
    });
  }

  private updateStatus(value: boolean): void {
    this.status = value;
    this.service.updateCharacteristic(this.Characteristic.On, value);
  }

  private updateBrightness(value: number): void {
    this.brightness = value;
    this.service.updateCharacteristic(this.Characteristic.Brightness, value);
  }
}
