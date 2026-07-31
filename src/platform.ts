import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from "homebridge";

import { createAccessoryHandler } from "./accessories/factory.js";
import { isRefreshSwitchAccessory, setUpRefreshSwitch } from "./accessories/refresh-switch.js";
import { getAccessoryContext, setAccessoryContext } from "./accessory-context.js";
import { DiscoveryController } from "./discovery.js";
import { EchonetDevice } from "./echonet-device.js";
import { EchonetLiteClient } from "./echonet-lite.js";
import { SUPER_EPC } from "./epc.js";
import { readLegacyStorage } from "./legacy-storage.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import type { DiscoveredObjects, ELPlatformConfig } from "./types.js";

export class ELPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly client: EchonetLiteClient;
  private readonly discovery: DiscoveryController;
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly uuidsWithHandler = new Set<string>();
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

    // Save the accessory and build later.
    this.accessories.set(accessory.UUID, accessory);
  }

  private async init(): Promise<void> {
    this.log.info("Executing didFinishLaunching callback");

    // Before anything that can fail, so the accessories are never left without
    // the device info that only the legacy file still holds.
    this.migrateLegacyAccessories();

    try {
      await this.client.init();
    } catch (err) {
      this.log.error("Error in init", err);
      return;
    }
    this.log.info("Initializing ECHONET Lite client");

    setUpRefreshSwitch(this.api, this.discovery, this.cachedRefreshSwitch, this.config?.enableRefreshSwitch === true);

    // Nothing was cached, so this is a first run: scan the network to find the
    // devices instead of waiting for the refresh switch.
    if (this.accessories.size === 0) {
      this.log.info("No existing accessories found");
      this.discovery.start();
      return;
    }

    await this.restoreCachedAccessories();
  }

  // Rebuilds every cached accessory from the device info Homebridge restored
  // with it, so a boot costs no discovery scan. Devices added later are picked
  // up by the refresh switch.
  private async restoreCachedAccessories(): Promise<void> {
    this.log.info("Restoring existing accessories");

    // Snapshot: the loop drops the accessories it cannot restore as it goes.
    for (const [uuid, accessory] of [...this.accessories]) {
      if (this.uuidsWithHandler.has(uuid)) {
        continue;
      }

      const context = getAccessoryContext(accessory);
      if (!context) {
        this.log.warn("Removing an accessory with no cached device info:", uuid);
        this.accessories.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        continue;
      }

      const device = new EchonetDevice(this.client, context.address, context.eoj, uuid);
      this.log.info("Adding existing accessory:", device.logId);
      try {
        await this.syncAccessory(device, uuid);
      } catch (err) {
        // An unreachable device rejects while its properties are read; keep
        // restoring the rest instead of losing the whole boot.
        this.log.error("Failed to restore accessory", device.logId, err);
      }
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

      // Skip invalid devices.
      if (!this.client.getClassName(eoj)) {
        continue;
      }

      let uid: string | undefined;
      try {
        // A stable unique ID, when the device reports one.
        uid = (await probe.get(SUPER_EPC.IDENTIFICATION_NUMBER)).message.data?.uid;
        this.log.debug("UID for", probe.logId, "is", uid);
      } catch {
        // Fall back to the address-based ID below.
        this.log.warn("Failed to get UID for", probe.logId);
      }
      uid ??= address + "|" + JSON.stringify(eoj);

      const uuid = this.api.hap.uuid.generate(uid);
      const device = new EchonetDevice(this.client, address, eoj, uuid);
      try {
        await this.syncAccessory(device, uuid);
      } catch (err) {
        this.log.error("Failed to add accessory", device.logId, err);
      }
    }
  }

  // Registers a newly discovered device, or refreshes the cached device info of
  // one that is already known.
  private async syncAccessory(device: EchonetDevice, uuid: string): Promise<void> {
    const registered = this.accessories.get(uuid);
    const accessory =
      registered ?? new this.api.platformAccessory(this.client.getClassName(device.eoj) ?? "ECHONET Lite Device", uuid);

    // May be called twice for the same device due to refreshing.
    if (!this.uuidsWithHandler.has(uuid)) {
      if (!(await createAccessoryHandler(this, accessory, device))) {
        // Unsupported or unusable device.
        return;
      }
      this.uuidsWithHandler.add(uuid);
      accessory.on("identify", () => {});
    }

    const previousContext = getAccessoryContext(accessory);
    setAccessoryContext(accessory, { address: device.address, eoj: device.eoj });

    if (!registered) {
      this.log.info("Found new accessory:", device.logId);
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else if (previousContext?.address !== device.address) {
      // The device answered from a new address; persist it for the next boot.
      this.log.info("Updated cached address of", device.logId, "was:", previousContext?.address);
      this.api.updatePlatformAccessories([accessory]);
    }
  }
}
