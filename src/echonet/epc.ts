// ECHONET Lite property codes (EPC), named after what the spec calls them.
// Turning these raw codes into usable values is the codec's job; see codec.ts.

// Properties every device class implements. "Required" and "optional" are the
// device object super class's own terms: a device must answer for a required
// property, while an optional one may be absent from its Get property map —
// which is why the identification number read in platform.ts has a fallback.
export const SUPER_EPC = {
  // Required
  STANDARD_VERSION_INFORMATION: 0x82,
  MANUFACTURER_CODE: 0x8a,
  INF_PROPERTY_MAP: 0x9d,
  SET_PROPERTY_MAP: 0x9e,
  GET_PROPERTY_MAP: 0x9f,
  // Optional
  // The super class leaves 0x80 to the device class, and both classes this
  // plugin supports — lighting and home air conditioner — require it.
  OPERATION_STATUS: 0x80,
  IDENTIFICATION_NUMBER: 0x83,
  PRODUCT_CODE: 0x8c,
} as const;

// Lighting (0x02/0x90, 0x02/0x91).
export const LIGHT_EPC = {
  ILLUMINANCE_LEVEL: 0xb0,
} as const;

// Home air conditioner (0x01/0x30).
export const AIRCON_EPC = {
  // Required
  AIR_FLOW_RATE: 0xa0,
  OPERATION_MODE: 0xb0,
  TARGET_TEMPERATURE: 0xb3,
  ROOM_TEMPERATURE: 0xbb,
  // Optional
  TARGET_COOLING_TEMPERATURE: 0xb5,
  TARGET_HEATING_TEMPERATURE: 0xb6,
} as const;

// Values of AIRCON_EPC.OPERATION_MODE.
export const AIRCON_MODE = {
  AUTO: 1,
  COOL: 2,
  HEAT: 3,
} as const;
