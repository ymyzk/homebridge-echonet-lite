import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AirconOperationMode,
  IdentificationNumber,
  IlluminanceLevel,
  OperationStatus,
  RoomTemperature,
  TargetTemperature,
  expandPropertyMap,
} from "./codec.js";

const hex = (value: string) => Buffer.from(value, "hex");

describe("IdentificationNumber", () => {
  // The accessory UUID is derived from this string. These expectations encode
  // what node-echonet-lite produced, so a device keeps its HomeKit identity
  // across the migration. Do not adjust them to match an implementation.
  it("takes bytes 4..17 as upper-case hex", () => {
    // Captured from a live node profile object during the migration spike.
    const edt = hex("fe00007700000200000000000000000001");
    assert.equal(IdentificationNumber.decode(edt), "00000200000000000000000001");
  });

  it("excludes the protocol byte and the manufacturer code", () => {
    const edt = hex("fe0000ff" + "0102030405060708090a0b0c0d");
    assert.equal(IdentificationNumber.decode(edt), "0102030405060708090A0B0C0D");
  });

  it("clamps rather than throwing on a short EDT", () => {
    assert.equal(IdentificationNumber.decode(hex("fe000077aabb")), "AABB");
  });

  it("returns null when there is nothing past the manufacturer code", () => {
    assert.equal(IdentificationNumber.decode(hex("fe000077")), null);
  });
});

describe("OperationStatus", () => {
  it("decodes 0x30 as on and 0x31 as off", () => {
    assert.equal(OperationStatus.decode(hex("30")), true);
    assert.equal(OperationStatus.decode(hex("31")), false);
  });

  it("round-trips", () => {
    assert.equal(OperationStatus.decode(OperationStatus.encode(true)), true);
    assert.equal(OperationStatus.decode(OperationStatus.encode(false)), false);
  });

  it("returns null on an empty EDT", () => {
    assert.equal(OperationStatus.decode(hex("")), null);
  });
});

describe("IlluminanceLevel", () => {
  it("decodes the raw percentage", () => {
    assert.equal(IlluminanceLevel.decode(hex("00")), 0);
    assert.equal(IlluminanceLevel.decode(hex("64")), 100);
  });

  it("round-trips", () => {
    assert.equal(IlluminanceLevel.decode(IlluminanceLevel.encode(42)), 42);
  });
});

describe("AirconOperationMode", () => {
  // AIRCON_MODE counts from 1; the wire values are offset by 0x40.
  it("offsets the wire value by 0x40", () => {
    assert.equal(AirconOperationMode.decode(hex("41")), 1); // auto
    assert.equal(AirconOperationMode.decode(hex("42")), 2); // cooling
    assert.equal(AirconOperationMode.decode(hex("43")), 3); // heating
  });

  it("encodes back to the wire values", () => {
    assert.deepEqual(AirconOperationMode.encode(1), hex("41"));
    assert.deepEqual(AirconOperationMode.encode(2), hex("42"));
    assert.deepEqual(AirconOperationMode.encode(3), hex("43"));
  });
});

describe("temperatures", () => {
  // The target is unsigned and the room temperature is signed. Getting this
  // backwards silently reports -5 degrees as 251 or vice versa.
  it("decodes the target temperature as unsigned", () => {
    assert.equal(TargetTemperature.decode(hex("19")), 25);
    assert.equal(TargetTemperature.decode(hex("00")), 0);
  });

  it("decodes the room temperature as signed", () => {
    assert.equal(RoomTemperature.decode(hex("19")), 25);
    assert.equal(RoomTemperature.decode(hex("fb")), -5);
  });

  it("reports 0xFD as no reading for both", () => {
    assert.equal(TargetTemperature.decode(hex("fd")), null);
    // node-echonet-lite missed this one: it compared a signed byte against
    // 0xFD, so it reported -3 degrees instead of no reading.
    assert.equal(RoomTemperature.decode(hex("fd")), null);
  });

  it("reports an out-of-spec target temperature as-is rather than as no reading", () => {
    // Matching node-echonet-lite: the 0..50 range is a write-side constraint.
    assert.equal(TargetTemperature.decode(hex("40")), 64);
  });

  it("round-trips the target temperature", () => {
    assert.equal(TargetTemperature.decode(TargetTemperature.encode(28)), 28);
  });

  it("reports a multi-byte EDT as no reading", () => {
    assert.equal(TargetTemperature.decode(hex("1900")), null);
    assert.equal(RoomTemperature.decode(hex("1900")), null);
    assert.equal(OperationStatus.decode(hex("3000")), null);
  });
});

describe("expandPropertyMap", () => {
  // All three captured from a live node profile object during the spike.
  it("expands a form 1 map", () => {
    assert.deepEqual(expandPropertyMap(hex("0280d5")), [0x80, 0xd5]);
    assert.deepEqual(expandPropertyMap(hex("01bf")), [0xbf]);
  });

  it("expands a 15-property map", () => {
    assert.deepEqual(
      expandPropertyMap(hex("0f808283888a8b9d9e9fbfd3d4d5d6d7")),
      [0x80, 0x82, 0x83, 0x88, 0x8a, 0x8b, 0x9d, 0x9e, 0x9f, 0xbf, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7],
    );
  });

  it("handles a map with 16 or more properties, which arrives pre-normalized", () => {
    // echonet-lite's parseMapForm2 converts the bitmap form into this shape
    // before it reaches us, so it is the same count-then-list layout.
    const epcs = [0x80, 0x81, 0x82, 0x83, 0x88, 0x8a, 0x8b, 0x9d, 0x9e, 0x9f, 0xb0, 0xb3, 0xbb, 0xd3, 0xd4, 0xd5];
    const edt = Buffer.of(epcs.length, ...epcs);
    assert.deepEqual(expandPropertyMap(edt), epcs);
  });

  it("trusts the buffer over an inaccurate count byte", () => {
    assert.deepEqual(expandPropertyMap(hex("ff8081")), [0x80, 0x81]);
  });

  it("returns an empty list for an empty EDT", () => {
    assert.deepEqual(expandPropertyMap(hex("")), []);
  });
});
