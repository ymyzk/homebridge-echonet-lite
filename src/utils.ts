import type { EOJ } from "./types.js";

// ECHONET Lite identifiers (class codes, instance codes, EPCs) are defined in
// hex by the spec, so log them the same way instead of as decimal numbers.
export function toHex(value: number, width = 2): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

// Packs the class group code, class code, and instance code into the single
// hex value used on the wire, e.g. [0x01, 0x30, 0x01] -> "0x013001".
export function formatEOJ(eoj: EOJ): string {
  return toHex((eoj[0] << 16) | (eoj[1] << 8) | eoj[2], 6);
}

// The uuid/address/EOJ triple that identifies a device in log messages.
export function formatDeviceId(uuid: string, address: string, eoj: EOJ): string {
  return `${uuid} ${address} ${formatEOJ(eoj)}`;
}
