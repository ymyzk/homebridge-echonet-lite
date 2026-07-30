import type { PlatformAccessory, Service } from "homebridge";

import type { EchonetLiteClient } from "../echonet-lite.js";
import type { ELPlatform } from "../platform.js";
import type { EOJ } from "../types.js";
import { formatDeviceId, formatProperties } from "../utils.js";

const EPC = {
  OPERATION_STATUS: 0x80,
  ILLUMINANCE_LEVEL: 0xb0,
} as const;

// A general lighting (0x02/0x90) or mono functional lighting (0x02/0x91) device
// exposed as a HomeKit Lightbulb.
export class LightAccessory {
  private readonly service: Service;
  private readonly logId: string;
  private brightness = 0;
  private lastStatus: boolean;

  // Probes the device before wiring characteristics; returns null when the
  // device does not respond so it is not registered.
  static async create(
    platform: ELPlatform,
    accessory: PlatformAccessory,
    el: EchonetLiteClient,
    address: string,
    eoj: EOJ,
  ): Promise<LightAccessory | null> {
    const logId = formatDeviceId(accessory.UUID, address, eoj);
    platform.log.info("Initializing a light accessory:", logId);
    const propertyMaps = (await el.getPropertyMaps(address, eoj)).message.data;
    platform.log.debug("INF properties for", logId, formatProperties(propertyMaps?.inf));
    platform.log.debug("Get properties for", logId, formatProperties(propertyMaps?.get));
    platform.log.debug("Set properties for", logId, formatProperties(propertyMaps?.set));
    const properties = propertyMaps?.set ?? [];

    let status: boolean | undefined;
    try {
      status = (await el.getPropertyValue(address, eoj, EPC.OPERATION_STATUS)).message.data?.status;
    } catch {
      // Treated as an unusable device below.
    }
    if (status == null) {
      return null;
    }

    const supportsBrightness = properties.includes(EPC.ILLUMINANCE_LEVEL);
    let brightness = 0;
    if (supportsBrightness) {
      try {
        const level = (await el.getPropertyValue(address, eoj, EPC.ILLUMINANCE_LEVEL)).message.data?.level;
        if (level != null) {
          brightness = level;
          platform.log.debug("Initialized brightness:", logId, brightness);
        }
      } catch {
        // Keep the default brightness.
      }
    }

    return new LightAccessory(platform, accessory, el, address, eoj, supportsBrightness, status, brightness);
  }

  private constructor(
    private readonly platform: ELPlatform,
    accessory: PlatformAccessory,
    private readonly el: EchonetLiteClient,
    private readonly address: string,
    private readonly eoj: EOJ,
    supportsBrightness: boolean,
    initialStatus: boolean,
    initialBrightness: number,
  ) {
    this.service = accessory.getService(platform.Service.Lightbulb) ?? accessory.addService(platform.Service.Lightbulb);
    this.logId = formatDeviceId(accessory.UUID, address, eoj);
    this.lastStatus = initialStatus;
    this.service.updateCharacteristic(platform.Characteristic.On, initialStatus);

    this.service
      .getCharacteristic(platform.Characteristic.On)
      .onSet(async (value) => {
        await this.el.setPropertyValue(this.address, this.eoj, 0x80, { status: value as boolean });
        this.lastStatus = value as boolean;
        this.platform.log.info("Set status", value, "for", this.logId);
      })
      .onGet(async () => {
        this.platform.log.info("Getting status from", this.logId);
        try {
          const status = (await this.el.getPropertyValue(this.address, this.eoj, 0x80)).message.data?.status;
          if (status != null) {
            this.lastStatus = status;
            this.platform.log.info("Got status:", this.logId, this.lastStatus);
          }
        } catch (err) {
          this.platform.log.error("Failed to get status from", this.logId, err);
        }
        return this.lastStatus;
      });

    if (supportsBrightness) {
      this.updateBrightness(initialBrightness);
      this.service
        .getCharacteristic(platform.Characteristic.Brightness)
        .onSet(async (value) => {
          if (value !== this.brightness) {
            this.platform.log.debug("Setting brightness", value, "for", this.logId);
            this.updateBrightness(value as number);
            await this.el.setPropertyValue(this.address, this.eoj, EPC.ILLUMINANCE_LEVEL, { level: value as number });
          } else {
            this.platform.log.debug("Setting brightness no-op", value, "for", this.logId);
          }
        })
        .onGet(() => {
          this.platform.log.debug("Getting brightness from", this.logId);
          // Refresh in the background; respond immediately with the cached value.
          void this.refreshBrightness();
          return this.brightness;
        });
    }

    // Subscribe to status changes.
    el.onNotify((res) => {
      const { seoj, prop } = res.message;
      if (res.device.address !== address || eoj[0] !== seoj[0] || eoj[1] !== seoj[1] || eoj[2] !== seoj[2]) {
        return;
      }
      this.platform.log.info("Received a notification from", this.logId);

      for (const p of prop ?? []) {
        if (!p.edt) {
          continue;
        }
        if (p.epc === 0x80 && p.edt.status != null) {
          this.service.updateCharacteristic(platform.Characteristic.On, p.edt.status);
          this.platform.log.info("Received and updated status:", this.logId, p.edt.status);
        } else if (p.epc === EPC.ILLUMINANCE_LEVEL && p.edt.level != null) {
          this.updateBrightness(p.edt.level);
        }
      }
    });
  }

  private updateBrightness(value: number): void {
    this.brightness = value;
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, value);
  }

  private async refreshBrightness(): Promise<void> {
    try {
      const level = (await this.el.getPropertyValue(this.address, this.eoj, EPC.ILLUMINANCE_LEVEL)).message.data?.level;
      this.platform.log.debug("Got brightness:", this.logId, level);
      if (level != null) {
        this.updateBrightness(level);
      }
    } catch (err) {
      this.platform.log.error("Failed to get brightness from", this.logId, err);
    }
  }
}
