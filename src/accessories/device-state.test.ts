import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logging } from "homebridge";

import type { Notification } from "../echonet/client.js";
import { AirconOperationMode, OperationStatus, RoomTemperature, TargetTemperature } from "../echonet/codec.js";
import type { EchonetDevice } from "../echonet/device.js";
import type { EOJ } from "../echonet/types.js";
import { CACHE_TTL_MS, DeviceState, READ_WAIT_MS } from "./device-state.js";

const ADDRESS = "192.168.1.50";
const AIRCON: EOJ = [0x01, 0x30, 0x01];

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logging;

// The device is stubbed down to the three things DeviceState uses it for. What
// each property decodes an EDT into is covered by codec.test.ts; what matters
// here is which properties are asked for and where their values end up.
function createState() {
  const listeners = new Set<(notification: Notification) => void>();
  const getMany = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
  const set = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const unsubscribe = vi.fn();

  const device = {
    logId: "test device",
    getMany,
    set,
    onNotify: (listener: (notification: Notification) => void) => {
      listeners.add(listener);
      return unsubscribe;
    },
  } as unknown as EchonetDevice;

  const notify = (properties: [number, Buffer][]): void => {
    for (const listener of listeners) {
      listener({ address: ADDRESS, seoj: AIRCON, properties: new Map(properties) });
    }
  };

  return { state: new DeviceState(noopLog, device), getMany, set, unsubscribe, notify };
}

// The properties the stub was asked for by the nth read, in order.
const requested = (getMany: ReturnType<typeof vi.fn>, call = 0): unknown[] => getMany.mock.calls[call];

