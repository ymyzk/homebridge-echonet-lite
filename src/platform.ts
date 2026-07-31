import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from "homebridge";

import { createAccessoryHandler, getClassName, isSupportedEOJ } from "./accessories/factory.js";
import type { AccessoryHandler } from "./accessories/profile.js";
import { isRefreshSwitchAccessory, setUpRefreshSwitch } from "./accessories/refresh-switch.js";
import { getAccessoryContext, setAccessoryContext } from "./accessory-context.js";
import { EchonetLiteClient } from "./echonet/client.js";
import { IdentificationNumber } from "./echonet/codec.js";
import { EchonetDevice } from "./echonet/device.js";
import { DiscoveryController } from "./echonet/discovery.js";
import type { DiscoveredObjects } from "./echonet/types.js";
import { readLegacyStorage } from "./legacy-storage.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import type { ELPlatformConfig } from "./types.js";

export class ELPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly client: EchonetLiteClient;
  private readonly discovery: DiscoveryController;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, AccessoryHandler>();
  private cachedRefreshSwitch: PlatformAccessory | null = null;

  constructor(
    public readonly log: Logging,
    // Undefined when the platform was removed from config.json but cached
    // accessories still reference it.
    public readonly config: ELPlatformConfig | undefined,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.client = new EchonetLiteClient(log);
    this.discovery = new DiscoveryController(log, this.client, (objects) => void this.handleDiscoveredObjects(objects));

    if (!this.config) {
      return;
    }

    this.log.info("Finished initializing platform:", this.config.name);
    this.api.on("didFinishLaunching", () => void this.init());
    // Releases the socket bound to port 3610, which a restarting Homebridge
    // would otherwise have to wait for.
    this.api.on("shutdown", () => {
      this.discovery.stop();
      this.client.close();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    if (!this.config) {
      return;
    }

    // Handled in init(), once the config says whether the switch is still wanted.
    if (isRefreshSwitchAccessory(accessory)) {
      this.cachedRefreshSwitch = accessory;
      return;
    }

    // A handler cannot be built yet: Homebridge restores accessories before
    // didFinishLaunching, and building one needs a live client.
    this.accessories.set(accessory.UUID, accessory);
  }

  private async init(): Promise<void> {
    this.log.info("Homebridge finished launching");

    // Before anything that can fail, so the accessories are never left without
    // the device info that only the legacy file still holds.
    this.migrateLegacyAccessories();

    this.log.info("Initializing ECHONET Lite client");
    try {
      await this.client.init();
    } catch (err) {
      this.log.error("Failed to initialize ECHONET Lite client", err);
      return;
    }
    this.log.info("Initialized ECHONET Lite client");

    setUpRefreshSwitch(this.api, this.discovery, this.cachedRefreshSwitch, this.config?.enableRefreshSwitch === true);

    // Nothing was cached, so this is a first run: scan the network to find the
    // devices instead of waiting for the refresh switch.
    if (this.accessories.size === 0) {
      this.log.info("No existing accessories found");
      this.discovery.start();
      return;
    }

    this.restoreCachedAccessories();
  }

  // Rebuilds every cached accessory from the device info Homebridge restored
  // with it, so a boot costs no discovery scan. Devices added later are picked
  // up by the refresh switch.
  //
  // Nothing here talks to a device: the accessories are wired from what was
  // cached with them, and each one reads its profile in the background. A device
  // that is switched off no longer holds up the accessories behind it.
  private restoreCachedAccessories(): void {
    this.log.info("Restoring cached accessories");

    // Snapshot: the loop drops the accessories it cannot restore as it goes.
    for (const [uuid, accessory] of [...this.accessories]) {
      const context = getAccessoryContext(accessory);
      if (!context) {
        this.log.warn("Removing an accessory with no cached device info:", uuid);
        this.accessories.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        continue;
      }

      const device = new EchonetDevice(this.client, context.address, context.eoj, uuid);
      this.log.info("Restoring accessory:", device.logId);
      this.syncAccessory(device, uuid);
    }
  }

  // Copies the address/EOJ that releases before 2.0 kept in their own JSON file
  // into the accessory context, which Homebridge persists for us. This is a no-op
  // once every accessory has been migrated.
  private migrateLegacyAccessories(): void {
    const pending = [...this.accessories.values()].filter((accessory) => getAccessoryContext(accessory) === null);
    if (pending.length === 0) {
      return;
    }

    const legacy = readLegacyStorage(this.api);
    const migrated = pending.filter((accessory) => {
      const context = legacy.get(accessory.UUID);
      if (!context) {
        return false;
      }
      setAccessoryContext(accessory, context);
      return true;
    });
    if (migrated.length > 0) {
      this.log.info("Migrated", migrated.length, "accessories from the legacy storage file");
      this.api.updatePlatformAccessories(migrated);
    }
  }

  private async handleDiscoveredObjects({ address, eojList }: DiscoveredObjects): Promise<void> {
    for (const eoj of eojList) {
      // No UUID yet: it is derived from the identification number read below.
      const probe = new EchonetDevice(this.client, address, eoj);
      this.log.info("Discovered device:", probe.logId);

      // Nothing here can drive a device this plugin has no handler for, so skip
      // it before spending a probe on it.
      if (!isSupportedEOJ(eoj)) {
        continue;
      }

      let uid: string | null = null;
      try {
        // The accessory UUID is derived from this, so an accessory survives a
        // change of address.
        uid = await probe.get(IdentificationNumber);
        this.log.debug("UID for", probe.logId, "is", uid);
      } catch {
        // Fall back to the address-based ID below.
        this.log.warn("Failed to get UID for", probe.logId);
      }
      uid ??= address + "|" + JSON.stringify(eoj);

      const uuid = this.api.hap.uuid.generate(uid);
      this.syncAccessory(new EchonetDevice(this.client, address, eoj, uuid), uuid);
    }
  }

  // Registers a newly discovered device, or refreshes the cached device info of
  // one that is already known.
  private syncAccessory(device: EchonetDevice, uuid: string): void {
    const registered = this.accessories.get(uuid);
    const accessory =
      registered ?? new this.api.platformAccessory(getClassName(device.eoj) ?? "ECHONET Lite Device", uuid);

    // The same device is reported again by every later scan, but the handler is
    // built once: a second one would subscribe to notifications on top of the
    // first. Seeing the device again re-reads its profile instead, which is how
    // one that was switched off when its accessory was built picks up the
    // characteristics and the device info it could not report then.
    const handler = this.handlers.get(uuid);
    if (handler) {
      handler.refreshProfile();
    } else {
      const created = createAccessoryHandler(this, accessory, device);
      if (!created) {
        // Unsupported: nothing here can drive it. A cached accessory stays
        // registered, so a device this plugin learns to support later comes
        // back without the user having to re-add it.
        return;
      }
      this.handlers.set(uuid, created);
      accessory.on("identify", () => {});
    }

    const previousContext = getAccessoryContext(accessory);
    setAccessoryContext(accessory, { address: device.address, eoj: device.eoj });

    if (!registered) {
      this.log.info("Registering new accessory:", device.logId);
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else if (previousContext?.address !== device.address) {
      // The device answered from a new address; persist it for the next boot.
      this.log.info("Updated cached address of", device.logId, "was:", previousContext?.address);
      this.api.updatePlatformAccessories([accessory]);
    }
  }
}
