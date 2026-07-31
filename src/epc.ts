// ECHONET Lite property codes (EPC). Each name describes the payload field
// node-echonet-lite decodes for that code, so the names stay checkable against
// the library rather than against a spec revision.

// Properties every device class implements.
export const SUPER_EPC = {
  OPERATION_STATUS: 0x80,
  IDENTIFICATION_NUMBER: 0x83,
} as const;

// Lighting (0x02/0x90, 0x02/0x91).
export const LIGHT_EPC = {
  ILLUMINANCE_LEVEL: 0xb0,
} as const;

// Home air conditioner (0x01/0x30).
export const AIRCON_EPC = {
  OPERATION_MODE: 0xb0,
  TARGET_COOLING_TEMPERATURE: 0xb5,
  TARGET_HEATING_TEMPERATURE: 0xb6,
  ROOM_TEMPERATURE: 0xbb,
  // Decoded by the library as `compressor`; not verified against the spec.
  COMPRESSOR_STATUS: 0xcd,
} as const;

// Values of AIRCON_EPC.OPERATION_MODE.
export const AIRCON_MODE = {
  AUTO: 1,
  COOL: 2,
  HEAT: 3,
} as const;
