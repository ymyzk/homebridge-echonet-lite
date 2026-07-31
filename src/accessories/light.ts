import type { Characteristic, Logging, PlatformAccessory, Service } from "homebridge";

import { IlluminanceLevel, OperationStatus } from "../echonet/codec.js";
import type { DeviceProfile, EchonetDevice } from "../echonet/device.js";
import { toHex } from "../echonet/utils.js";
import type { ELPlatform } from "../platform.js";
import type { ProfileAware } from "./profile.js";
import { supportsSet } from "./profile.js";

// A general lighting (0x02/0x90) or mono functional lighting (0x02/0x91) device
// exposed as a HomeKit Lightbulb.
export class LightAccessory implements ProfileAware {
  private readonly service: Service;
  private readonly Characteristic: typeof Characteristic;
  private readonly log: Logging;
  private status = false;
  private brightness = 0;

  static create(platform: ELPlatform, accessory: PlatformAccessory, device: EchonetDevice): LightAccessory {
    platform.log.info("Initializing a light accessory:", device.logId);
    return new LightAccessory(platform, accessory, device);
  }

  // Only On, which every lighting device is required to support, is wired here.
  // Brightness waits for the property maps; see applyProfile.
  private constructor(
    platform: ELPlatform,
    accessory: PlatformAccessory,
    private readonly device: EchonetDevice,
  ) {
    this.Characteristic = platform.Characteristic;
    this.log = platform.log;
    this.service = accessory.getService(platform.Service.Lightbulb) ?? accessory.addService(platform.Service.Lightbulb);

    this.setUpPower();
    this.subscribeToNotifications();
  }

  // A restored accessory keeps the Brightness it was cached with until the
  // device says otherwise, so a light that is merely offline is left alone.
  applyProfile({ maps }: DeviceProfile): void {
    const supportsBrightness = supportsSet(maps, IlluminanceLevel);
    this.log.debug("Light accessory:", this.device.logId, "brightness:", supportsBrightness);
    if (supportsBrightness) {
      this.setUpBrightness();
    } else {
      this.removeBrightness();
    }
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

  // Idempotent, so that a refresh can call it again: getCharacteristic adds the
  // optional characteristic only when the service does not already carry it, and
  // onSet/onGet replace the handler rather than stacking another one on it.
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

  // Drops a Brightness an earlier release, or an earlier answer from the device,
  // left on a restored accessory. testCharacteristic rather than
  // getCharacteristic, which would add the very thing being removed.
  private removeBrightness(): void {
    const { Brightness } = this.Characteristic;
    if (this.service.testCharacteristic(Brightness)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(Brightness));
    }
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
    // A light that reports no settable brightness has no Brightness to update;
    // pushing to one HomeKit does not know about only earns a warning.
    if (this.service.testCharacteristic(this.Characteristic.Brightness)) {
      this.service.updateCharacteristic(this.Characteristic.Brightness, value);
    }
  }
}
