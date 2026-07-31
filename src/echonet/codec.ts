import { AIRCON_EPC, LIGHT_EPC, SUPER_EPC } from "./epc.js";
import type { EPC } from "./types.js";

// Converts between an EPC's raw EDT bytes and a usable value. The transport
// deals only in buffers; every interpretation of those bytes lives here.
//
// Properties are addressed by object rather than by EPC number because an EPC
// is only meaningful together with its device class: 0xB0 is the illuminance
// level of a lighting object and the operation mode of an air conditioner.
export interface Property<T> {
  readonly epc: EPC;
  // A human-readable name, used in log messages.
  readonly name: string;
  // Returns null when the device answered with an EDT that carries no usable
  // value, which callers treat the same way as no answer at all.
  decode(edt: Buffer): T | null;
}

// A property this plugin also writes. Read-only properties deliberately have no
// `encode`, so a write to one does not compile.
export interface WritableProperty<T> extends Property<T> {
  encode(value: T): Buffer;
}

// A property paired with the value to write to it, already encoded. Writing
// several properties at once means carrying values of different types together,
// which no single `T` can describe; `write` below checks the value against its
// property while `T` is still known and hands back this erased form.
export interface PropertyWrite {
  readonly epc: EPC;
  // A human-readable name, used in log messages.
  readonly name: string;
  readonly edt: Buffer;
}

export function write<T>(property: WritableProperty<T>, value: T): PropertyWrite {
  return { epc: property.epc, name: property.name, edt: property.encode(value) };
}

// 0x80. ON is 0x30 and OFF is 0x31 — note that the higher byte is the "off"
// one, which is the opposite of what the numbers suggest.
export const OperationStatus: WritableProperty<boolean> = {
  epc: SUPER_EPC.OPERATION_STATUS,
  name: "operation status",
  decode(edt) {
    if (edt.length !== 1) {
      return null;
    }
    return edt.readUInt8(0) === 0x30;
  },
  encode(value) {
    return Buffer.of(value ? 0x30 : 0x31);
  },
};

// 0x82, four unsigned chars. Bytes 1-2 are unused; byte 3 carries the release
// order as an ASCII letter ('A' = 0x41 … 'P' = 0x50) and byte 4 the revision.
// The node profile object reuses this EPC for a different layout (major.minor
// plus message format type), but only device objects are probed here.
export interface StandardVersion {
  // Release order as the spec writes it, e.g. "P".
  release: string;
  revision: number;
}

export const StandardVersionInformation: Property<StandardVersion> = {
  epc: SUPER_EPC.STANDARD_VERSION_INFORMATION,
  name: "standard version information",
  decode(edt) {
    if (edt.length !== 4) {
      return null;
    }
    return { release: String.fromCharCode(edt.readUInt8(2)), revision: edt.readUInt8(3) };
  },
};

// 0x83. The HomeKit accessory UUID is derived from this, so the string must
// keep the exact shape node-echonet-lite produced: bytes 4..17 of the EDT, hex,
// upper case. Byte 0 (lower-layer communication ID) and bytes 1-3 (manufacturer
// code) are deliberately excluded.
//
// Changing this formula re-creates every user's accessories and loses their
// room assignments, names and automations. See codec.test.ts.
export const IdentificationNumber: Property<string> = {
  epc: SUPER_EPC.IDENTIFICATION_NUMBER,
  name: "identification number",
  decode(edt) {
    // `subarray` clamps instead of throwing, matching the `Buffer.slice` the
    // old parser used on devices that answer with a shorter EDT.
    const uid = edt.subarray(4, 17);
    if (uid.length === 0) {
      return null;
    }
    return uid.toString("hex").toUpperCase();
  },
};

// 0x8A, three unsigned chars: the code the ECHONET Consortium assigned to the
// manufacturer, e.g. 0x00000B. Kept as the number the spec writes in hex, so
// comparing against a code is `=== 0x00000b`; use `toHex(code, 6)` to log it.
// The same three bytes appear at bytes 1-3 of the identification number above,
// which deliberately excludes them.
export const ManufacturerCode: Property<number> = {
  epc: SUPER_EPC.MANUFACTURER_CODE,
  name: "manufacturer code",
  decode(edt) {
    if (edt.length !== 3) {
      return null;
    }
    return edt.readUIntBE(0, 3);
  },
};

