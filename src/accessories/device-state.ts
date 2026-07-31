import type { Logging } from "homebridge";

import type { Notification } from "../echonet/client.js";
import type { Property, WritableProperty } from "../echonet/codec.js";
import type { EchonetDevice, PropertyMaps } from "../echonet/device.js";
import type { EPC } from "../echonet/types.js";
import { supportsGet } from "./profile.js";

// How long a read stays authoritative. HomeKit asks for every characteristic of
// an accessory each time it refreshes, and asks again far more often than a room
// changes, so serving those from one read is most of what keeps devices quiet.
export const CACHE_TTL_MS = 10 * 1000;

// How long a characteristic getter waits for a read it had to start. HAP-NodeJS
// warns that a handler is slow at 3 seconds, so this stays well under it: a
// device that has not answered by then is reported from what it last said, and
// the answer is pushed to HomeKit when it arrives.
export const READ_WAIT_MS = 1500;

// How long a value that was just written is protected from being overwritten by
// a read. Devices go on reporting the old value for a moment after accepting a
// write, and a read already on its way when the write went out will still be
// carrying it.
export const SET_SETTLE_MS = 3 * 1000;

// Waits for `promise`, but for no longer than `ms`. Never rejects: the callers
// here treat a read that has not arrived the same as one that failed, and both
// leave the last known value in place.
function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// One cached property. `get` is what a characteristic getter reads.
export interface StateCell<T> {
  // The value the device last reported, or null before it has reported one.
  get(): T | null;
  // Called whenever the value changes, including when a notification or a late
  // read brings one in after a getter has already answered.
  onChange(listener: (value: T | null) => void): void;
}

export interface WritableStateCell<T> extends StateCell<T> {
  // Writes to the device, updating the cache before the write goes out so
  // HomeKit reflects the change at once. Rolls back and rethrows if the device
  // refuses it.
  write(value: T): Promise<void>;
}

// The operations DeviceState performs on a cell, with the property's type erased
// so cells of different types can be held in one list. Same approach as the
// codec's `write` and `device.ts`'s `infoField`: the type is checked while it is
// still known, at `track`, and only erased signatures escape.
interface AnyCell {
  readonly property: Property<unknown>;
  readable: boolean;
  applyRead(value: unknown): void;
  applyNotification(edt: Buffer): void;
}

class Cell<T> implements WritableStateCell<T>, AnyCell {
  // Until the profile says otherwise every tracked property is asked for. A
  // device that never answers a profile read is then still read from, which is
  // how it behaved before there were property maps to narrow this down.
  readable = true;

  private value: T | null = null;
  private settleUntil = 0;
  private readonly listeners = new Set<(value: T | null) => void>();

  constructor(
    private readonly device: EchonetDevice,
    readonly property: Property<T>,
  ) {}

  get(): T | null {
    return this.value;
  }

  onChange(listener: (value: T | null) => void): void {
    this.listeners.add(listener);
  }

  async write(value: T): Promise<void> {
    // Only reachable through DeviceState.track's writable overload, which
    // accepts nothing but a WritableProperty.
    const property = this.property as WritableProperty<T>;
    const previous = this.value;

    this.setValue(value);
    this.settleUntil = Date.now() + SET_SETTLE_MS;
    try {
      await this.device.set(property, value);
    } catch (err) {
      // The device is still whatever it was, so the optimistic update has to go
      // back. Reopening the cell to reads matters as much as the value itself:
      // leaving the window shut would ignore the next read too.
      this.settleUntil = 0;
      this.setValue(previous);
      throw err;
    }
  }

  applyRead(value: unknown): void {
    // A read that was already on its way when a write went out is carrying the
    // value from before it.
    if (Date.now() < this.settleUntil) {
      return;
    }
    // The device answered without a usable value for this property. Keeping
    // what it last said beats reporting nothing: a busy air conditioner answers
    // this way, and taking it at face value would show it as switched off.
    if (value == null) {
      return;
    }
    this.setValue(value as T);
  }

  applyNotification(edt: Buffer): void {
    const value = this.property.decode(edt);
    if (value == null) {
      return;
    }
    // Unlike a read, this is the device volunteering what it is actually doing,
    // so it wins over a value written a moment ago.
    this.settleUntil = 0;
    this.setValue(value);
  }

