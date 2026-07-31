import { afterEach, describe, expect, it, vi } from "vitest";

import { AirconOperationMode, OperationStatus, RoomTemperature, TargetTemperature } from "../echonet/codec.js";
import type { PropertyMaps } from "../echonet/device.js";
import { AIRCON_MODE } from "../echonet/epc.js";
import {
  Characteristic,
  createAccessory,
  createDevice,
  createPlatform,
  NO_DEVICE_INFO,
  read,
} from "./accessory.test-helpers.js";
import { AirConditionerAccessory } from "./aircon.js";
import { CACHE_TTL_MS } from "./device-state.js";

const ALL_PROPERTIES = [OperationStatus.epc, AirconOperationMode.epc, RoomTemperature.epc, TargetTemperature.epc];

const maps = (overrides: Partial<PropertyMaps> = {}): PropertyMaps => ({
  inf: [],
  set: [OperationStatus.epc, AirconOperationMode.epc, TargetTemperature.epc],
  get: ALL_PROPERTIES,
  ...overrides,
});

function createAircon() {
  const platform = createPlatform();
  const accessory = createAccessory();
  const { device, getMany, set, notify } = createDevice();
  const handler = AirConditionerAccessory.create(platform, accessory, device);
  const service = accessory.getService(platform.Service.HeaterCooler);
  if (!service) {
    throw new Error("the accessory should have added a HeaterCooler");
  }
  // Cooling, 22 °C in the room, set to 25 °C.
  getMany.mockResolvedValue([true, AIRCON_MODE.COOL, 22, 25]);
  return { handler, service, getMany, set, notify };
}

describe("AirConditionerAccessory", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers every characteristic from one request", async () => {
    const { handler, service, getMany } = createAircon();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });

    const values = await Promise.all([
      read(service, Characteristic.Active),
      read(service, Characteristic.CurrentHeaterCoolerState),
      read(service, Characteristic.TargetHeaterCoolerState),
      read(service, Characteristic.CurrentTemperature),
      read(service, Characteristic.CoolingThresholdTemperature),
      read(service, Characteristic.HeatingThresholdTemperature),
    ]);

    // Six characteristics used to cost eight separate requests to one device,
    // fired at once, which is what a busy air conditioner answers with a Get_SNA.
    expect(getMany).toHaveBeenCalledTimes(1);
    expect(values).toEqual([
      Characteristic.Active.ACTIVE,
      Characteristic.CurrentHeaterCoolerState.COOLING,
      Characteristic.TargetHeaterCoolerState.COOL,
      22,
      25,
      25,
    ]);
  });

  it("asks only for the properties the device reports", async () => {
    const { handler, service, getMany } = createAircon();
    getMany.mockResolvedValue([true]);

    handler.applyProfile({ maps: maps({ get: [OperationStatus.epc] }), info: NO_DEVICE_INFO });
    await read(service, Characteristic.Active);

    const [...properties] = getMany.mock.calls[0];
    expect(properties).toEqual([OperationStatus]);
  });

  it("reports the last known state when the device is busy, not that it is off", async () => {
    // The reported bug: a busy device answers a Get_SNA with nothing in it, and
    // the accessory showed a running air conditioner as switched off.
    vi.useFakeTimers();
    const { handler, service, getMany } = createAircon();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    await read(service, Characteristic.Active);

    getMany.mockRejectedValue(new Error("Device answered no part of a get"));
    // Past the cache lifetime, so the failing read really is attempted.
    vi.advanceTimersByTime(CACHE_TTL_MS);

    expect(await read(service, Characteristic.Active)).toBe(Characteristic.Active.ACTIVE);
    expect(await read(service, Characteristic.CurrentHeaterCoolerState)).toBe(
      Characteristic.CurrentHeaterCoolerState.COOLING,
    );
    // The first read, then one per getter above: a failed read is not cached,
    // so each of them reaches the device rather than waiting the failure out.
    expect(getMany).toHaveBeenCalledTimes(3);
  });

  it("reports a device that has never answered as inactive rather than failing", async () => {
    const { handler, service, getMany } = createAircon();
    getMany.mockRejectedValue(new Error("no answer"));
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });

    // A rejection here reaches HAP and marks the accessory as not responding.
    expect(await read(service, Characteristic.Active)).toBe(Characteristic.Active.INACTIVE);
    expect(await read(service, Characteristic.CurrentHeaterCoolerState)).toBe(
      Characteristic.CurrentHeaterCoolerState.INACTIVE,
    );
    expect(await read(service, Characteristic.CurrentTemperature)).toBe(0);
  });

  it("writes the operation status when HomeKit turns it on", async () => {
    const { handler, service, set } = createAircon();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });

    await service.getCharacteristic(Characteristic.Active).handleSetRequest(1);

    expect(set).toHaveBeenCalledWith(OperationStatus, true);
    // Answered from the cache the write updated, without a round trip.
    expect(await read(service, Characteristic.Active)).toBe(Characteristic.Active.ACTIVE);
  });

  it("maps both threshold temperatures onto the one target temperature", async () => {
    const { handler, service, set } = createAircon();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });

    await service.getCharacteristic(Characteristic.HeatingThresholdTemperature).handleSetRequest(24);

    expect(set).toHaveBeenCalledWith(TargetTemperature, 24);
    // HomeKit has a cooling and a heating setpoint; ECHONET Lite has 0xB3.
    expect(await read(service, Characteristic.CoolingThresholdTemperature)).toBe(24);
  });

  it("adds and removes the threshold temperatures as the device reports them", async () => {
    const { handler, service } = createAircon();

    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    expect(service.testCharacteristic(Characteristic.CoolingThresholdTemperature)).toBe(true);

    handler.applyProfile({ maps: maps({ set: [OperationStatus.epc] }), info: NO_DEVICE_INFO });
    expect(service.testCharacteristic(Characteristic.CoolingThresholdTemperature)).toBe(false);

    // Idempotent: a refresh scan calls this again for every device it sees.
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    expect(service.testCharacteristic(Characteristic.CoolingThresholdTemperature)).toBe(true);
  });

  it("takes a change the device announced without being asked", async () => {
    // An air conditioner turned off by its remote. This is new: the accessory
    // never subscribed to notifications before.
    const { handler, service, notify } = createAircon();
    handler.applyProfile({ maps: maps(), info: NO_DEVICE_INFO });
    await read(service, Characteristic.Active);

    notify([[OperationStatus.epc, Buffer.of(0x31)]]);

    expect(service.getCharacteristic(Characteristic.Active).value).toBe(Characteristic.Active.INACTIVE);
    expect(service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value).toBe(
      Characteristic.CurrentHeaterCoolerState.INACTIVE,
    );
  });
});
