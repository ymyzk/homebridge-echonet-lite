module.exports = async (platform, accessory, el, address, eoj) => {
  const hap = platform.api.hap;
  const service = accessory.getService(hap.Service.Lightbulb) || accessory.addService(hap.Service.Lightbulb);
  const properties = (await el.getPropertyMaps(address, eoj)).message.data.set;
  const statusPropertyValue = await el.getPropertyValue(address, eoj, 0x80);
  platform.log.info(`Initializing a light accessory: ${accessory.UUID} ${address} ${eoj}`);
  if (statusPropertyValue == null || statusPropertyValue.message.data == null) {
    return;
  }
  let { status } = statusPropertyValue.message.data;

  const updateStatus = (s) => {
    platform.log.info(`Updating internal status: ${s}`);
    status = s;
    service.updateCharacteristic(hap.Characteristic.On, status);
  };

  updateStatus(status);

  let brightness = 0;

  const updateBrightness = (b) => {
    brightness = b;
    service.updateCharacteristic(hap.Characteristic.Brightness, brightness);
  };

  if (properties.includes(0xb0)) {
    const brightnessPropertyValue = await el.getPropertyValue(address, eoj, 0xb0);
    if (
      brightnessPropertyValue != null &&
      brightnessPropertyValue.message != null &&
      brightnessPropertyValue.message.data != null &&
      brightnessPropertyValue.message.data.level != null
    ) {
      brightness = brightnessPropertyValue.message.data.level;
      updateBrightness(brightness);
      console.log("Initialized brightness", accessory.UUID, brightness);
    }
  }

  service
    .getCharacteristic(hap.Characteristic.On)
    .on("set", (value, callback) => {
      if (status !== value) {
        platform.log.info(`Setting status ${value} for ${accessory.UUID} ${address} ${eoj}`);
        updateStatus(value);
        el.setPropertyValue(address, eoj, 0x80, { status });
      } else {
        platform.log.info(`Setting status no-op for ${accessory.UUID} ${address} ${eoj}`);
      }
      callback();
    })
    .on("get", (callback) => {
      callback(null, status);
      platform.log.info(`Getting status from ${accessory.UUID} ${address} ${eoj}`);
      el.getPropertyValue(address, eoj, 0x80).then((res) => {
        if (res != null && res.message.data != null) {
          const { status } = res.message.data;
          platform.log.info(`Status ${status}`);
          updateStatus(status);
        }
      });
    });

  if (properties.includes(0xb0)) {
    service
      .getCharacteristic(hap.Characteristic.Brightness)
      .on("set", async (value, callback) => {
        if (value !== brightness) {
          console.log("Setting brightness", accessory.UUID, value, address, eoj);
          updateBrightness(value);
          el.setPropertyValue(address, eoj, 0xb0, { level: value });
        } else {
          console.log("Setting brightness no-op", accessory.UUID, value, address, eoj);
        }
        callback();
      })
      .on("get", async (callback) => {
        callback(null, brightness);
        if (!status) {
          return;
        }

        console.log("Getting brightness", accessory.UUID, address, eoj);
        el.getPropertyValue(address, eoj, 0xb0).then((res) => {
          console.log("Got brightness", accessory.UUID, address, eoj);
          if (res != null && res.message.data != null && res.message.data.level != null) {
            updateBrightness(res.message.data.level);
          }
        });
      });
  }

  // Subscribe to status changes.
  el.on("notify", (res) => {
    const { seoj, prop } = res.message;
    if (res.device.address !== address || eoj[0] !== seoj[0] || eoj[1] !== seoj[1] || eoj[2] !== seoj[2]) {
      return;
    }
    platform.log.info("Received a notification from the device");

    for (const p of prop) {
      if (!p.edt) {
        continue;
      }
      if (p.epc === 0x80) {
        updateStatus(p.edt.status);
      } else if (p.epc === 0xb0) {
        updateBrightness(p.edt.level);
      }
    }
  });
};
