import type { ELPropertyData, ELResponse } from "node-echonet-lite";

import type { EchonetLiteClient } from "./echonet-lite.js";
import type { EOJ } from "./types.js";
import { eojEquals, formatDeviceId, formatDeviceRef } from "./utils.js";

// A single ECHONET Lite object bound to the client that talks to it. Accessory
// handlers hold one of these instead of passing a (client, address, eoj) triple
// through every call.
export class EchonetDevice {
  // Identifies the device in log messages.
  readonly logId: string;

  // `uuid` is omitted while a freshly discovered device is being probed, before
  // its HomeKit accessory UUID is known.
  constructor(
    private readonly client: EchonetLiteClient,
    readonly address: string,
    readonly eoj: EOJ,
    uuid?: string,
  ) {
    this.logId = uuid == null ? formatDeviceRef(address, eoj) : formatDeviceId(uuid, address, eoj);
  }

  get(epc: number): Promise<ELResponse> {
    return this.client.getPropertyValue(this.address, this.eoj, epc);
  }

  set(epc: number, edt: ELPropertyData): Promise<ELResponse> {
    return this.client.setPropertyValue(this.address, this.eoj, epc, edt);
  }

  getPropertyMaps(): Promise<ELResponse> {
    return this.client.getPropertyMaps(this.address, this.eoj);
  }

  // Notifications are broadcast by every device on the network, so `listener`
  // only sees the ones this device sent.
  onNotify(listener: (res: ELResponse) => void): void {
    this.client.onNotify((res) => {
      if (res.device.address === this.address && eojEquals(this.eoj, res.message.seoj)) {
        listener(res);
      }
    });
  }
}
