import type { CharacteristicValue, PlatformAccessory, Service } from "homebridge";
import type { ELPropertyData, ELResponse } from "node-echonet-lite";

import type { EchonetLiteClient } from "../echonet-lite.js";
import type { ELPlatform } from "../platform.js";
import type { EOJ } from "../types.js";

// Unwraps the property payload, throwing when the device returned an empty
// response so callers' catch-based fallbacks kick in.
function requireData(res: ELResponse): ELPropertyData {
  const data = res.message.data;
  if (data == null) {
    throw new Error("Empty response data");
  }
  return data;
}

// A home air conditioner (0x01/0x30) exposed as a HomeKit HeaterCooler.
export class AirConditionerAccessory {
  private readonly service: Service;

  static create(
    platform: ELPlatform,
    accessory: PlatformAccessory,
    el: EchonetLiteClient,
    address: string,
    eoj: EOJ,
  ): AirConditionerAccessory {
    return new AirConditionerAccessory(platform, accessory, el, address, eoj);
  }

  private constructor(
    private readonly platform: ELPlatform,
    accessory: PlatformAccessory,
    private readonly el: EchonetLiteClient,
    private readonly address: string,
    private readonly eoj: EOJ,
  ) {
    const { Characteristic } = platform;
    this.service =
      accessory.getService(platform.Service.HeaterCooler) ?? accessory.addService(platform.Service.HeaterCooler);

    this.service
      .getCharacteristic(Characteristic.Active)
      .onSet(async (value) => {
        await el.setPropertyValue(address, eoj, 0x80, { status: value !== 0 });
      })
      .onGet(async () => {
        return requireData(await el.getPropertyValue(address, eoj, 0x80)).status ?? false;
      });

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).onGet(async () => {
      try {
        const { status } = requireData(await el.getPropertyValue(address, eoj, 0x80));
        if (!status) {
          return Characteristic.CurrentHeaterCoolerState.INACTIVE;
        }
        const { compressor } = requireData(await el.getPropertyValue(address, eoj, 0xcd));
        if (!compressor) {
          return Characteristic.CurrentHeaterCoolerState.IDLE;
        }
        const { mode } = requireData(await el.getPropertyValue(address, eoj, 0xb0));
        return mode === 2
          ? Characteristic.CurrentHeaterCoolerState.COOLING
          : Characteristic.CurrentHeaterCoolerState.HEATING;
      } catch (err) {
        return Characteristic.CurrentHeaterCoolerState.IDLE;
      }
    });

    this.service
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .onSet(async (value) => {
        // Turning the device off is handled by the Active characteristic;
        // TargetHeaterCoolerState only selects the mode (mode 1 = auto).
        let mode = 1;
        if (value === Characteristic.TargetHeaterCoolerState.COOL) {
          mode = 2;
        } else if (value === Characteristic.TargetHeaterCoolerState.HEAT) {
          mode = 3;
        }
        await el.setPropertyValue(address, eoj, 0xb0, { mode });
      })
      .onGet(async () => {
        let state: CharacteristicValue = Characteristic.TargetHeaterCoolerState.AUTO;
        const { status } = requireData(await el.getPropertyValue(address, eoj, 0x80));
        if (status) {
          const { mode } = requireData(await el.getPropertyValue(address, eoj, 0xb0));
          if (mode === 2) {
            state = Characteristic.TargetHeaterCoolerState.COOL;
          } else if (mode === 3) {
            state = Characteristic.TargetHeaterCoolerState.HEAT;
          }
        }
        return state;
      });

    const temperatureSetter = (epc: number) => async (value: CharacteristicValue) => {
      await el.setPropertyValue(address, eoj, epc, { temperature: Math.trunc(value as number) });
    };
    const temperatureGetter = (epc: number) => async () => {
      try {
        const { temperature } = requireData(await el.getPropertyValue(address, eoj, epc));
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
      .onGet(temperatureGetter(0xbb));
    this.service
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
      .onSet(temperatureSetter(0xb5))
      .onGet(temperatureGetter(0xb5));
    this.service
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
      .onSet(temperatureSetter(0xb6))
      .onGet(temperatureGetter(0xb6));
  }
}
