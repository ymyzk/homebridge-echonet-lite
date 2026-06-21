module.exports = async (platform, accessory, el, address, eoj) => {
  const hap = platform.api.hap;
  const service = accessory.getService(hap.Service.HeaterCooler) || accessory.addService(hap.Service.HeaterCooler);

  service
    .getCharacteristic(hap.Characteristic.Active)
    .onSet(async (value) => {
      await el.setPropertyValue(address, eoj, 0x80, { status: value != 0 });
    })
    .onGet(async () => {
      const { status } = (await el.getPropertyValue(address, eoj, 0x80)).message.data;
      return status;
    });

  service.getCharacteristic(hap.Characteristic.CurrentHeaterCoolerState).onGet(async () => {
    try {
      const { status } = (await el.getPropertyValue(address, eoj, 0x80)).message.data;
      if (!status) {
        return hap.Characteristic.CurrentHeaterCoolerState.INACTIVE;
      }
      const { compressor } = (await el.getPropertyValue(address, eoj, 0xcd)).message.data;
      if (!compressor) {
        return hap.Characteristic.CurrentHeaterCoolerState.IDLE;
      }
      const { mode } = (await el.getPropertyValue(address, eoj, 0xb0)).message.data;
      return mode === 2
        ? hap.Characteristic.CurrentHeaterCoolerState.COOLING
        : hap.Characteristic.CurrentHeaterCoolerState.HEATING;
    } catch (err) {
      return hap.Characteristic.CurrentHeaterCoolerState.IDLE;
    }
  });

  service
    .getCharacteristic(hap.Characteristic.TargetHeaterCoolerState)
    .onSet(async (value) => {
      if (value !== hap.Characteristic.TargetHeaterCoolerState.OFF) {
        let mode = 1;
        if (value === hap.Characteristic.TargetHeaterCoolerState.COOL) mode = 2;
        else if (value === hap.Characteristic.TargetHeaterCoolerState.HEAT) mode = 3;
        await el.setPropertyValue(address, eoj, 0xb0, { mode });
      } else {
        await el.setPropertyValue(address, eoj, 0x80, { status: false });
      }
    })
    .onGet(async () => {
      let state = hap.Characteristic.TargetHeaterCoolerState.AUTO;
      const { status } = (await el.getPropertyValue(address, eoj, 0x80)).message.data;
      if (status) {
        const { mode } = (await el.getPropertyValue(address, eoj, 0xb0)).message.data;
        if (mode === 2) state = hap.Characteristic.TargetHeaterCoolerState.COOL;
        else if (mode === 3) state = hap.Characteristic.TargetHeaterCoolerState.HEAT;
      } else {
        state = hap.Characteristic.TargetHeaterCoolerState.OFF;
      }
      return state;
    });

  const temperatureSetter = (edt) => async (value) => {
    await el.setPropertyValue(address, eoj, edt, {
      temperature: parseInt(value),
    });
  };
  const temperatureGetter = (edt) => async () => {
    try {
      const { temperature } = (await el.getPropertyValue(address, eoj, edt)).message.data;
      return temperature;
    } catch (err) {
      // Some air conditioners do not have temperature sensor, reporting error
      // would make the accessory stop working.
      return 0;
    }
  };
  service
    .getCharacteristic(hap.Characteristic.CurrentTemperature)
    .setProps({ minValue: -127, maxValue: 125, minStep: 1 })
    .onGet(temperatureGetter(0xbb));
  service
    .getCharacteristic(hap.Characteristic.CoolingThresholdTemperature)
    .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
    .onSet(temperatureSetter(0xb5))
    .onGet(temperatureGetter(0xb5));
  service
    .getCharacteristic(hap.Characteristic.HeatingThresholdTemperature)
    .setProps({ minValue: 16, maxValue: 30, minStep: 1 })
    .onSet(temperatureSetter(0xb6))
    .onGet(temperatureGetter(0xb6));
};
