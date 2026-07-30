import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from "homebridge";

import { createAccessoryHandler } from "./accessories/factory.js";
import { RefreshSwitchAccessory } from "./accessories/refresh-switch.js";
import { EchonetLiteClient } from "./echonet-lite.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "./settings.js";
import { AccessoryStorage } from "./storage.js";
import type { ELPlatformConfig, EOJ } from "./types.js";
import { formatDeviceId } from "./utils.js";

const DISCOVERY_TIMEOUT_MS = 10 * 1000;

export class ELPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly el: EchonetLiteClient;
  public readonly accessories = new Map<string, PlatformAccessory>();

  private readonly storage: AccessoryStorage;
  private readonly builtAccessories = new Set<string>();
  private refreshSwitch: RefreshSwitchAccessory | null = null;
  private cachedRefreshSwitchAccessory: PlatformAccessory | null = null;
  private isDiscovering = false;

  constructor(
    public readonly log: Logging,
    public readonly config: ELPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.el = new EchonetLiteClient(log);
    this.storage = new AccessoryStorage(api, log);

    // The config can be missing when the platform was removed from
    // config.json but cached accessories still reference it.
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
    if (!this.setIsDiscovering(true)) {
      return;
    }

    this.log.info("Starting discovery");
    this.el.stopMembershipRenewal();

    this.el.startDiscovery((device) => void this.handleDiscoveredDevice(device.address, device.eoj));

    await new Promise<void>((resolve) => setTimeout(resolve, DISCOVERY_TIMEOUT_MS));
    this.stopDiscovery();
  }

  stopDiscovery(): void {
    if (!this.setIsDiscovering(false)) {
      return;
    }

    // After stopping discovery, el would listen to broadcast.
    this.log.info("Finished discovery");
    this.el.stopDiscovery();
    this.el.startMembershipRenewal();
  }

  private async init(): Promise<void> {
    this.log.info("Executing didFinishLaunching callback");

    try {
      await this.el.init();
    } catch (err) {
      this.log.error("Error in init", err);
      return;
    }
    this.log.info("Initializing ECHONET Lite client");

    if (this.config.enableRefreshSwitch) {
      this.buildRefreshAccessory();
    }

    if (this.accessories.size === 0) {
      // If there is no stored information (i.e. first time run) then do discovery.
      this.log.info("No existing accessories found");
      await this.startDiscovery();
    } else {
      // Otherwise try to recover old accessories.
      this.log.info("Restoring existing accessories");
      for (const [uuid, accessory] of this.accessories) {
        const info = this.storage.get(uuid);
        if (info) {
          this.log.info("Adding existing accessory:", formatDeviceId(uuid, info.address, info.eoj));
          await this.addAccessory(info.address, info.eoj, uuid);
        } else {
          this.accessories.delete(uuid);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
      this.el.startMembershipRenewal();
    }
  }

  private async handleDiscoveredDevice(address: string, eojList: EOJ[]): Promise<void> {
    for (const eoj of eojList) {
      this.log.info("Discovered device:", formatDeviceId("", address, eoj));
      // Skip invalid devices.
      if (!this.el.getClassName(eoj)) {
        continue;
      }

      let uid: string | undefined;
      try {
        // EPC 0x83: identification number, a stable unique ID when available.
        uid = (await this.el.getPropertyValue(address, eoj, 0x83)).message.data?.uid;
        this.log.debug("UID for", formatDeviceId("", address, eoj), "is", uid);
      } catch {
        // Fall back to the address-based ID below.
        this.log.warn("Failed to get UID for", formatDeviceId("", address, eoj));
      }
      uid ??= address + "|" + JSON.stringify(eoj);
      const uuid = this.api.hap.uuid.generate(uid);
      try {
        await this.addAccessory(address, eoj, uuid);
      } catch (err) {
        this.log.error("Failed to add accessory", formatDeviceId(uuid, address, eoj), err);
      }
    }
  }

  private setIsDiscovering(value: boolean): boolean {
    if (value === this.isDiscovering) {
      return false;
    }
    this.isDiscovering = value;
    this.refreshSwitch?.updateState(value);
    return true;
  }

  private buildRefreshAccessory(): void {
    let accessory = this.cachedRefreshSwitchAccessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory("Refresh ECHONET Lite", RefreshSwitchAccessory.UUID);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.refreshSwitch = new RefreshSwitchAccessory(this, accessory);
  }

  private async addAccessory(address: string, eoj: EOJ, uuid: string): Promise<void> {
    const registered = this.accessories.has(uuid);
    const accessory =
      this.accessories.get(uuid) ??
      new this.api.platformAccessory(this.el.getClassName(eoj) ?? "ECHONET Lite Device", uuid);

    // The addAccessory may be called twice due to refreshing.
    if (!this.builtAccessories.has(uuid)) {
      if (!(await createAccessoryHandler(this, accessory, this.el, address, eoj))) {
        return;
      } // unsupported accessory
      this.builtAccessories.add(uuid);
      accessory.on("identify", () => {});
    }

    if (!registered) {
      this.log.info("Found new accessory:", formatDeviceId(uuid, address, eoj));
      this.accessories.set(uuid, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.storage.set(uuid, { address, eoj });
    }
  }
}
