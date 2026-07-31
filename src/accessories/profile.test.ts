import { describe, expect, it } from "vitest";

import { IlluminanceLevel, OperationStatus, RoomTemperature, TargetTemperature } from "../echonet/codec.js";
import type { PropertyMaps } from "../echonet/device.js";
import { supportsGet, supportsNotify, supportsSet } from "./profile.js";

// A dimmable light that announces changes to its power state but not to its
// brightness, and reports its brightness as write-only.
const MAPS: PropertyMaps = {
  inf: [OperationStatus.epc],
  set: [OperationStatus.epc, IlluminanceLevel.epc],
  get: [OperationStatus.epc],
};

describe("property map support", () => {
  it("reads each map independently", () => {
    expect(supportsSet(MAPS, IlluminanceLevel)).toBe(true);
    expect(supportsGet(MAPS, IlluminanceLevel)).toBe(false);
    expect(supportsNotify(MAPS, IlluminanceLevel)).toBe(false);

    expect(supportsSet(MAPS, OperationStatus)).toBe(true);
    expect(supportsGet(MAPS, OperationStatus)).toBe(true);
    expect(supportsNotify(MAPS, OperationStatus)).toBe(true);
  });

  it("reports a property the device does not list as unsupported", () => {
    expect(supportsGet(MAPS, RoomTemperature)).toBe(false);
    expect(supportsSet(MAPS, TargetTemperature)).toBe(false);
  });

  it("reports nothing supported for a device that answered with no maps", () => {
    const empty: PropertyMaps = { inf: [], set: [], get: [] };
    expect(supportsGet(empty, OperationStatus)).toBe(false);
    expect(supportsSet(empty, OperationStatus)).toBe(false);
    expect(supportsNotify(empty, OperationStatus)).toBe(false);
  });
});
