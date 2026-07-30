import type { PlatformAccessory } from "homebridge";

import type { EchonetLiteClient } from "../echonet-lite.js";
import type { ELPlatform } from "../platform.js";
import type { EOJ } from "../types.js";
import { AirConditionerAccessory } from "./aircon.js";
import { LightAccessory } from "./light.js";

// Builds the handler matching the device's ECHONET Lite class code.
// Returns false when the device is unsupported or unusable.
export async function createAccessoryHandler(
  platform: ELPlatform,
  accessory: PlatformAccessory,
  el: EchonetLiteClient,
  address: string,
  eoj: EOJ,
): Promise<boolean> {
  if (eoj[0] === 0x02 && (eoj[1] === 0x90 || eoj[1] === 0x91)) {
    return (await LightAccessory.create(platform, accessory, el, address, eoj)) !== null;
  }
  if (eoj[0] === 0x01 && eoj[1] === 0x30) {
    AirConditionerAccessory.create(platform, accessory, el, address, eoj);
    return true;
  }
  return false;
}
