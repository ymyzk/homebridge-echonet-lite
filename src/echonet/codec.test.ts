import { describe, expect, it } from "vitest";

import {
  AirconOperationMode,
  GetPropertyMap,
  IdentificationNumber,
  IlluminanceLevel,
  InfPropertyMap,
  OperationStatus,
  RoomTemperature,
  SetPropertyMap,
  TargetTemperature,
  expandPropertyMap,
  write,
} from "./codec.js";

const hex = (value: string) => Buffer.from(value, "hex");

describe("IdentificationNumber", () => {
  // The accessory UUID is derived from this string. These expectations encode
  // what node-echonet-lite produced, so a device keeps its HomeKit identity
  // across the migration. Do not adjust them to match an implementation.
  it("takes bytes 4..17 as upper-case hex", () => {
    // Captured from a live node profile object during the migration spike.
    const edt = hex("fe00007700000200000000000000000001");
    expect(IdentificationNumber.decode(edt)).toBe("00000200000000000000000001");
  });

  it("excludes the protocol byte and the manufacturer code", () => {
    const edt = hex("fe0000ff" + "0102030405060708090a0b0c0d");
    expect(IdentificationNumber.decode(edt)).toBe("0102030405060708090A0B0C0D");
  });

  it("clamps rather than throwing on a short EDT", () => {
    expect(IdentificationNumber.decode(hex("fe000077aabb"))).toBe("AABB");
  });

  it("returns null when there is nothing past the manufacturer code", () => {
    expect(IdentificationNumber.decode(hex("fe000077"))).toBeNull();
  });
});

describe("OperationStatus", () => {
  it("decodes 0x30 as on and 0x31 as off", () => {
    expect(OperationStatus.decode(hex("30"))).toBe(true);
    expect(OperationStatus.decode(hex("31"))).toBe(false);
  });

  it("round-trips", () => {
    expect(OperationStatus.decode(OperationStatus.encode(true))).toBe(true);
    expect(OperationStatus.decode(OperationStatus.encode(false))).toBe(false);
  });

  it("returns null on an empty EDT", () => {
    expect(OperationStatus.decode(hex(""))).toBeNull();
  });
});

describe("IlluminanceLevel", () => {
  it("decodes the raw percentage", () => {
    expect(IlluminanceLevel.decode(hex("00"))).toBe(0);
    expect(IlluminanceLevel.decode(hex("64"))).toBe(100);
  });

  it("round-trips", () => {
    expect(IlluminanceLevel.decode(IlluminanceLevel.encode(42))).toBe(42);
  });
});

describe("AirconOperationMode", () => {
  // AIRCON_MODE counts from 1; the wire values are offset by 0x40.
  it("offsets the wire value by 0x40", () => {
    expect(AirconOperationMode.decode(hex("41"))).toBe(1); // auto
    expect(AirconOperationMode.decode(hex("42"))).toBe(2); // cooling
    expect(AirconOperationMode.decode(hex("43"))).toBe(3); // heating
  });

  it("encodes back to the wire values", () => {
    expect(AirconOperationMode.encode(1)).toEqual(hex("41"));
    expect(AirconOperationMode.encode(2)).toEqual(hex("42"));
    expect(AirconOperationMode.encode(3)).toEqual(hex("43"));
  });
});

describe("temperatures", () => {
  // The target is unsigned and the room temperature is signed. Getting this
  // backwards silently reports -5 degrees as 251 or vice versa.
  it("decodes the target temperature as unsigned", () => {
    expect(TargetTemperature.decode(hex("19"))).toBe(25);
    expect(TargetTemperature.decode(hex("00"))).toBe(0);
  });

  it("decodes the room temperature as signed", () => {
    expect(RoomTemperature.decode(hex("19"))).toBe(25);
    expect(RoomTemperature.decode(hex("fb"))).toBe(-5);
  });

  it("reports 0xFD as no reading for both", () => {
    expect(TargetTemperature.decode(hex("fd"))).toBeNull();
    // node-echonet-lite missed this one: it compared a signed byte against
    // 0xFD, so it reported -3 degrees instead of no reading.
    expect(RoomTemperature.decode(hex("fd"))).toBeNull();
  });

  it("reports an out-of-spec target temperature as-is rather than as no reading", () => {
    // Matching node-echonet-lite: the 0..50 range is a write-side constraint.
    expect(TargetTemperature.decode(hex("40"))).toBe(64);
  });

  it("round-trips the target temperature", () => {
    expect(TargetTemperature.decode(TargetTemperature.encode(28))).toBe(28);
  });

  it("reports a multi-byte EDT as no reading", () => {
    expect(TargetTemperature.decode(hex("1900"))).toBeNull();
    expect(RoomTemperature.decode(hex("1900"))).toBeNull();
    expect(OperationStatus.decode(hex("3000"))).toBeNull();
  });
});

describe("write", () => {
  it("encodes the value against its property", () => {
    expect(write(TargetTemperature, 25)).toEqual({
      epc: TargetTemperature.epc,
      name: TargetTemperature.name,
      edt: hex("19"),
    });
    expect(write(OperationStatus, false).edt).toEqual(hex("31"));
  });
});

describe("expandPropertyMap", () => {
  // All three captured from a live node profile object during the spike.
  it("expands a form 1 map", () => {
    expect(expandPropertyMap(hex("0280d5"))).toEqual([0x80, 0xd5]);
    expect(expandPropertyMap(hex("01bf"))).toEqual([0xbf]);
  });

  it("expands a 15-property map", () => {
    expect(expandPropertyMap(hex("0f808283888a8b9d9e9fbfd3d4d5d6d7"))).toEqual([
      0x80, 0x82, 0x83, 0x88, 0x8a, 0x8b, 0x9d, 0x9e, 0x9f, 0xbf, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7,
    ]);
  });

  it("handles a map with 16 or more properties, which arrives pre-normalized", () => {
    // echonet-lite's parseMapForm2 converts the bitmap form into this shape
    // before it reaches us, so it is the same count-then-list layout.
    const epcs = [0x80, 0x81, 0x82, 0x83, 0x88, 0x8a, 0x8b, 0x9d, 0x9e, 0x9f, 0xb0, 0xb3, 0xbb, 0xd3, 0xd4, 0xd5];
    const edt = Buffer.of(epcs.length, ...epcs);
    expect(expandPropertyMap(edt)).toEqual(epcs);
  });

  it("trusts the buffer over an inaccurate count byte", () => {
    expect(expandPropertyMap(hex("ff8081"))).toEqual([0x80, 0x81]);
  });

  it("returns an empty list for an empty EDT", () => {
    expect(expandPropertyMap(hex(""))).toEqual([]);
  });
});

describe("property map properties", () => {
  it("reads each map from its own EPC", () => {
    expect(InfPropertyMap.epc).toBe(0x9d);
    expect(SetPropertyMap.epc).toBe(0x9e);
    expect(GetPropertyMap.epc).toBe(0x9f);
  });

  it("decodes an EDT into an EPC list", () => {
    expect(InfPropertyMap.decode(hex("0280b0"))).toEqual([0x80, 0xb0]);
    expect(SetPropertyMap.decode(hex("01b3"))).toEqual([0xb3]);
    expect(GetPropertyMap.decode(hex("0380b0bb"))).toEqual([0x80, 0xb0, 0xbb]);
  });
});
