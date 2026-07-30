import type { PlatformAccessory } from "homebridge";

import type { EchonetDevice } from "../echonet-device.js";
import type { ELPlatform } from "../platform.js";
import { AirConditionerAccessory } from "./aircon.js";
import { LightAccessory } from "./light.js";

// Builds the handler matching the device's ECHONET Lite class code.
// Returns false when the device is unsupported or unusable.
export async function createAccessoryHandler(
  platform: ELPlatform,
  accessory: PlatformAccessory,
  device: EchonetDevice,
): Promise<boolean> {
  const [classGroupCode, classCode] = device.eoj;
  if (classGroupCode === 0x02 && (classCode === 0x90 || classCode === 0x91)) {
    return (await LightAccessory.create(platform, accessory, device)) !== null;
  }
  if (classGroupCode === 0x01 && classCode === 0x30) {
    AirConditionerAccessory.create(platform, accessory, device);
    return true;
  }
  return false;
}
