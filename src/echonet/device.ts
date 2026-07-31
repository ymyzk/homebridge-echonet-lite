import type { EchonetLiteClient, Notification, PropertyValues } from "./client.js";
import type { Property, PropertyWrite, WritableProperty } from "./codec.js";
import { GetPropertyMap, InfPropertyMap, SetPropertyMap, write } from "./codec.js";
import type { EOJ } from "./types.js";
import { eojEquals, formatDeviceId, formatDeviceRef } from "./utils.js";

// The properties a device reports it supports, as EPC lists.
export interface PropertyMaps {
  inf: number[];
  set: number[];
  get: number[];
}

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

  // Reads several properties in one round trip, resolving with their values in
  // the order they were asked for. The client only speaks in groups of
  // properties; reading or writing one at a time is this class's convenience.
  getMany<P extends readonly Property<unknown>[]>(...properties: P): Promise<PropertyValues<P>> {
    return this.client.getProperties(this.address, this.eoj, ...properties);
  }

  // Writes several properties in one round trip. Build each argument with the
  // codec's `write`.
  setMany(...writes: PropertyWrite[]): Promise<void> {
    return this.client.setProperties(this.address, this.eoj, ...writes);
  }

  // Resolves to null when the device answered without a usable value for the
  // property, and rejects when it did not answer at all.
  async get<T>(property: Property<T>): Promise<T | null> {
    const [value] = await this.getMany(property);
    return value;
  }

  set<T>(property: WritableProperty<T>, value: T): Promise<void> {
    return this.setMany(write(property, value));
  }

  // The three maps are read together, in one round trip. A device that does not
  // answer for one of them reports no properties for it rather than failing the
  // whole read.
  async getPropertyMaps(): Promise<PropertyMaps> {
    const [inf, set, get] = await this.getMany(InfPropertyMap, SetPropertyMap, GetPropertyMap);
    return { inf: inf ?? [], set: set ?? [], get: get ?? [] };
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
