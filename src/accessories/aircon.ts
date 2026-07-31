import type { CharacteristicValue, Characteristic, Logging, PlatformAccessory, Service } from "homebridge";

import { AirconOperationMode, OperationStatus, RoomTemperature, TargetTemperature } from "../echonet/codec.js";
import type { DeviceProfile, EchonetDevice } from "../echonet/device.js";
import { AIRCON_MODE } from "../echonet/epc.js";
import type { ELPlatform } from "../platform.js";
import type { StateCell, WritableStateCell } from "./device-state.js";
import { DeviceState } from "./device-state.js";
import type { ProfileAware } from "./profile.js";
import { supportsGet, supportsSet } from "./profile.js";

// A home air conditioner (0x01/0x30) exposed as a HomeKit HeaterCooler.
export class AirConditionerAccessory implements ProfileAware {
  private readonly service: Service;
  private readonly Characteristic: typeof Characteristic;
  private readonly log: Logging;
  private readonly state: DeviceState;
  private readonly power: WritableStateCell<boolean>;
  private readonly mode: WritableStateCell<number>;
  private readonly roomTemperature: StateCell<number>;
  private readonly targetTemperature: WritableStateCell<number>;

  static create(platform: ELPlatform, accessory: PlatformAccessory, device: EchonetDevice): AirConditionerAccessory {
    platform.log.info("Initializing an AC accessory:", device.logId);
    return new AirConditionerAccessory(platform, accessory, device);
  }

  // Every characteristic reads from the shared cache below, so one refresh of
  // the accessory costs one request for all of them rather than one each.
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

    this.state = new DeviceState(this.log, device);
    this.power = this.state.track(OperationStatus);
    this.mode = this.state.track(AirconOperationMode);
    this.roomTemperature = this.state.track(RoomTemperature);
    this.targetTemperature = this.state.track(TargetTemperature);

    this.setUpActive();
    this.setUpHeaterCoolerState();
    this.setUpCurrentTemperature();
    this.pushOnChange();
  }

  // HomeKit requires Active, CurrentHeaterCoolerState, TargetHeaterCoolerState
  // and CurrentTemperature of every HeaterCooler, so those stay wired whatever
  // the device reports: removing one would leave an invalid service behind. An
  // air conditioner that cannot answer for them is only noted here — their
  // getters already degrade on their own.
  applyProfile({ maps }: DeviceProfile): void {
    this.state.applyMaps(maps);

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

  stop(): void {
    this.state.stop();
  }

  private setUpActive(): void {
    this.service
      .getCharacteristic(this.Characteristic.Active)
      .onSet(async (value) => {
        await this.power.write(value !== 0);
      })
      .onGet(async () => {
        await this.state.sync();
        return this.activeState();
      });
  }

  // Active is a HomeKit enum rather than a boolean, so the operation status is
  // mapped onto it rather than left for HAP to coerce.
  private activeState(): CharacteristicValue {
    const { Active } = this.Characteristic;
    return this.power.get() === true ? Active.ACTIVE : Active.INACTIVE;
  }

  private setUpHeaterCoolerState(): void {
    const { Characteristic } = this;

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).onGet(async () => {
      await this.state.sync();
      return this.currentState();
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
        await this.mode.write(mode);
      })
      .onGet(async () => {
        await this.state.sync();
        return this.targetState();
      });
  }

  // Both HeaterCooler states are read off the same two cached properties, so
  // they are derived here rather than each fetching what it needs.
  private currentState(): CharacteristicValue {
    const { CurrentHeaterCoolerState } = this.Characteristic;
    if (this.power.get() !== true) {
      return CurrentHeaterCoolerState.INACTIVE;
    }
    const mode = this.mode.get();
    if (mode == null) {
      return CurrentHeaterCoolerState.IDLE;
    }
    return mode === AIRCON_MODE.COOL ? CurrentHeaterCoolerState.COOLING : CurrentHeaterCoolerState.HEATING;
  }

  private targetState(): CharacteristicValue {
    const { TargetHeaterCoolerState } = this.Characteristic;
    if (this.power.get() === true) {
      const mode = this.mode.get();
      if (mode === AIRCON_MODE.COOL) {
        return TargetHeaterCoolerState.COOL;
      }
      if (mode === AIRCON_MODE.HEAT) {
        return TargetHeaterCoolerState.HEAT;
      }
    }
    return TargetHeaterCoolerState.AUTO;
  }

  private setUpCurrentTemperature(): void {
    this.service
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -127, maxValue: 125, minStep: 1 })
      // Some air conditioners have no temperature sensor, and one that has not
      // answered yet has nothing to report either. Both read as 0 °C rather
      // than as an error, which would stop the accessory working.
      .onGet(async () => {
        await this.state.sync();
        return this.roomTemperature.get() ?? 0;
      });
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
        .onSet(async (value) => {
          await this.targetTemperature.write(Math.trunc(value as number));
        })
        .onGet(async () => {
          await this.state.sync();
          return this.targetTemperature.get() ?? 0;
        });
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

  // Carries a value that arrived on its own to HomeKit: a change the device
  // announced because it was operated by other means, e.g. its physical remote,
  // and a read that landed after the getter waiting for it had already answered.
  //
  // Power and mode are pushed together because three characteristics are derived
  // from the pair of them, and either one changing moves all three.
  private pushOnChange(): void {
    const pushState = (): void => {
      const { Active, CurrentHeaterCoolerState, TargetHeaterCoolerState } = this.Characteristic;
      this.service.updateCharacteristic(Active, this.activeState());
      this.service.updateCharacteristic(CurrentHeaterCoolerState, this.currentState());
      this.service.updateCharacteristic(TargetHeaterCoolerState, this.targetState());
    };
    this.power.onChange(pushState);
    this.mode.onChange(pushState);

    this.roomTemperature.onChange((value) => {
      if (value != null) {
        this.service.updateCharacteristic(this.Characteristic.CurrentTemperature, value);
      }
    });
    this.targetTemperature.onChange((value) => {
      if (value == null) {
        return;
      }
      for (const characteristic of this.thresholdTemperatures()) {
        if (this.service.testCharacteristic(characteristic)) {
          this.service.updateCharacteristic(characteristic, value);
        }
      }
    });
  }
}
