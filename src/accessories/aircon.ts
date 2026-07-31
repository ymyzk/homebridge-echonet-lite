import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";

import type { EchonetDevice } from "../echonet-device.js";
import { AIRCON_EPC, AIRCON_MODE, SUPER_EPC } from "../epc.js";
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
    (async () => {
      const maps = (await device.getPropertyMaps()).message.data;
      platform.log.debug("INF properties for", device.logId, formatProperties(maps?.inf));
      platform.log.debug("Get properties for", device.logId, formatProperties(maps?.get));
      platform.log.debug("Set properties for", device.logId, formatProperties(maps?.set));
    })();

    const { Characteristic } = platform;
    this.service =
      accessory.getService(platform.Service.HeaterCooler) ?? accessory.addService(platform.Service.HeaterCooler);

    this.service
      .getCharacteristic(Characteristic.Active)
      .onSet(async (value) => {
        await device.set(SUPER_EPC.OPERATION_STATUS, { status: value !== 0 });
      })
      .onGet(async () => {
        return (await device.getData(SUPER_EPC.OPERATION_STATUS)).status ?? false;
      });

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).onGet(async () => {
      try {
        const { status } = await device.getData(SUPER_EPC.OPERATION_STATUS);
        if (!status) {
          return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
      } catch (err) {
        platform.log.error("Failed to get AC operation status from", device.logId, err);
        return Characteristic.CurrentHeaterCoolerState.INACTIVE;
      }
      try {
        const { mode } = await device.getData(AIRCON_EPC.OPERATION_MODE);
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
        await device.set(AIRCON_EPC.OPERATION_MODE, { mode });
      })
      .onGet(async () => {
        let state: CharacteristicValue = Characteristic.TargetHeaterCoolerState.AUTO;
        try {
          const { status } = await device.getData(SUPER_EPC.OPERATION_STATUS);
          if (status) {
            const { mode } = await device.getData(AIRCON_EPC.OPERATION_MODE);
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

    const temperatureSetter = (epc: number) => async (value: CharacteristicValue) => {
      await device.set(epc, { temperature: Math.trunc(value as number) });
    };
    const temperatureGetter = (epc: number) => async () => {
      try {
        const { temperature } = await device.getData(epc);
        return temperature ?? 0;
      } catch (err) {
        // Some air conditioners do not have temperature sensor, reporting error
        // would make the accessory stop working.
        return 0;
      }
    };
    this.service
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({ minValue: -127, maxValue: 125, minStep: 1 })
      .onGet(temperatureGetter(AIRCON_EPC.ROOM_TEMPERATURE));
    this.service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
      .onSet(temperatureSetter(AIRCON_EPC.TARGET_TEMPERATURE))
      .onGet(temperatureGetter(AIRCON_EPC.TARGET_TEMPERATURE));
    this.service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
      .onSet(temperatureSetter(AIRCON_EPC.TARGET_TEMPERATURE))
      .onGet(temperatureGetter(AIRCON_EPC.TARGET_TEMPERATURE));
  }
}
