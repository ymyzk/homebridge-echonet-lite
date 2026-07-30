import type { PlatformAccessory } from "homebridge";

import type { ELAccessoryContext, EOJ } from "./types.js";

function isEOJ(value: unknown): value is EOJ {
  return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number");
}

// Accessory contexts are restored from JSON on disk, so validate them instead of
// trusting the declared type.
export function parseAccessoryContext(value: unknown): ELAccessoryContext | null {
  const { address, eoj } = (value ?? {}) as Partial<ELAccessoryContext>;
  return typeof address === "string" && address !== "" && isEOJ(eoj) ? { address, eoj } : null;
}

// Returns null when the accessory carries no usable device info, e.g. one cached
// before this data moved into the accessory context.
export function getAccessoryContext(accessory: PlatformAccessory): ELAccessoryContext | null {
  return parseAccessoryContext(accessory.context);
}

export function setAccessoryContext(accessory: PlatformAccessory, context: ELAccessoryContext): void {
  // Replace instead of merging: an accessory cached before contexts were used
  // deserializes with an undefined context, which cannot be assigned into.
  accessory.context = { ...context };
}
