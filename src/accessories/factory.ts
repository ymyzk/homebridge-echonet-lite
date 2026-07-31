import type { PlatformAccessory } from "homebridge";

import type { EchonetDevice } from "../echonet/device.js";
import type { EOJ } from "../echonet/types.js";
import type { ELPlatform } from "../platform.js";
import { AirConditionerAccessory } from "./aircon.js";
import { LightAccessory } from "./light.js";

// The ECHONET Lite classes this plugin can expose to HomeKit, keyed by class
// group code and class code, with the name a new accessory is registered under.
//
// echonet-lite carries no class dictionary, so this doubles as the check for
// whether a discovered device is worth probing at all. That is narrower than
// the old "does the library know this class" test, which let through devices
// that were then dropped for having no handler.
const SUPPORTED_CLASSES = new Map<string, string>([
  ["02:90", "General Lighting"],
  ["02:91", "Mono Functional Lighting"],
  ["01:30", "Home Air Conditioner"],
]);

function classKey(eoj: EOJ): string {
  return `${eoj[0].toString(16).padStart(2, "0")}:${eoj[1].toString(16).padStart(2, "0")}`;
}

// Whether a handler exists for this device's class.
export function isSupportedEOJ(eoj: EOJ): boolean {
  return SUPPORTED_CLASSES.has(classKey(eoj));
}

// The name a newly registered accessory gets. Users can rename it afterwards in
// the Home app, so this only has to be recognizable.
export function getClassName(eoj: EOJ): string | null {
  return SUPPORTED_CLASSES.get(classKey(eoj)) ?? null;
}

// Builds the handler matching the device's ECHONET Lite class code.
// Returns false when the device is unsupported, and rejects when it does not
// answer the reads a handler needs to wire itself up.
export async function createAccessoryHandler(
  platform: ELPlatform,
  accessory: PlatformAccessory,
  device: EchonetDevice,
): Promise<boolean> {
  const [classGroupCode, classCode] = device.eoj;
  if (classGroupCode === 0x02 && (classCode === 0x90 || classCode === 0x91)) {
    await LightAccessory.create(platform, accessory, device);
    return true;
  }
  if (classGroupCode === 0x01 && classCode === 0x30) {
    AirConditionerAccessory.create(platform, accessory, device);
    return true;
  }
  return false;
}
