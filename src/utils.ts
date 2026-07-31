import type { EOJ } from "./types.js";

// ECHONET Lite identifiers (class codes, instance codes, EPCs) are defined in
// hex by the spec, so log them the same way instead of as decimal numbers.
export function toHex(value: number, width = 2): string {
  return `0x${value.toString(16).padStart(width, "0")}`;
}

// A property map (a list of EPCs) rendered as hex for logging, e.g. "[0x80, 0xb0]".
export function formatProperties(properties: number[] | undefined): string {
  return `[${(properties ?? []).map((epc) => toHex(epc)).join(", ")}]`;
}

// Packs the class group code, class code, and instance code into the single
// hex value used on the wire, e.g. [0x01, 0x30, 0x01] -> "0x013001".
export function formatEOJ(eoj: EOJ): string {
  return toHex((eoj[0] << 16) | (eoj[1] << 8) | eoj[2], 6);
}

// The address/EOJ pair that identifies a device on the network, used in log
// messages before the device is bound to a HomeKit accessory.
export function formatDeviceRef(address: string, eoj: EOJ): string {
  return `${address} ${formatEOJ(eoj)}`;
}

// The uuid/address/EOJ triple that identifies a device in log messages.
export function formatDeviceId(uuid: string, address: string, eoj: EOJ): string {
  return `${uuid} ${formatDeviceRef(address, eoj)}`;
}

// Notification payloads carry the source EOJ as a plain number array.
export function eojEquals(eoj: EOJ, other: number[]): boolean {
  return eoj.length === other.length && eoj.every((value, i) => value === other[i]);
}
