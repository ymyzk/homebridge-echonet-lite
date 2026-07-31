import type { CharacteristicValue, Characteristic, Logging, PlatformAccessory, Service } from "homebridge";

import type { Property, WritableProperty } from "../echonet/codec.js";
import { AirconOperationMode, OperationStatus, RoomTemperature, TargetTemperature } from "../echonet/codec.js";
import type { DeviceProfile, EchonetDevice } from "../echonet/device.js";
import { AIRCON_MODE } from "../echonet/epc.js";
import type { ELPlatform } from "../platform.js";
import type { ProfileAware } from "./profile.js";
import { supportsGet, supportsSet } from "./profile.js";

// A home air conditioner (0x01/0x30) exposed as a HomeKit HeaterCooler.
export class AirConditionerAccessory implements ProfileAware {
  private readonly service: Service;
  private readonly Characteristic: typeof Characteristic;
  private readonly log: Logging;

  static create(platform: ELPlatform, accessory: PlatformAccessory, device: EchonetDevice): AirConditionerAccessory {
    platform.log.info("Initializing an AC accessory:", device.logId);
    return new AirConditionerAccessory(platform, accessory, device);
  }

  // Every characteristic reads through to the device, so nothing needs to be
  // retained beyond the wiring done here.
  //
  // Only the characteristics HomeKit requires of a HeaterCooler are wired up
  // front; the optional ones wait for the property maps. See applyProfile.
  private constructor(
    platform: ELPlatform,
    accessory: PlatformAccessory,
    private readonly device: EchonetDevice,
  ) {
    this.Characteristic = platform.Characteristic;
    this.log = platform.log;
    this.service =
      accessory.getService(platform.Service.HeaterCooler) ?? accessory.addService(platform.Service.HeaterCooler);

    this.setUpActive();
    this.setUpHeaterCoolerState();
    this.setUpCurrentTemperature();
  }

  // HomeKit requires Active, CurrentHeaterCoolerState, TargetHeaterCoolerState
  // and CurrentTemperature of every HeaterCooler, so those stay wired whatever
  // the device reports: removing one would leave an invalid service behind. An
  // air conditioner that cannot answer for them is only noted here — their
  // getters already degrade on their own.
  applyProfile({ maps }: DeviceProfile): void {
    if (!supportsGet(maps, RoomTemperature)) {
      this.log.debug("AC accessory:", this.device.logId, "reports no room temperature");
    }
    if (!supportsGet(maps, AirconOperationMode)) {
      this.log.debug("AC accessory:", this.device.logId, "reports no operation mode");
    }

    // The threshold temperatures are optional, so an air conditioner whose
    // target temperature cannot be written keeps them out of the Home app
    // instead of showing a slider that does nothing.
    const supportsTargetTemperature = supportsSet(maps, TargetTemperature);
    this.log.debug("AC accessory:", this.device.logId, "target temperature:", supportsTargetTemperature);
    if (supportsTargetTemperature) {
      this.setUpThresholdTemperatures();
    } else {
      this.removeThresholdTemperatures();
    }
  }

  private setUpActive(): void {
    this.service
      .getCharacteristic(this.Characteristic.Active)
      .onSet(async (value) => {
        await this.device.set(OperationStatus, value !== 0);
      })
      .onGet(async () => {
        return (await this.device.get(OperationStatus)) ?? false;
      });
  }

  private setUpHeaterCoolerState(): void {
    const { Characteristic } = this;

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).onGet(async () => {
      try {
        if (!(await this.device.get(OperationStatus))) {
          return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
      } catch (err) {
        this.log.error("Failed to get AC operation status from", this.device.logId, err);
        return Characteristic.CurrentHeaterCoolerState.INACTIVE;
      }
      try {
        const mode = await this.device.get(AirconOperationMode);
        return mode === AIRCON_MODE.COOL
          ? Characteristic.CurrentHeaterCoolerState.COOLING
          : Characteristic.CurrentHeaterCoolerState.HEATING;
      } catch (err) {
        this.log.error("Failed to get AC mode from", this.device.logId, err);
        return Characteristic.CurrentHeaterCoolerState.IDLE;
      }
    });

    this.service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onSet(async (value) => {
        // Turning the device off is handled by the Active characteristic;
        // TargetHeaterCoolerState only selects the mode.
        let mode: number = AIRCON_MODE.AUTO;
        if (value === Characteristic.TargetHeaterCoolerState.COOL) {
          mode = AIRCON_MODE.COOL;
        } else if (value === Characteristic.TargetHeaterCoolerState.HEAT) {
          mode = AIRCON_MODE.HEAT;
        }
        await this.device.set(AirconOperationMode, mode);
      })
      .onGet(async () => {
        let state: CharacteristicValue = Characteristic.TargetHeaterCoolerState.AUTO;
        try {
          if (await this.device.get(OperationStatus)) {
            const mode = await this.device.get(AirconOperationMode);
            if (mode === AIRCON_MODE.COOL) {
              state = Characteristic.TargetHeaterCoolerState.COOL;
            } else if (mode === AIRCON_MODE.HEAT) {
              state = Characteristic.TargetHeaterCoolerState.HEAT;
            }
          }
        } catch (err) {
          this.log.error("Failed to get TargetHeaterCoolerState from", this.device.logId, err);
          return state;
        }
        return state;
      });
  }

  private setUpCurrentTemperature(): void {
    this.service
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -127, maxValue: 125, minStep: 1 })
      .onGet(this.temperatureGetter(RoomTemperature));
  }

  // Both thresholds are mapped to the one target temperature the device has:
  // HomeKit asks for a cooling and a heating setpoint, ECHONET Lite has 0xB3.
  //
  // Idempotent, so that a refresh can call it again: getCharacteristic adds an
  // optional characteristic only when the service does not already carry it, and
  // onSet/onGet replace the handler rather than stacking another one on it.
  private setUpThresholdTemperatures(): void {
    for (const characteristic of this.thresholdTemperatures()) {
      this.service
        .getCharacteristic(characteristic)
        .setProps({ minValue: 0, maxValue: 50, minStep: 1 })
        .onSet(this.temperatureSetter(TargetTemperature))
        .onGet(this.temperatureGetter(TargetTemperature));
    }
  }

  // testCharacteristic rather than getCharacteristic, which would add the very
  // thing being removed.
  private removeThresholdTemperatures(): void {
    for (const characteristic of this.thresholdTemperatures()) {
      if (this.service.testCharacteristic(characteristic)) {
        this.service.removeCharacteristic(this.service.getCharacteristic(characteristic));
      }
    }
  }

  private thresholdTemperatures() {
    return [this.Characteristic.CoolingThresholdTemperature, this.Characteristic.HeatingThresholdTemperature];
  }

  private temperatureSetter(property: WritableProperty<number>) {
    return async (value: CharacteristicValue) => {
      await this.device.set(property, Math.trunc(value as number));
    };
  }

  private temperatureGetter(property: Property<number>) {
    return async () => {
      try {
        return (await this.device.get(property)) ?? 0;
      } catch {
        // Some air conditioners do not have temperature sensor, reporting error
        // would make the accessory stop working.
        return 0;
      }
    };
  }
}
