import type { PlatformAccessory } from "homebridge";

import type { Property, WritableProperty } from "../echonet/codec.js";
import type { DeviceProfile, EchonetDevice, PropertyMaps } from "../echonet/device.js";
import { manufacturerName } from "../echonet/manufacturer.js";
import { formatProperties } from "../echonet/utils.js";
import type { ELPlatform } from "../platform.js";
import { applyAccessoryInformation } from "./accessory-information.js";

// Whether the device reports it answers reads of this property. A property
// missing from the Get map can still be read — devices are not always honest
// about their maps — but a characteristic built on one has nothing to show.
export function supportsGet(maps: PropertyMaps, property: Property<unknown>): boolean {
  return maps.get.includes(property.epc);
}

// Whether the device reports it accepts writes to this property.
export function supportsSet(maps: PropertyMaps, property: WritableProperty<unknown>): boolean {
  return maps.set.includes(property.epc);
}

// Whether the device reports it announces changes to this property, so HomeKit
// stays in sync when the device is operated by other means.
export function supportsNotify(maps: PropertyMaps, property: Property<unknown>): boolean {
  return maps.inf.includes(property.epc);
}

// Implemented by every device-backed accessory handler. Called once shortly
// after the accessory is wired up, and again on every refresh scan, so it has to
// be idempotent: adding a characteristic that is already there, or removing one
// that was never added, must both be no-ops.
export interface ProfileAware {
  applyProfile(profile: DeviceProfile): void;
}

// What the platform holds on to for each accessory it has wired up.
export interface AccessoryHandler {
  refreshProfile(): void;
}

// Reads the device profile in the background and hands it to the accessory.
//
// Nothing here is awaited by the caller, and that is the point: an unreachable
// device costs a 15 second timeout, accessories are restored one after another,
// and Homebridge publishes the bridge without waiting for any of it. Blocking
// setup on this read would delay every accessory behind an offline one. So the
// accessory wires up its required characteristics immediately and gets the
// profile when it arrives — or keeps whatever it was restored with, if the
// device never answers.
export class ProfileLoader implements AccessoryHandler {
  private pending = false;
  private loaded = false;

  constructor(
    private readonly platform: ELPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly device: EchonetDevice,
    private readonly handler: ProfileAware,
    // The name of the device's ECHONET Lite class, shown as the model for a
    // device that carries no product code.
    private readonly className: string | null,
  ) {}

  // Starts a read, unless one is already in flight. Safe to call as often as the
  // device is seen: it is a single request, and re-reading picks up a device
  // that was offline when its accessory was created.
  refreshProfile(): void {
    if (this.pending) {
      return;
    }
    this.pending = true;
    void this.load().finally(() => {
      this.pending = false;
    });
  }

  private async load(): Promise<void> {
    const { log } = this.platform;
    let profile: DeviceProfile;
    try {
      profile = await this.device.getProfile();
    } catch (err) {
      // Nothing is lost by failing: the accessory keeps the characteristics it
      // already has, and the next refresh scan tries again.
      log.debug("Failed to get the profile of", this.device.logId, err);
      return;
    }

    this.logProfile(profile);
    applyAccessoryInformation(this.platform, this.accessory, profile.info, this.className);
    this.handler.applyProfile(profile);
    this.loaded = true;
  }

  // The first read is worth an info line; the ones a refresh scan triggers
  // afterwards report the same thing over and over, so they go to debug.
  private logProfile({ maps, info }: DeviceProfile): void {
    const { log } = this.platform;
    const { logId } = this.device;

    log.debug("INF properties for", logId, formatProperties(maps.inf));
    log.debug("Get properties for", logId, formatProperties(maps.get));
    log.debug("Set properties for", logId, formatProperties(maps.set));

    const { standardVersion: version } = info;
    const summary = [
      `manufacturer: ${info.manufacturerCode == null ? "unknown" : manufacturerName(info.manufacturerCode)}`,
      `product: ${info.productCode ?? "unknown"}`,
      // The one field with nowhere to go in HomeKit; see accessory-information.ts.
      `standard version: ${version == null ? "unknown" : `${version.release}${version.revision}`}`,
    ].join(", ");

    if (this.loaded) {
      log.debug("Device info:", logId, summary);
    } else {
      log.info("Device info:", logId, summary);
    }
  }
}