// 0x8C, twelve unsigned chars holding ASCII. The spec fixes the length and has
// devices pad what they do not use, so the padding is stripped here rather than
// left for callers; a device with nothing to report pads the whole field, which
// is no value at all.
export const ProductCode: Property<string> = {
  epc: SUPER_EPC.PRODUCT_CODE,
  name: "product code",
  decode(edt) {
    if (edt.length !== 12) {
      return null;
    }
    // Devices pad with 0x00 or with spaces; either way the padding is not
    // part of the code.
    const end = edt.indexOf(0);
    const code = (end === -1 ? edt : edt.subarray(0, end)).toString("ascii").trim();
    return code === "" ? null : code;
  },
};

// 0xB0 of a lighting object (0x02/0x90 and 0x02/0x91), as a percentage.
export const IlluminanceLevel: WritableProperty<number> = {
  epc: LIGHT_EPC.ILLUMINANCE_LEVEL,
  name: "illuminance level",
  decode(edt) {
    if (edt.length < 1) {
      return null;
    }
    return edt.readUInt8(0);
  },
  encode(value) {
    return Buffer.of(value);
  },
};

// 0xB0 of an air conditioner (0x01/0x30). The wire values are offset by 0x40
// (0x41 auto, 0x42 cooling, 0x43 heating), which is why AIRCON_MODE counts from
// 1 rather than using the raw bytes.
export const AirconOperationMode: WritableProperty<number> = {
  epc: AIRCON_EPC.OPERATION_MODE,
  name: "operation mode",
  decode(edt) {
    if (edt.length !== 1) {
      return null;
    }
    return edt.readUInt8(0) - 0x40;
  },
  encode(value) {
    return Buffer.of(value + 0x40);
  },
};

// The value both temperature properties use to mean "no reading available".
const TEMPERATURE_UNDEFINED = 0xfd;

// 0xB3, in degrees Celsius. Unsigned. The 0..50 range the spec allows is only
// enforced on write: a device reporting outside it is still reported as-is,
// which is what node-echonet-lite did.
export const TargetTemperature: WritableProperty<number> = {
  epc: AIRCON_EPC.TARGET_TEMPERATURE,
  name: "target temperature",
  decode(edt) {
    if (edt.length !== 1) {
      return null;
    }
    const value = edt.readUInt8(0);
    return value === TEMPERATURE_UNDEFINED ? null : value;
  },
  encode(value) {
    return Buffer.of(value);
  },
};

// 0xBB, in degrees Celsius. Signed, unlike the target temperature above.
//
// The "no reading" marker is checked against the raw byte rather than the
// decoded value. node-echonet-lite compared its `readInt8` result against 0xFD
// (01-30-BB.js:55), which a signed byte can never equal, so an air conditioner
// without a temperature sensor was reported as -3 °C instead of as having no
// reading. That is fixed here.
export const RoomTemperature: Property<number> = {
  epc: AIRCON_EPC.ROOM_TEMPERATURE,
  name: "room temperature",
  decode(edt) {
    if (edt.length !== 1) {
      return null;
    }
    if (edt.readUInt8(0) === TEMPERATURE_UNDEFINED) {
      return null;
    }
    return edt.readInt8(0);
  },
};

// Property maps (0x9D, 0x9E, 0x9F) arrive as a count byte followed by that many
// EPC bytes. The spec's second form — a 16-byte bitmap, used once a device has
// 16 or more properties — is normalized into this same shape by echonet-lite's
// parseMapForm2 before it reaches us, so only one form has to be handled here.
export function expandPropertyMap(edt: Buffer): EPC[] {
  if (edt.length < 1) {
    return [];
  }
  // Trust the buffer over the count byte: some devices report it inaccurately.
  const count = Math.min(edt.readUInt8(0), edt.length - 1);
  return [...edt.subarray(1, 1 + count)];
}

// The three maps are read together, so they are declared as ordinary properties
// rather than handled specially by the client.
const propertyMap = (epc: EPC, name: string): Property<EPC[]> => ({
  epc,
  name,
  decode: expandPropertyMap,
});

export const InfPropertyMap = propertyMap(SUPER_EPC.INF_PROPERTY_MAP, "INF property map");
export const SetPropertyMap = propertyMap(SUPER_EPC.SET_PROPERTY_MAP, "Set property map");
export const GetPropertyMap = propertyMap(SUPER_EPC.GET_PROPERTY_MAP, "Get property map");
