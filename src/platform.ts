import { setTimeout as delay } from "node:timers/promises";

import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from "homebridge";

import { createAccessoryHandler } from "./accessories/factory.js";
import { RefreshSwitchAccessory } from "./accessories/refresh-switch.js";
import { getAccessoryContext, setAccessoryContext } from "./accessory-context.js";
import { EchonetDevice } from "./echonet-device.js";
import { EchonetLiteClient } from "./echonet-lite.js";
import { SUPER_EPC } from "./epc.js";
import { readLegacyStorage } from "./legacy-storage.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import type { ELPlatformConfig, EOJ } from "./types.js";

const DISCOVERY_TIMEOUT_MS = 10 * 1000;

export class ELPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly el: EchonetLiteClient;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly builtAccessories = new Set<string>();
  private refreshSwitch: RefreshSwitchAccessory | null = null;
  private cachedRefreshSwitchAccessory: PlatformAccessory | null = null;
  private isDiscovering = false;

  constructor(
    public readonly log: Logging,
    // Undefined when the platform was removed from config.json but cached
    // accessories still reference it.
    public readonly config: ELPlatformConfig | undefined,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.el = new EchonetLiteClient(log);

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

    // Prepare or remove the refresh switch.
    if (accessory.UUID === RefreshSwitchAccessory.UUID) {
      if (this.config.enableRefreshSwitch) {
        this.cachedRefreshSwitchAccessory = accessory;
      } else {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      return;
    }

    // Save the accessory and build later.
    this.accessories.set(accessory.UUID, accessory);
  }

  get discovering(): boolean {
    return this.isDiscovering;
  }

  async startDiscovery(): Promise<void> {
    if (this.isDiscovering) {
      return;
    }
    this.setDiscovering(true);

    this.log.info("Starting discovery");
    this.el.stopMembershipRenewal();
    this.el.startDiscovery((device) => void this.handleDiscoveredDevice(device.address, device.eoj));

    await delay(DISCOVERY_TIMEOUT_MS);
    this.stopDiscovery();
  }

  stopDiscovery(): void {
    if (!this.isDiscovering) {
      return;
    }
    this.setDiscovering(false);

    // After stopping discovery, el would listen to broadcast.
    this.log.info("Finished discovery");
    this.el.stopDiscovery();
    this.el.startMembershipRenewal();
  }

  private async init(): Promise<void> {
    this.log.info("Executing didFinishLaunching callback");

    // Before anything that can fail, so the accessories are never left without
    // the device info that only the legacy file still holds.
    this.migrateLegacyAccessories();

    try {
      await this.el.init();
    } catch (err) {
      this.log.error("Error in init", err);
      return;
    }
    this.log.info("Initializing ECHONET Lite client");

    if (this.config?.enableRefreshSwitch) {
      this.buildRefreshAccessory();
    }

    // Nothing was cached, so this is a first run: scan the network to find the
    // devices instead of waiting for the refresh switch.
    if (this.accessories.size === 0) {
      this.log.info("No existing accessories found");
      await this.startDiscovery();
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
      if (this.builtAccessories.has(uuid)) {
        continue;
      }

      const context = getAccessoryContext(accessory);
      if (!context) {
        this.log.warn("Removing an accessory with no cached device info:", uuid);
        this.accessories.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        continue;
      }

      const device = new EchonetDevice(this.el, context.address, context.eoj, uuid);
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

  private async handleDiscoveredDevice(address: string, eojList: EOJ[]): Promise<void> {
    for (const eoj of eojList) {
      // No UUID yet: it is derived from the identification number read below.
      const probe = new EchonetDevice(this.el, address, eoj);
      this.log.info("Discovered device:", probe.logId);

      // Skip invalid devices.
      if (!this.el.getClassName(eoj)) {
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
      const device = new EchonetDevice(this.el, address, eoj, uuid);
      try {
        await this.syncAccessory(device, uuid);
      } catch (err) {
        this.log.error("Failed to add accessory", device.logId, err);
      }
    }
  }

  private setDiscovering(value: boolean): void {
    this.isDiscovering = value;
    this.refreshSwitch?.updateState(value);
  }

  private buildRefreshAccessory(): void {
    let accessory = this.cachedRefreshSwitchAccessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory("Refresh ECHONET Lite", RefreshSwitchAccessory.UUID);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.refreshSwitch = new RefreshSwitchAccessory(this, accessory);
  }

  // Registers a newly discovered device, or refreshes the cached device info of
  // one that is already known.
  private async syncAccessory(device: EchonetDevice, uuid: string): Promise<void> {
    const registered = this.accessories.get(uuid);
    const accessory =
      registered ?? new this.api.platformAccessory(this.el.getClassName(device.eoj) ?? "ECHONET Lite Device", uuid);

    // May be called twice for the same device due to refreshing.
    if (!this.builtAccessories.has(uuid)) {
      if (!(await createAccessoryHandler(this, accessory, device))) {
        // Unsupported or unusable device.
        return;
      }
      this.builtAccessories.add(uuid);
      accessory.on("identify", () => {});
    }

    const previous = getAccessoryContext(accessory);
    setAccessoryContext(accessory, { address: device.address, eoj: device.eoj });

    if (!registered) {
      this.log.info("Found new accessory:", device.logId);
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else if (previous?.address !== device.address) {
      // The device answered from a new address; persist it for the next boot.
      this.log.info("Updated cached address of", device.logId, "was:", previous?.address);
      this.api.updatePlatformAccessories([accessory]);
    }
  }
}