describe("DeviceState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads every tracked property in a single request", async () => {
    const { state, getMany } = createState();
    const power = state.track(OperationStatus);
    const temperature = state.track(RoomTemperature);
    getMany.mockResolvedValue([true, 22]);

    await state.sync();

    // The whole point: one request for the accessory, not one per characteristic.
    expect(getMany).toHaveBeenCalledTimes(1);
    expect(requested(getMany)).toEqual([OperationStatus, RoomTemperature]);
    expect(power.get()).toBe(true);
    expect(temperature.get()).toBe(22);
  });

  it("serves a second read from the cache", async () => {
    const { state, getMany } = createState();
    const power = state.track(OperationStatus);
    getMany.mockResolvedValue([true]);

    await state.sync();
    await state.sync();

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(power.get()).toBe(true);
  });

  it("collapses concurrent reads into one request", async () => {
    // HomeKit asks for every characteristic of an accessory at once, so this is
    // the ordinary case rather than a corner of one.
    const { state, getMany } = createState();
    state.track(OperationStatus);
    state.track(AirconOperationMode);
    getMany.mockResolvedValue([true, 2]);

    await Promise.all([state.sync(), state.sync(), state.sync()]);

    expect(getMany).toHaveBeenCalledTimes(1);
  });

  it("stops asking for properties the device says it does not have", async () => {
    const { state, getMany } = createState();
    state.track(OperationStatus);
    state.track(RoomTemperature);
    getMany.mockResolvedValue([true]);

    state.applyMaps({ inf: [], set: [], get: [OperationStatus.epc] });
    await state.sync();

    expect(requested(getMany)).toEqual([OperationStatus]);
  });

  it("keeps reading everything when the device reports an empty Get map", async () => {
    // An empty map is the device telling us nothing usable, not telling us it
    // supports nothing. Narrowing to it would stop reading the device at all.
    const { state, getMany } = createState();
    state.track(OperationStatus);
    getMany.mockResolvedValue([true]);

    state.applyMaps({ inf: [], set: [], get: [] });
    await state.sync();

    expect(requested(getMany)).toEqual([OperationStatus]);
  });

  it("keeps the last known value when the device answers with nothing", async () => {
    // A busy air conditioner answers a Get_SNA this way. Reporting it as
    // unavailable would show it as switched off.
    const { state, getMany } = createState();
    const power = state.track(OperationStatus);

    getMany.mockResolvedValue([true]);
    await state.sync();

    getMany.mockResolvedValue([null]);
    await state.sync();

    expect(power.get()).toBe(true);
  });

  it("keeps the last known value when the read fails", async () => {
    vi.useFakeTimers();
    const { state, getMany } = createState();
    const power = state.track(OperationStatus);

    getMany.mockResolvedValue([true]);
    await state.sync();

    vi.advanceTimersByTime(CACHE_TTL_MS);
    getMany.mockRejectedValue(new Error("no answer"));
    await state.sync();

    expect(getMany).toHaveBeenCalledTimes(2);
    expect(power.get()).toBe(true);
  });

  it("does not cache a failed read", async () => {
    const { state, getMany } = createState();
    const power = state.track(OperationStatus);

    getMany.mockRejectedValue(new Error("no answer"));
    await state.sync();
    expect(power.get()).toBeNull();

    // Nothing was learned, so the next getter reaches the device rather than
    // waiting out a cache lifetime it never earned.
    getMany.mockResolvedValue([true]);
    await state.sync();

    expect(getMany).toHaveBeenCalledTimes(2);
    expect(power.get()).toBe(true);
  });

  it("answers from the cache when the device is slow, and pushes the value when it lands", async () => {
    vi.useFakeTimers();
    const { state, getMany } = createState();
    const power = state.track(OperationStatus);
    const seen: (boolean | null)[] = [];
    power.onChange((value) => seen.push(value));

    let answer!: (values: unknown[]) => void;
    getMany.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const pending = state.sync();
    await vi.advanceTimersByTimeAsync(READ_WAIT_MS);
    // HAP-NodeJS calls a getter slow at three seconds, so waiting is bounded.
    await pending;
    expect(power.get()).toBeNull();

    answer([true]);
    await vi.advanceTimersByTimeAsync(0);
    expect(power.get()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it("reports a change once, not on every read that confirms it", async () => {
    // Every listener here ends in updateCharacteristic, which HomeKit fans out
    // to every subscribed controller.
    vi.useFakeTimers();
    const { state, getMany } = createState();
    const power = state.track(OperationStatus);
    const seen: (boolean | null)[] = [];
    power.onChange((value) => seen.push(value));
    getMany.mockResolvedValue([true]);

    await state.sync();
    // Past the cache lifetime, so this really is a second read.
    vi.advanceTimersByTime(CACHE_TTL_MS);
    await state.sync();

    expect(getMany).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([true]);
  });

  it("takes a notification as the current value", async () => {
    const { state, notify } = createState();
    const power = state.track(OperationStatus);
    const seen: (boolean | null)[] = [];
    power.onChange((value) => seen.push(value));

    notify([[OperationStatus.epc, Buffer.of(0x30)]]);

    expect(power.get()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it("ignores a notification for a property it does not track", async () => {
    const { state, notify } = createState();
    const power = state.track(OperationStatus);

    notify([[TargetTemperature.epc, Buffer.of(25)]]);

    expect(power.get()).toBeNull();
  });

  it("updates the cache before the write goes out", async () => {
    const { state, set } = createState();
    const temperature = state.track(TargetTemperature);
    const held = new Promise<void>(() => {});
    set.mockReturnValue(held);

    void temperature.write(25);

    // HomeKit reflects the change at once rather than after the round trip.
    expect(temperature.get()).toBe(25);
  });

  it("does not let a read in flight undo a value just written", async () => {
    const { state, getMany } = createState();
    const power = state.track(OperationStatus);

    await power.write(true);
    // A device goes on reporting the old value for a moment after accepting a
    // write, and a read already on its way is still carrying it.
    getMany.mockResolvedValue([false]);
    await state.sync();

    expect(power.get()).toBe(true);
  });

  it("rolls the cache back when the device refuses a write", async () => {
    const { state, getMany, set } = createState();
    const power = state.track(OperationStatus);
    getMany.mockResolvedValue([true]);
    await state.sync();

    const seen: (boolean | null)[] = [];
    power.onChange((value) => seen.push(value));
    set.mockRejectedValue(new Error("refused"));

    await expect(power.write(false)).rejects.toThrow("refused");
    expect(power.get()).toBe(true);
    expect(seen).toEqual([false, true]);
  });

  it("reopens the cell to reads after a failed write", async () => {
    const { state, getMany, set } = createState();
    const power = state.track(OperationStatus);
    set.mockRejectedValue(new Error("refused"));

    await expect(power.write(true)).rejects.toThrow("refused");
    // The settle window protects a value the device accepted. It never did, so
    // the next read has to be free to overwrite it.
    getMany.mockResolvedValue([false]);
    await state.sync();

    expect(power.get()).toBe(false);
  });

  it("unsubscribes from notifications when stopped", () => {
    const { state, unsubscribe } = createState();
    state.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
