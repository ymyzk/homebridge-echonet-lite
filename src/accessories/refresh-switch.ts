import type { PlatformAccessory, Service } from "homebridge";

import type { ELPlatform } from "../platform.js";

// A switch accessory that triggers a new ECHONET Lite discovery scan.
export class RefreshSwitchAccessory {
  static readonly UUID = "076cc8c6-7f72-441b-81cb-d85e27386dc1";

  private readonly service: Service;

  constructor(
    private readonly platform: ELPlatform,
    accessory: PlatformAccessory,
  ) {
    this.service = accessory.getService(platform.Service.Switch) ?? accessory.addService(platform.Service.Switch);
    this.service
      .getCharacteristic(platform.Characteristic.On)
      .onGet(() => platform.discovering)
      .onSet(async (value) => {
        if (value) {
          await platform.startDiscovery();
        } else {
          platform.stopDiscovery();
        }
      });
  }

  updateState(isDiscovering: boolean): void {
    this.service.updateCharacteristic(this.platform.Characteristic.On, isDiscovering);
  }
}
