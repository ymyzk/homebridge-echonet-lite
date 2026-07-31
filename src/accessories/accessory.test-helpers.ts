import hap from "@homebridge/hap-nodejs";
import type { Characteristic, Logging, PlatformAccessory, Service, WithUUID } from "homebridge";
import { vi } from "vitest";

import type { Notification } from "../echonet/client.js";
import type { DeviceInfo, EchonetDevice } from "../echonet/device.js";
import type { EOJ } from "../echonet/types.js";
import type { ELPlatform } from "../platform.js";

// The real HAP Service and Characteristic rather than a hand-rolled stand-in.
// Which characteristics a service already carries, and what removing one does,
// is exactly what the accessories' applyProfile decides on, so a fake that got
// those semantics slightly wrong would be worse than no test at all.
export const { Service, Characteristic } = hap;

const ADDRESS = "192.168.1.50";
const AIRCON: EOJ = [0x01, 0x30, 0x01];

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logging;

// The accessory handlers under test read nothing but the property maps out of a
// profile; the info half is applyAccessoryInformation's business.
export const NO_DEVICE_INFO: DeviceInfo = {
  standardVersion: null,
  manufacturerCode: null,
  productCode: null,
  identificationNumber: null,
};

// Only what an accessory handler's constructor reaches for.
export function createPlatform(): ELPlatform {
  return { log: noopLog, Service, Characteristic } as unknown as ELPlatform;
}

// Homebridge's PlatformAccessory down to the two service methods the handlers
// use. Services are keyed by UUID, which is how the real one looks them up.
export function createAccessory(): PlatformAccessory {
  const services = new Map<string, Service>();
  return {
    getService: (type: WithUUID<typeof Service>) => services.get(type.UUID),
    addService: (type: WithUUID<typeof Service>) => {
      const service = new type();
      services.set(type.UUID, service);
      return service;
    },
  } as unknown as PlatformAccessory;
}

export function createDevice() {
  const listeners = new Set<(notification: Notification) => void>();
  const getMany = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
  const set = vi.fn<() => Promise<void>>(() => Promise.resolve());

  const device = {
    logId: "test device",
    address: ADDRESS,
    eoj: AIRCON,
    getMany,
    set,
    onNotify: (listener: (notification: Notification) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as EchonetDevice;

  const notify = (properties: [number, Buffer][]): void => {
    for (const listener of listeners) {
      listener({ address: ADDRESS, seoj: AIRCON, properties: new Map(properties) });
    }
  };

  return { device, getMany, set, notify };
}

// Drives a characteristic the way HAP does when HomeKit asks for it.
export const read = (service: Service, characteristic: WithUUID<new () => Characteristic>): Promise<unknown> =>
  service.getCharacteristic(characteristic).handleGetRequest();
