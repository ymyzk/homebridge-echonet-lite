import type { Characteristic, Logging, PlatformAccessory, Service } from "homebridge";

import { IlluminanceLevel, OperationStatus } from "../echonet/codec.js";
import type { DeviceProfile, EchonetDevice } from "../echonet/device.js";
import type { ELPlatform } from "../platform.js";
import type { WritableStateCell } from "./device-state.js";
import { DeviceState } from "./device-state.js";
import type { ProfileAware } from "./profile.js";
import { supportsSet } from "./profile.js";

// A general lighting (0x02/0x90) or mono functional lighting (0x02/0x91) device
// exposed as a HomeKit Lightbulb.
export class LightAccessory implements ProfileAware {
  private readonly service: Service;
  private readonly Characteristic: typeof Characteristic;
  private readonly log: Logging;
  private readonly state: DeviceState;
  private readonly status: WritableStateCell<boolean>;
  private readonly brightness: WritableStateCell<number>;

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

    // Both properties are tracked from the start, whether or not a
    // characteristic ends up exposing them: they cost nothing until something
    // reads them, and they then travel in the same request.
    this.state = new DeviceState(this.log, device);
    this.status = this.state.track(OperationStatus);
    this.brightness = this.state.track(IlluminanceLevel);

    this.setUpPower();
    this.pushOnChange();
  }

  // A restored accessory keeps the Brightness it was cached with until the
  // device says otherwise, so a light that is merely offline is left alone.
  applyProfile({ maps }: DeviceProfile): void {
    this.state.applyMaps(maps);

    const supportsBrightness = supportsSet(maps, IlluminanceLevel);
    this.log.debug("Light accessory:", this.device.logId, "brightness:", supportsBrightness);
    if (supportsBrightness) {
      this.setUpBrightness();
    } else {
      this.removeBrightness();
    }
  }

  stop(): void {
    this.state.stop();
  }

  private setUpPower(): void {
    this.service
      .getCharacteristic(this.Characteristic.On)
      .onSet(async (value) => {
        const status = value as boolean;
        await this.status.write(status);
        this.log.debug("Set status:", this.device.logId, status);
      })
      .onGet(async () => {
        await this.state.sync();
        return this.status.get() ?? false;
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
        // Dragging the brightness slider sends a write per step and writes to
        // one device run one at a time, so the repeats are dropped here rather
        // than left to queue up. The cache is already current for them: a write
        // updates it before going out.
        if (level === this.brightness.get()) {
          this.log.debug("Setting brightness no-op:", this.device.logId, level);
          return;
        }
        this.log.debug("Setting brightness:", this.device.logId, level);
        await this.brightness.write(level);
      })
      .onGet(async () => {
        await this.state.sync();
        return this.brightness.get() ?? 0;
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

  // Carries a value that arrived on its own to HomeKit: a change the device
  // announced because it was operated by other means, e.g. its physical remote,
  // and a read that landed after the getter waiting for it had already answered.
  private pushOnChange(): void {
    this.status.onChange((value) => {
      if (value != null) {
        this.service.updateCharacteristic(this.Characteristic.On, value);
      }
    });
    this.brightness.onChange((value) => {
      // A light that reports no settable brightness has no Brightness to
      // update; pushing to one HomeKit does not know about only earns a warning.
      if (value != null && this.service.testCharacteristic(this.Characteristic.Brightness)) {
        this.service.updateCharacteristic(this.Characteristic.Brightness, value);
      }
    });
  }
}
