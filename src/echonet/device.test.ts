import { describe, expect, it, vi } from "vitest";

import type { EchonetLiteClient } from "./client.js";
import type { Property } from "./codec.js";
import { OperationStatus, TargetTemperature } from "./codec.js";
import { EchonetDevice } from "./device.js";
import type { EOJ, EPC } from "./types.js";

const ADDRESS = "192.168.1.50";
const AIRCON: EOJ = [0x01, 0x30, 0x01];

// The client only reads and writes properties in groups, so it is stubbed down
// to those two methods. What each property decodes an EDT into is covered by
// codec.test.ts; what matters here is which properties are asked for and where
// their values end up.
// `reads` holds the values to answer with, one entry per expected call, for the
// reads that take more than one round trip. A call past the end of it is
// answered with nothing.
function createDeviceReads(reads: (unknown | null)[][]) {
  let call = 0;
  const getProperties = vi.fn(() => Promise.resolve(reads[call++] ?? []));
  const setProperties = vi.fn(() => Promise.resolve());
  const client = { getProperties, setProperties } as unknown as EchonetLiteClient;
  return { device: new EchonetDevice(client, ADDRESS, AIRCON), getProperties, setProperties };
}

function createDevice(values: (unknown | null)[] = []) {
  return createDeviceReads([values]);
}

// The EPCs the stub was asked for by the nth call, in order.
const requestedEpcs = (getProperties: ReturnType<typeof vi.fn>, call = 0): EPC[] => {
  const [, , ...properties] = getProperties.mock.calls[call] as [string, EOJ, ...Property<unknown>[]];
  return properties.map((property) => property.epc);
};

describe("EchonetDevice", () => {
  it("unwraps a single-property read", async () => {
    const { device, getProperties } = createDevice([true]);

    expect(await device.get(OperationStatus)).toBe(true);
    expect(getProperties.mock.calls[0]).toEqual([ADDRESS, AIRCON, OperationStatus]);
  });

  it("passes on a null from a single-property read", async () => {
    const { device } = createDevice([null]);
    expect(await device.get(TargetTemperature)).toBeNull();
  });

  it("encodes a single-property write", async () => {
    const { device, setProperties } = createDevice();

    await device.set(TargetTemperature, 25);
    expect(setProperties.mock.calls[0]).toEqual([
      ADDRESS,
      AIRCON,
      { epc: TargetTemperature.epc, name: TargetTemperature.name, edt: Buffer.of(25) },
    ]);
  });

  it("reads the maps, then the device info the Get map lists", async () => {
    const { device, getProperties } = createDeviceReads([
      // The maps, which say every device info property can be read.
      [[0x80, 0xb0], [0xb3], [0x80, 0x82, 0x83, 0x8a, 0x8c, 0xb0, 0xbb]],
      // The device info that follows from them.
      [{ release: "P", revision: 1 }, 0x00000b, "AC-1234", "FE00000B0102030405060708090A"],
    ]);

    expect(await device.getProfile()).toEqual({
      maps: {
        inf: [0x80, 0xb0],
        set: [0xb3],
        get: [0x80, 0x82, 0x83, 0x8a, 0x8c, 0xb0, 0xbb],
      },
      info: {
        standardVersion: { release: "P", revision: 1 },
        manufacturerCode: 0x00000b,
        productCode: "AC-1234",
        identificationNumber: "FE00000B0102030405060708090A",
      },
    });

    expect(getProperties).toHaveBeenCalledTimes(2);
    expect(getProperties.mock.calls[0].slice(0, 2)).toEqual([ADDRESS, AIRCON]);
    // Inf, then set, then get, matching the order they are destructured in.
    expect(requestedEpcs(getProperties, 0)).toEqual([0x9d, 0x9e, 0x9f]);
    expect(requestedEpcs(getProperties, 1)).toEqual([0x82, 0x8a, 0x8c, 0x83]);
  });

  it("does not ask for device info the Get map leaves out", async () => {
    // A device carrying only the two info properties the super class requires.
    const { device, getProperties } = createDeviceReads([
      [[], [], [0x82, 0x8a]],
      [{ release: "P", revision: 1 }, 0x00000b],
    ]);

    expect((await device.getProfile()).info).toEqual({
      standardVersion: { release: "P", revision: 1 },
      manufacturerCode: 0x00000b,
      productCode: null,
      identificationNumber: null,
    });
    expect(requestedEpcs(getProperties, 1)).toEqual([0x82, 0x8a]);
  });

  it("reports no properties for a map the device did not answer", async () => {
    const { device, getProperties } = createDeviceReads([[null, [0xb3], null]]);

    expect(await device.getProfile()).toEqual({
      maps: { inf: [], set: [0xb3], get: [] },
      info: { standardVersion: null, manufacturerCode: null, productCode: null, identificationNumber: null },
    });
    // An empty Get map leaves no info property to ask for. The client answers a
    // request with no properties without putting anything on the wire.
    expect(requestedEpcs(getProperties, 1)).toEqual([]);
  });
});
