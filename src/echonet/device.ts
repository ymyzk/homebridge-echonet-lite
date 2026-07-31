import type { EchonetLiteClient, Notification, PropertyMaps } from "./client.js";
import type { Property, WritableProperty } from "./codec.js";
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

  // Resolves to null when the device answered without a usable value for the
  // property, and rejects when it did not answer at all.
  get<T>(property: Property<T>): Promise<T | null> {
    return this.client.getProperty(this.address, this.eoj, property);
  }

  set<T>(property: WritableProperty<T>, value: T): Promise<void> {
    return this.client.setProperty(this.address, this.eoj, property, value);
  }

  getPropertyMaps(): Promise<PropertyMaps> {
    return this.client.getPropertyMaps(this.address, this.eoj);
  }

  // Notifications are broadcast by every device on the network, so `listener`
  // only sees the ones this device sent. Returns a function that unsubscribes.
  onNotify(listener: (notification: Notification) => void): () => void {
    return this.client.onNotify((notification) => {
      if (notification.address === this.address && eojEquals(this.eoj, notification.seoj)) {
        listener(notification);
      }
    });
  }
}
