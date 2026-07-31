import { describe, expect, it, vi } from "vitest";

import type { EchonetLiteClient } from "./client.js";
import type { Property } from "./codec.js";
import { OperationStatus, TargetTemperature } from "./codec.js";
import { EchonetDevice } from "./device.js";
import type { EOJ } from "./types.js";

const ADDRESS = "192.168.1.50";
const AIRCON: EOJ = [0x01, 0x30, 0x01];

// The client only reads and writes properties in groups, so it is stubbed down
// to those two methods. What each property decodes an EDT into is covered by
// codec.test.ts; what matters here is which properties are asked for and where
// their values end up.
function createDevice(values: (unknown | null)[] = []) {
  const getProperties = vi.fn(() => Promise.resolve(values));
  const setProperties = vi.fn(() => Promise.resolve());
  const client = { getProperties, setProperties } as unknown as EchonetLiteClient;
  return { device: new EchonetDevice(client, ADDRESS, AIRCON), getProperties, setProperties };
}

// The EPCs the stub was asked for, in order.
const requestedEpcs = (getProperties: ReturnType<typeof vi.fn>): number[] => {
  const [, , ...properties] = getProperties.mock.calls[0] as [string, EOJ, ...Property<unknown>[]];
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

  it("reads the three property maps in one request", async () => {
    const { device, getProperties } = createDevice([[0x80, 0xb0], [0xb3], [0x80, 0xb0, 0xbb]]);

    expect(await device.getPropertyMaps()).toEqual({
      inf: [0x80, 0xb0],
      set: [0xb3],
      get: [0x80, 0xb0, 0xbb],
    });

    expect(getProperties).toHaveBeenCalledTimes(1);
    expect(getProperties.mock.calls[0].slice(0, 2)).toEqual([ADDRESS, AIRCON]);
    // Inf, then set, then get, matching the order they are destructured in.
    expect(requestedEpcs(getProperties)).toEqual([0x9d, 0x9e, 0x9f]);
  });

  it("reports no properties for a map the device did not answer", async () => {
    const { device } = createDevice([null, [0xb3], null]);
    expect(await device.getPropertyMaps()).toEqual({ inf: [], set: [0xb3], get: [] });
  });
});
