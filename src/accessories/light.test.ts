import { describe, expect, it } from "vitest";

import { IlluminanceLevel, OperationStatus } from "../echonet/codec.js";
import type { PropertyMaps } from "../echonet/device.js";
import {
  Characteristic,
  createAccessory,
  createDevice,
  createPlatform,
  NO_DEVICE_INFO,
  read,
} from "./accessory.test-helpers.js";
import { LightAccessory } from "./light.js";

const maps = (overrides: Partial<PropertyMaps> = {}): PropertyMaps => ({
  inf: [],
  set: [OperationStatus.epc, IlluminanceLevel.epc],
  get: [OperationStatus.epc, IlluminanceLevel.epc],
  ...overrides,
});

function createLight() {
  const platform = createPlatform();
  const accessory = createAccessory();
  const { device, getMany, set, notify } = createDevice();
  const handler = LightAccessory.create(platform, accessory, device);
  const service = accessory.getService(platform.Service.Lightbulb);
  if (!service) {
    throw new Error("the accessory should have added a Lightbulb");
  }
  getMany.mockResolvedValue([true, 60]);
  return { handler, service, getMany, set, notify };
}

describe("LightAccessory", () => {
  it("answers both characteristics from one request", async () => {
    const { handler, service, getMany } = createLight();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });

    const values = await Promise.all([read(service, Characteristic.On), read(service, Characteristic.Brightness)]);

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(values).toEqual([true, 60]);
  });

  it("asks only for the properties the device reports", async () => {
    const { handler, service, getMany } = createLight();
    getMany.mockResolvedValue([true]);

    handler.applyProfile({ maps: maps({ get: [OperationStatus.epc] }), info: NO_DEVICE_INFO });
    await read(service, Characteristic.On);

    const [...properties] = getMany.mock.calls[0];
    expect(properties).toEqual([OperationStatus]);
  });

  it("reports the last known state rather than failing when the device does not answer", async () => {
    const { handler, service, getMany } = createLight();
    getMany.mockRejectedValue(new Error("no answer"));
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });

    expect(await read(service, Characteristic.On)).toBe(false);
  });

  it("updates the cache before the write goes out", async () => {
    const { handler, service, set } = createLight();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });

    await service.getCharacteristic(Characteristic.On).handleSetRequest(true);

    expect(set).toHaveBeenCalledWith(OperationStatus, true);
    expect(await read(service, Characteristic.On)).toBe(true);
  });

  it("drops a repeated brightness rather than queueing another write", async () => {
    // Dragging the slider sends a write per step, and writes to one device run
    // one at a time.
    const { handler, service, set } = createLight();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });

    await service.getCharacteristic(Characteristic.Brightness).handleSetRequest(40);
    await service.getCharacteristic(Characteristic.Brightness).handleSetRequest(40);

    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(IlluminanceLevel, 40);
  });

  it("adds and removes Brightness as the device reports it", () => {
    const { handler, service } = createLight();

    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(true);

    handler.applyProfile({ maps: maps({ set: [OperationStatus.epc] }), info: NO_DEVICE_INFO });
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(false);

    // Idempotent: a refresh scan calls this again for every device it sees.
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(true);
  });

  it("takes a change the device announced without being asked", async () => {
    const { handler, service, notify } = createLight();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    await read(service, Characteristic.On);

    notify([
      [OperationStatus.epc, Buffer.of(0x31)],
      [IlluminanceLevel.epc, Buffer.of(20)],
    ]);

    expect(service.getCharacteristic(Characteristic.On).value).toBe(false);
    expect(service.getCharacteristic(Characteristic.Brightness).value).toBe(20);
  });

  it("does not push a brightness HomeKit was never told about", async () => {
    // A light that reports no settable brightness has no Brightness to update.
    const { handler, service, notify } = createLight();
    handler.applyProfile({ maps: maps({ set: [OperationStatus.epc] }), info: NO_DEVICE_INFO });

    notify([[IlluminanceLevel.epc, Buffer.of(20)]]);

    expect(service.testCharacteristic(Characteristic.Brightness)).toBe(false);
  });
});
