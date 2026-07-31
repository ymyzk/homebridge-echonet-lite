import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import type { Property, WritableProperty } from "../codec.js";
import { AirconOperationMode, OperationStatus, RoomTemperature, TargetTemperature } from "../codec.js";
import type { EchonetDevice } from "../echonet-device.js";
import { AIRCON_MODE } from "../epc.js";
import type { ELPlatform } from "../platform.js";
import { formatProperties } from "../utils.js";

// A home air conditioner (0x01/0x30) exposed as a HomeKit HeaterCooler.
export class AirConditionerAccessory {
  private readonly service: Service;

  static create(platform: ELPlatform, accessory: PlatformAccessory, device: EchonetDevice): AirConditionerAccessory {
    return new AirConditionerAccessory(platform, accessory, device);
  }

  // Every characteristic reads through to the device, so nothing needs to be
  // retained beyond the wiring done here.
  private constructor(platform: ELPlatform, accessory: PlatformAccessory, device: EchonetDevice) {
    platform.log.info("Initializing an AC accessory:", device.logId);
    void (async () => {
      try {
        const maps = await device.getPropertyMaps();
        platform.log.debug("INF properties for", device.logId, formatProperties(maps.inf));
        platform.log.debug("Get properties for", device.logId, formatProperties(maps.get));
        platform.log.debug("Set properties for", device.logId, formatProperties(maps.set));
      } catch (err) {
        platform.log.debug("Failed to get property maps for", device.logId, err);
      }
    })();

    const { Characteristic } = platform;
    this.service =
      accessory.getService(platform.Service.HeaterCooler) ?? accessory.addService(platform.Service.HeaterCooler);

    this.service
      .getCharacteristic(Characteristic.Active)
      .onSet(async (value) => {
        await device.set(OperationStatus, value !== 0);
      })
      .onGet(async () => {
        return (await device.get(OperationStatus)) ?? false;
      });

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).onGet(async () => {
      try {
        if (!(await device.get(OperationStatus))) {
          return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
      } catch (err) {
        platform.log.error("Failed to get AC operation status from", device.logId, err);
        return Characteristic.CurrentHeaterCoolerState.INACTIVE;
      }
      try {
        const mode = await device.get(AirconOperationMode);
        return mode === AIRCON_MODE.COOL
          ? Characteristic.CurrentHeaterCoolerState.COOLING
          : Characteristic.CurrentHeaterCoolerState.HEATING;
      } catch (err) {
        platform.log.error("Failed to get AC mode from", device.logId, err);
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
        await device.set(AirconOperationMode, mode);
      })
      .onGet(async () => {
        let state: CharacteristicValue = Characteristic.TargetHeaterCoolerState.AUTO;
        try {
          if (await device.get(OperationStatus)) {
            const mode = await device.get(AirconOperationMode);
            if (mode === AIRCON_MODE.COOL) {
              state = Characteristic.TargetHeaterCoolerState.COOL;
            } else if (mode === AIRCON_MODE.HEAT) {
              state = Characteristic.TargetHeaterCoolerState.HEAT;
            }
          }
        } catch (err) {
          platform.log.error("Failed to get TargetHeaterCoolerState from", device.logId, err);
          return state;
        }
        return state;
      });

    const temperatureSetter = (property: WritableProperty<number>) => async (value: CharacteristicValue) => {
      await device.set(property, Math.trunc(value as number));
    };
    const temperatureGetter = (property: Property<number>) => async () => {
      try {
        return (await device.get(property)) ?? 0;
      } catch {
        // Some air conditioners do not have temperature sensor, reporting error
        // would make the accessory stop working.
        return 0;
      }
    };
    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -127, maxValue: 125, minStep: 1 })
      .onGet(temperatureGetter(RoomTemperature));
    this.service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 0, maxValue: 50, minStep: 1 })
      .onSet(temperatureSetter(TargetTemperature))
      .onGet(temperatureGetter(TargetTemperature));
    this.service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 0, maxValue: 50, minStep: 1 })
      .onSet(temperatureSetter(TargetTemperature))
      .onGet(temperatureGetter(TargetTemperature));
  }
}
