import type { PlatformAccessory } from "homebridge";

import type { DeviceInfo } from "../echonet/device.js";
import { manufacturerName } from "../echonet/manufacturer.js";
import type { ELPlatform } from "../platform.js";

// Publishes what the device says it is to the AccessoryInformation service every
// HomeKit accessory carries. A field the device did not report is left at
// whatever it already held: Homebridge's own default on a new accessory, or the
// value from the last successful read on a restored one. Overwriting those with
// "Unknown" would lose information rather than add any.
//
// `fallbackModel` is the name of the device's ECHONET Lite class, used for
// devices that do not carry a product code (0x8C is optional).
//
// The standard version (0x82) deliberately has no home here. The obvious
// candidate, FirmwareRevision, must be a dotted number for HomeKit to accept it,
// while a standard version's release is a letter — and it describes the version
// of the spec the device implements, not its firmware, so it would be wrong even
// if it fitted. It is logged instead; see profile.ts.
export function applyAccessoryInformation(
  platform: ELPlatform,
  accessory: PlatformAccessory,
  info: DeviceInfo,
  fallbackModel: string | null,
): void {
  const { Characteristic } = platform;
  const service =
    accessory.getService(platform.Service.AccessoryInformation) ??
    accessory.addService(platform.Service.AccessoryInformation);

  if (info.manufacturerCode != null) {
    service.updateCharacteristic(Characteristic.Manufacturer, manufacturerName(info.manufacturerCode));
  }

  const model = info.productCode ?? fallbackModel;
  if (model != null) {
    service.updateCharacteristic(Characteristic.Model, model);
  }

  // The same identification number the accessory's UUID is derived from, so it
  // stays with the accessory even when the device changes address.
  if (info.identificationNumber != null) {
    service.updateCharacteristic(Characteristic.SerialNumber, info.identificationNumber);
  }
}
