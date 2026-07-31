import type { EchonetLiteClient, Notification, PropertyValues } from "./client.js";
import type { Property, PropertyWrite, StandardVersion, WritableProperty } from "./codec.js";
import {
  GetPropertyMap,
  IdentificationNumber,
  InfPropertyMap,
  ManufacturerCode,
  ProductCode,
  SetPropertyMap,
  StandardVersionInformation,
  write,
} from "./codec.js";
import type { EOJ, EPC } from "./types.js";
import { eojEquals, formatDeviceId, formatDeviceRef } from "./utils.js";

// The properties a device reports it supports.
export interface PropertyMaps {
  inf: EPC[];
  set: EPC[];
  get: EPC[];
}

// What a device says it is. Every field is null when the device does not carry
// the property or answered with nothing usable: only the property maps
// themselves are required of every device class.
export interface DeviceInfo {
  standardVersion: StandardVersion | null;
  manufacturerCode: number | null;
  productCode: string | null;
  identificationNumber: string | null;
}

// Everything about a device that does not change while it is running: what it
// supports, and what it is. Read once per accessory, and again whenever a
// refresh scan sees the device.
export interface DeviceProfile {
  maps: PropertyMaps;
  info: DeviceInfo;
}

// One field of DeviceInfo paired with the property that fills it. Reading a
// varying subset of the info properties means carrying properties of different
// types in one list, which no single `T` can describe; `infoField` below pairs
// each property with its field while `T` is still known, the same way the
// codec's `write` does for writes, and hands back this erased form.
interface InfoField {
  readonly property: Property<unknown>;
  store(value: unknown): void;
}

function infoField<T>(property: Property<T>, store: (value: T | null) => void): InfoField {
  return { property, store: store as (value: unknown) => void };
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

  // Two round trips, not one: the maps come first, and only the info properties
  // the Get map lists are then asked for. Bundling all of them into a single
  // request would work — the client treats a Get_SNA as a partial success — but
  // it would ask every device for the optional properties (0x8C, 0x83) it has
  // just as good a way of knowing it does not carry.
  //
  // A map the device did not answer for reports no properties rather than being
  // absent, which in turn leaves the whole of `info` unread.
  async getProfile(): Promise<DeviceProfile> {
    const [inf, set, get] = await this.getMany(InfPropertyMap, SetPropertyMap, GetPropertyMap);
    const maps: PropertyMaps = { inf: inf ?? [], set: set ?? [], get: get ?? [] };
    return { maps, info: await this.getDeviceInfo(maps) };
  }

  // Reads whichever of the device info properties the device lists in its Get
  // map, in one round trip. The rest are not asked for and stay null, which is
  // the same as what an unusable answer to them would have produced.
  private async getDeviceInfo(maps: PropertyMaps): Promise<DeviceInfo> {
    const info: DeviceInfo = {
      standardVersion: null,
      manufacturerCode: null,
      productCode: null,
      identificationNumber: null,
    };

    const fields = [
      infoField(StandardVersionInformation, (value) => (info.standardVersion = value)),
      infoField(ManufacturerCode, (value) => (info.manufacturerCode = value)),
      infoField(ProductCode, (value) => (info.productCode = value)),
      infoField(IdentificationNumber, (value) => (info.identificationNumber = value)),
    ].filter(({ property }) => maps.get.includes(property.epc));

    // Asking for none of them is free: the client answers a request with no
    // properties without putting anything on the wire.
    const values = await this.getMany(...fields.map(({ property }) => property));
    fields.forEach((field, i) => field.store(values[i]));

    return info;
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
