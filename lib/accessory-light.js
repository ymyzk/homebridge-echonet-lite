module.exports = async (hap, accessory, el, address, eoj) => {
    const service = accessory.getService(hap.Service.Lightbulb) ||
    accessory.addService(hap.Service.Lightbulb)
    const properties = (await el.getPropertyMaps(address, eoj)).message.data.set
    const statusPropertyValue = await el.getPropertyValue(address, eoj, 0x80)
    console.log("Initializing", accessory.UUID)
    if (statusPropertyValue == null || statusPropertyValue.message.data == null) {
        return
    }
    let {status} = statusPropertyValue.message.data

    const updateStatus = (s) => {
        status = s
        service.updateCharacteristic(hap.Characteristic.On, status)
    }

    updateStatus(status)

    let brightness = 0

    const updateBrightness = (b) => {
        brightness = b
        service.updateCharacteristic(hap.Characteristic.Brightness, brightness)
    }

    if (properties.includes(0xB0)) {
        const brightnessPropertyValue = await el.getPropertyValue(address, eoj, 0xB0)
        if (brightnessPropertyValue != null &&
            brightnessPropertyValue.message != null &&
            brightnessPropertyValue.message.data != null &&
            brightnessPropertyValue.message.data.level != null) {
            brightness = brightnessPropertyValue.message.data.level
            updateBrightness(brightness)
            console.log("Initialized brightness", accessory.UUID, brightness)
        }
    }

    service.getCharacteristic(hap.Characteristic.On)
    .on('set', (value, callback) => {
        console.log("Setting status", accessory.UUID, value)
        status = value
        el.setPropertyValue(address, eoj, 0x80, {status})
        callback()
    })
    .on('get', (callback) => {
        callback(null, status)
        el.getPropertyValue(address, eoj, 0x80).then((res) => {
            //        console.log("Log2")
            //        console.log(res.message.data)
            if (res != null && res.message.data != null) {
                updateStatus(res.message.data.status)
            }
        })
    })

    if (properties.includes(0xB0)) {
        service.getCharacteristic(hap.Characteristic.Brightness)
        .on('set', async (value, callback) => {
            console.log("Setting brightness", accessory.UUID, value)
            el.setPropertyValue(address, eoj, 0xB0, {level: value})
            callback()
        })
        .on('get', async (callback) => {
            callback(null, brightness)
            if (!status) {
                return
            }

            console.log("Log5 - get brightness", accessory.UUID)
            el.getPropertyValue(address, eoj, 0xB0).then((res) => {
                console.log("Log6 - got brightness", accessory.UUID)
                if (res != null && res.message.data != null && res.message.data.level != null) {
                    updateBrightness(res.message.data.level)
                }
            })
        })
    }

    // Subscribe to status changes.
    el.on('notify', (res) => {
        const {seoj, prop} = res.message
        if (res.device.address !== address || eoj[0] !== seoj[0] || eoj[1] !== seoj[1] || eoj[2] !== seoj[2]) {
            return
        }

        for (const p of prop) {
            if (!p.edt) { continue }
            if (p.epc === 0x80) { updateStatus(p.edt.status) }
            else if (p.epc === 0xB0) { updateBrightness(p.edt.level) }
        }
    })
}
