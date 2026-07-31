// ECHONET Lite property codes (EPC), named after what the spec calls them.
// Turning these raw codes into usable values is the codec's job; see codec.ts.

// Properties every device class implements.
export const SUPER_EPC = {
  OPERATION_STATUS: 0x80,
  IDENTIFICATION_NUMBER: 0x83,
  INF_PROPERTY_MAP: 0x9d,
  SET_PROPERTY_MAP: 0x9e,
  GET_PROPERTY_MAP: 0x9f,
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
