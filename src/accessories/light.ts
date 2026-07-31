import type { Characteristic, Logging, PlatformAccessory, Service } from "homebridge";

import { IlluminanceLevel, OperationStatus } from "../echonet/codec.js";
import type { EchonetDevice } from "../echonet/device.js";
import type { EPC } from "../echonet/types.js";
import { formatProperties, toHex } from "../echonet/utils.js";
import type { ELPlatform } from "../platform.js";

// Returns the settable EPCs, logging everything the device reports it supports
// along the way.
async function readSettableProperties(log: Logging, device: EchonetDevice): Promise<EPC[]> {
  const maps = await device.getPropertyMaps();
  log.debug("INF properties for", device.logId, formatProperties(maps.inf));
  log.debug("Get properties for", device.logId, formatProperties(maps.get));
  log.debug("Set properties for", device.logId, formatProperties(maps.set));
  return maps.set;
}

// A general lighting (0x02/0x90) or mono functional lighting (0x02/0x91) device
// exposed as a HomeKit Lightbulb.
export class LightAccessory {
  private readonly service: Service;
  private readonly Characteristic: typeof Characteristic;
  private readonly log: Logging;
  private status = false;
  private brightness = 0;

  // Reads the property maps before wiring characteristics; rejects when the
  // device does not answer at all, so it is not registered.
  static async create(
    platform: ELPlatform,
    accessory: PlatformAccessory,
    device: EchonetDevice,
  ): Promise<LightAccessory> {
    const { log } = platform;
    log.info("Initializing a light accessory:", device.logId);

    const settableProperties = await readSettableProperties(log, device);
    const supportsBrightness = settableProperties.includes(IlluminanceLevel.epc);
    log.info("Initialized light accessory:", device.logId, "brightness:", supportsBrightness);

    return new LightAccessory(platform, accessory, device, supportsBrightness);
  }

  private constructor(
    platform: ELPlatform,
    accessory: PlatformAccessory,
    private readonly device: EchonetDevice,
    supportsBrightness: boolean,
  ) {
    this.Characteristic = platform.Characteristic;
    this.log = platform.log;
    this.service = accessory.getService(platform.Service.Lightbulb) ?? accessory.addService(platform.Service.Lightbulb);

    this.setUpPower();
    if (supportsBrightness) {
      this.setUpBrightness();
    }
    this.subscribeToNotifications();
  }

  private setUpPower(): void {
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

  private setUpBrightness(): void {
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