  private setValue(value: T | null): void {
    if (Object.is(value, this.value)) {
      return;
    }
    this.value = value;
    for (const listener of this.listeners) {
      listener(value);
    }
  }
}

// The cached state of one device, shared by every characteristic of its
// accessory.
//
// Two things follow from holding it in one place. Reads are batched: one request
// carries every property the accessory needs, instead of the one request per
// characteristic HomeKit's refresh would otherwise produce. And reads are
// shared: the burst of getters HomeKit fires when it refreshes an accessory
// collapses into a single request, and further refreshes within the cache
// lifetime into none at all.
//
// Nothing here is on a timer. Reads happen because HomeKit asked for something,
// or because the device announced a change.
export class DeviceState {
  private readonly cells: AnyCell[] = [];
  private readonly byEpc = new Map<EPC, AnyCell>();
  private readonly unsubscribe: () => void;
  private lastReadAt = 0;
  private inFlight: Promise<void> | null = null;
  private reachable = true;

  constructor(
    private readonly log: Logging,
    private readonly device: EchonetDevice,
  ) {
    this.unsubscribe = device.onNotify((notification) => this.handleNotification(notification));
  }

  track<T>(property: WritableProperty<T>): WritableStateCell<T>;
  track<T>(property: Property<T>): StateCell<T>;
  track<T>(property: Property<T>): StateCell<T> {
    const cell = new Cell(this.device, property);
    this.cells.push(cell);
    this.byEpc.set(property.epc, cell);
    return cell;
  }

  // Narrows what is read to the properties the device says it answers for, so a
  // property it does not carry is never asked for again. That removes the one
  // source of a partial Get_SNA this plugin can do something about; the rest is
  // devices being busy, which the client retries.
  applyMaps(maps: PropertyMaps): void {
    // A device that answered the profile read but reported nothing in its Get
    // map has told us nothing usable. Narrowing to that would stop reading it
    // altogether, so its properties are left as they are.
    if (maps.get.length === 0) {
      return;
    }
    for (const cell of this.cells) {
      cell.readable = supportsGet(maps, cell.property);
    }
  }

  // Called at the top of every characteristic getter. Reads only if the cache
  // has gone stale, waits only as long as HomeKit will tolerate, and never
  // rejects: the getter answers from the cache either way, and an answer that
  // arrives afterwards reaches HomeKit through onChange instead.
  async sync(): Promise<void> {
    if (Date.now() - this.lastReadAt < CACHE_TTL_MS) {
      return;
    }
    await settleWithin(this.refresh(), READ_WAIT_MS);
  }

  stop(): void {
    this.unsubscribe();
  }

  // Single-flight: concurrent callers share one request rather than each
  // starting their own.
  private refresh(): Promise<void> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async read(): Promise<void> {
    const cells = this.cells.filter((cell) => cell.readable);
    if (cells.length === 0) {
      return;
    }

    let values: readonly unknown[];
    try {
      values = await this.device.getMany(...cells.map((cell) => cell.property));
    } catch (err) {
      this.reportUnreachable(err);
      return;
    }

    this.reportReachable();
    // Stamped only on success, so a device that failed is tried again by the
    // next getter rather than being left alone for the cache lifetime.
    this.lastReadAt = Date.now();
    cells.forEach((cell, i) => cell.applyRead(values[i]));
  }

  private handleNotification(notification: Notification): void {
    for (const [epc, edt] of notification.properties) {
      this.byEpc.get(epc)?.applyNotification(edt);
    }
  }

  // A device that has gone quiet is worth one warning, not one per read. The
  // reads carry on either way; only how loudly they are reported changes.
  private reportUnreachable(err: unknown): void {
    if (this.reachable) {
      this.reachable = false;
      this.log.warn("Failed to read", this.device.logId, "- reporting its last known state:", err);
      return;
    }
    this.log.debug("Failed to read", this.device.logId, err);
  }

  private reportReachable(): void {
    if (!this.reachable) {
      this.reachable = true;
      this.log.info("Device", this.device.logId, "is answering again");
    }
  }
}
