import type { PlatformAccessory } from "homebridge";

import type { EchonetDevice } from "../echonet/device.js";
import type { EOJ } from "../echonet/types.js";
import type { ELPlatform } from "../platform.js";
import { AirConditionerAccessory } from "./aircon.js";
import { LightAccessory } from "./light.js";
import type { AccessoryHandler, ProfileAware } from "./profile.js";
import { ProfileLoader } from "./profile.js";

interface SupportedClass {
  // The name a newly registered accessory gets. Users can rename it afterwards
  // in the Home app, so this only has to be recognizable. It doubles as the
  // model shown for a device that carries no product code.
  readonly name: string;
  readonly create: (platform: ELPlatform, accessory: PlatformAccessory, device: EchonetDevice) => ProfileAware;
}

// The ECHONET Lite classes this plugin can expose to HomeKit, keyed by class
// group code and class code.
//
// echonet-lite carries no class dictionary, so this doubles as the check for
// whether a discovered device is worth probing at all. That is narrower than
// the old "does the library know this class" test, which let through devices
// that were then dropped for having no handler.
const SUPPORTED_CLASSES = new Map<string, SupportedClass>([
  ["02:90", { name: "General Lighting", create: (p, a, d) => LightAccessory.create(p, a, d) }],
  ["02:91", { name: "Mono Functional Lighting", create: (p, a, d) => LightAccessory.create(p, a, d) }],
  ["01:30", { name: "Home Air Conditioner", create: (p, a, d) => AirConditionerAccessory.create(p, a, d) }],
]);

function lookUp(eoj: EOJ): SupportedClass | undefined {
  const key = `${eoj[0].toString(16).padStart(2, "0")}:${eoj[1].toString(16).padStart(2, "0")}`;
  return SUPPORTED_CLASSES.get(key);
}

// Whether a handler exists for this device's class.
export function isSupportedEOJ(eoj: EOJ): boolean {
  return lookUp(eoj) !== undefined;
}

// The name a newly registered accessory gets.
export function getClassName(eoj: EOJ): string | null {
  return lookUp(eoj)?.name ?? null;
}

// Builds the handler matching the device's ECHONET Lite class code, returning
// null when the device is unsupported.
//
// This does not talk to the device: the accessory wires up the characteristics
// its class always has, and the profile read that settles the rest runs in the
// background. Nothing here can be delayed by a device that does not answer.
export function createAccessoryHandler(
  platform: ELPlatform,
  accessory: PlatformAccessory,
  device: EchonetDevice,
): AccessoryHandler | null {
  const supported = lookUp(device.eoj);
  if (!supported) {
    return null;
  }

  const loader = new ProfileLoader(
    platform,
    accessory,
    device,
    supported.create(platform, accessory, device),
    supported.name,
  );
  loader.refreshProfile();
  return loader;
}
