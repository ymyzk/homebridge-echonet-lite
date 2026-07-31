import type { API, PlatformAccessory } from "homebridge";

import type { DiscoveryController } from "../discovery.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "../settings.js";

// The switch is not backed by a device, so there is no identification number to
// derive a UUID from; a fixed one keeps it stable across restarts.
const UUID = "076cc8c6-7f72-441b-81cb-d85e27386dc1";
const NAME = "Refresh ECHONET Lite";

// Tells the accessory Homebridge restored for this switch apart from the device
// accessories, which are cached and rebuilt in a completely different way.
export function isRefreshSwitchAccessory(accessory: PlatformAccessory): boolean {
  return accessory.UUID === UUID;
}

// Wires up the switch that triggers a discovery scan, creating its accessory on
// first use and removing a leftover one once the feature is turned off.
// `cached` is the accessory Homebridge restored, when there is one.
export function setUpRefreshSwitch(
  api: API,
  discovery: DiscoveryController,
  cached: PlatformAccessory | null,
  enabled: boolean,
): void {
  if (!enabled) {
    if (cached) {
      api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached]);
    }
    return;
  }

  let accessory = cached;
  if (!accessory) {
    accessory = new api.platformAccessory(NAME, UUID);
    api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  const { Service, Characteristic } = api.hap;
  const service = accessory.getService(Service.Switch) ?? accessory.addService(Service.Switch);
  service
    .getCharacteristic(Characteristic.On)
    .onGet(() => discovery.isDiscovering)
    .onSet((value) => {
      if (value) {
        discovery.start();
      } else {
        discovery.stop();
      }
    });

  discovery.onStateChange((isDiscovering) => service.updateCharacteristic(Characteristic.On, isDiscovering));
}
