import type { Socket } from "node:dgram";

import EL from "echonet-lite";
import type { ELData, Rinfo } from "echonet-lite";
import type { Logging } from "homebridge";
import pLimit from "p-limit";

import type { Property, PropertyWrite } from "./codec.js";
import type { DiscoveredObjects, EOJ } from "./types.js";
import { formatEOJ } from "./utils.js";

const REJOIN_INTERVAL_MS = 4 * 60 * 1000;
// How long a request waits for its response before it is given up on, so an
// unresponsive device does not hold a queue slot forever.
const REQUEST_TIMEOUT_MS = 15 * 1000;

// This plugin acts as a controller object.
const CONTROLLER_EOJ = "05ff01";
// Instance list S of the node profile, which a discovery scan asks for.
const EPC_INSTANCE_LIST = "d6";

// The service codes that answer a request. Anything else arriving with a
// matching transaction ID is not a response to it.
const RESPONSE_ESVS = new Set([EL.GET_RES, EL.SET_RES]);
const ERROR_ESVS = new Set([EL.GET_SNA, EL.SETC_SNA, EL.SETI_SNA, EL.INF_SNA, EL.SETGET_SNA]);

// The decoded values of a tuple of properties, positionally: reading
// [OperationStatus, TargetTemperature] gives back [boolean | null, number |
// null]. A null slot means the device answered without a usable value for that
// property.
export type PropertyValues<P extends readonly Property<unknown>[]> = {
  [K in keyof P]: P[K] extends Property<infer T> ? T | null : never;
};

// A property notification pushed by a device, already decoded.
export interface Notification {
  address: string;
  seoj: EOJ;
  // Keyed by EPC, holding the raw EDT. Callers decode the ones they care about.
  properties: Map<number, Buffer>;
}

interface Pending {
  eoj: string;
  resolve: (details: Record<string, string>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function toEOJ(hex: string): EOJ | null {
  const bytes = Buffer.from(hex, "hex");
  return bytes.length >= 3 ? [bytes[0], bytes[1], bytes[2]] : null;
}

function epcKey(epc: number): string {
  return epc.toString(16).padStart(2, "0");
}

// Typed, promisified wrapper around echonet-lite. The library is fire-and-forget
// with a single callback for every inbound packet, so matching a response to its
// request happens here. Get/set requests are funneled through queues to avoid
// flooding devices, and everything below is raw EDT: interpreting those bytes is
// the codec's job.
export class EchonetLiteClient {
  private readonly getQueue = pLimit(50);
  private readonly setQueue = pLimit(1);
  private readonly pending = new Map<string, Pending>();
  private readonly notifyListeners = new Set<(notification: Notification) => void>();
  private discoveryListener: ((objects: DiscoveredObjects) => void) | null = null;
  private discoveredAddresses = new Set<string>();
  private rejoinTimer: NodeJS.Timeout | null = null;
  // The receiving socket, kept from initialize() so the multicast membership
  // can be renewed without reaching for the library's module-level globals.
  private socket: Socket | null = null;

  constructor(private readonly log: Logging) {}

  async init(): Promise<void> {
    if (this.socket !== null) {
      // echonet-lite keeps its state in module-level globals, so a second
      // initialize would silently replace the first one's sockets.
      throw new Error("ECHONET Lite client is already initialized");
    }

    const socket = EL.initialize([CONTROLLER_EOJ], (rinfo, els, err) => this.handlePacket(rinfo, els, err), 4, {
      ignoreMe: true,
      // This plugin decides for itself what to read and when; the library's
      // automatic property sweep would fight the request queues.
      autoGetProperties: false,
    });
    this.socket = socket;

    socket.on("close", () => this.log.info("UDP close"));
    socket.on("error", (err) => this.log.error("UDP error:", err));

    // initialize() returns before the socket has finished binding, and sending
    // on an unbound socket is silently lost.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Tied to the socket rather than to a discovery scan: a boot that
    // restores cached accessories never scans, and it still needs the
    // membership kept alive to receive notifications.
    this.startMembershipRenewal();
  }

  close(): void {
    this.stopMembershipRenewal();
    for (const [key, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("ECHONET Lite client closed"));
      this.pending.delete(key);
    }
    if (this.socket !== null) {
      EL.release();
      this.socket = null;
    }
  }

  // Starts a discovery scan. `onObjects` is invoked once per responding address.
  startDiscovery(onObjects: (objects: DiscoveredObjects) => void): void {
    this.discoveryListener = onObjects;
    this.discoveredAddresses = new Set();
    EL.search();
  }

  stopDiscovery(): void {
    this.discoveryListener = null;
  }

  // Reads several properties in one request, which costs one round trip and one
  // queue slot no matter how many are asked for. Each slot of the result is null
  // when the device answered but had no usable value for that property, which
  // callers treat as "unavailable" rather than as an error.
  //
  // Repeating a property is harmless: it collapses to a single EPC on the wire
  // and every slot holding it decodes the same answer.
  async getProperties<P extends readonly Property<unknown>[]>(
    address: string,
    eoj: EOJ,
    ...properties: P
  ): Promise<PropertyValues<P>> {
    if (properties.length === 0) {
      // A request with no properties would put an OPC of zero on the wire.
      return [] as unknown as PropertyValues<P>;
    }

    const details = await this.getQueue(() =>
      this.request(address, eoj, EL.GET, Object.fromEntries(properties.map((property) => [epcKey(property.epc), ""]))),
    );

    // TypeScript cannot see that mapping over the tuple preserves its shape.
    return properties.map((property) => {
      const edt = details[epcKey(property.epc)];
      if (edt == null || edt === "") {
        return null;
      }
      return property.decode(Buffer.from(edt, "hex"));
    }) as PropertyValues<P>;
  }

  // Writes several properties in one request. Build each argument with the
  // codec's `write`, which type-checks the value against its property.
  async setProperties(address: string, eoj: EOJ, ...writes: PropertyWrite[]): Promise<void> {
    if (writes.length === 0) {
      return;
    }
    await this.setQueue(() =>
      this.request(
        address,
        eoj,
        EL.SETC,
        Object.fromEntries(writes.map((entry) => [epcKey(entry.epc), entry.edt.toString("hex")])),
      ),
    );
  }

  onNotify(listener: (notification: Notification) => void): () => void {
    this.notifyListeners.add(listener);
    return () => this.notifyListeners.delete(listener);
  }

  // The multicast group membership is renewed periodically because some
  // network environments silently drop it, which stops notifications.
  startMembershipRenewal(): void {
    if (this.rejoinTimer !== null) {
      return;
    }
    this.rejoinTimer = setInterval(() => {
      const socket = this.socket;
      if (socket === null) {
        return;
      }
      // "0.0.0.0" means the default interface, which is what the library binds
      // with unless a NIC has been pinned.
      const iface = EL.usingIF.v4 === "" ? undefined : EL.usingIF.v4;
      try {
        socket.dropMembership(EL.EL_Multi, iface);
        socket.addMembership(EL.EL_Multi, iface);
        this.log.debug("Renewed multicast group membership");
      } catch (error) {
        this.log.error("Failed to renew multicast group membership:", error);
      }
    }, REJOIN_INTERVAL_MS);
    this.log.info("Started multicast group renewal timer");
  }

  stopMembershipRenewal(): void {
    if (this.rejoinTimer === null) {
      return;
    }
    clearInterval(this.rejoinTimer);
    this.rejoinTimer = null;
    this.log.info("Cleared multicast membership renewal timer");
  }

  // Sends one request and resolves with the DETAILs of its response. The
  // transaction ID the library returns is a copy of the counter it put on the
  // wire, so it stays valid as a key while later requests bump that counter.
  private request(
    address: string,
    eoj: EOJ,
    esv: string,
    details: Record<string, string>,
  ): Promise<Record<string, string>> {
    const eojHex = formatEOJ(eoj).slice(2);
    return new Promise((resolve, reject) => {
      const tid = EL.sendDetails(address, CONTROLLER_EOJ, eojHex, esv, details);
      const key = `${Buffer.from(tid).toString("hex")}|${address}`;

      // A transaction ID already in flight would be overwritten below, losing
      // the earlier request forever. The counter is 16 bits, so this only
      // happens if 65536 requests are outstanding at once.
      const existing = this.pending.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.reject(new Error(`Transaction ID reused for ${address} ${eojHex}`));
      }

      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Timed out waiting for ${address} ${eojHex} after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(key, {
        eoj: eojHex,
        resolve: (value) => {
          clearTimeout(timer);
          this.pending.delete(key);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pending.delete(key);
          reject(err);
        },
        timer,
      });
    });
  }

  private handlePacket(rinfo: Rinfo, els: ELData, err: Error | null): void {
    if (err) {
      this.log.debug("Ignoring an unparsable packet from", rinfo.address, err.message);
      return;
    }

    this.resolvePending(rinfo, els);

    if (els.ESV === EL.INF || els.ESV === EL.INFC) {
      this.handleNotification(rinfo, els);
    }
    if (this.discoveryListener !== null && (els.ESV === EL.GET_RES || els.ESV === EL.INF)) {
      this.handleDiscoveryResponse(rinfo, els);
    }
  }

  // Matches a response to the request that is waiting for it. The transaction
  // ID alone is not enough: it is shared across every device this process talks
  // to and wraps around, and the plugin's own requests can carry the same one.
  private resolvePending(rinfo: Rinfo, els: ELData): void {
    const isResponse = RESPONSE_ESVS.has(els.ESV);
    const isError = ERROR_ESVS.has(els.ESV);
    if (!isResponse && !isError) {
      return;
    }
    if (els.DEOJ !== CONTROLLER_EOJ) {
      return;
    }

    const key = `${els.TID}|${rinfo.address}`;
    const entry = this.pending.get(key);
    if (!entry || entry.eoj !== els.SEOJ) {
      return;
    }

    if (isError) {
      // A Get_SNA is a partial answer rather than a failure: the properties the
      // device could not answer come back with an empty EDT, which reads as no
      // usable value just like any other empty one. Anything the device did
      // answer is still worth having, and one unsupported EPC must not cost the
      // caller the other properties in the same request. A refused write is a
      // real failure, so the Set service codes keep rejecting.
      if (els.ESV === EL.GET_SNA) {
        this.log.warn("Device", rinfo.address, els.SEOJ, "could not answer part of a get");
        entry.resolve(els.DETAILs);
        return;
      }
      entry.reject(new Error(`Device ${rinfo.address} ${els.SEOJ} rejected the request (ESV ${els.ESV})`));
      return;
    }
    entry.resolve(els.DETAILs);
  }

  private handleNotification(rinfo: Rinfo, els: ELData): void {
    if (this.notifyListeners.size === 0) {
      return;
    }
    const seoj = toEOJ(els.SEOJ);
    if (seoj === null) {
      return;
    }

    const properties = new Map<number, Buffer>();
    for (const [epc, edt] of Object.entries(els.DETAILs)) {
      if (edt !== "") {
        properties.set(parseInt(epc, 16), Buffer.from(edt, "hex"));
      }
    }
    if (properties.size === 0) {
      return;
    }

    const notification: Notification = { address: rinfo.address, seoj, properties };
    for (const listener of this.notifyListeners) {
      listener(notification);
    }
  }

  // A discovery scan reads the node profile's instance list, which names every
  // object the node hosts.
  private handleDiscoveryResponse(rinfo: Rinfo, els: ELData): void {
    const edt = els.DETAILs[EPC_INSTANCE_LIST];
    if (!edt) {
      return;
    }
    // A node answers the multicast once, but a retransmission or a concurrent
    // notification would otherwise report it twice in the same scan.
    if (this.discoveredAddresses.has(rinfo.address)) {
      return;
    }
    this.discoveredAddresses.add(rinfo.address);

    // The instance list is a count byte followed by three bytes per object,
    // which is the same layout a property map uses.
    const bytes = Buffer.from(edt, "hex");
    const count = Math.min(bytes.readUInt8(0), Math.floor((bytes.length - 1) / 3));
    const eojList: EOJ[] = [];
    for (let i = 0; i < count; i++) {
      const offset = 1 + i * 3;
      eojList.push([bytes[offset], bytes[offset + 1], bytes[offset + 2]]);
    }

    if (eojList.length === 0) {
      return;
    }
    this.log.debug("Discovered", eojList.length, "object(s) at", rinfo.address);
    this.discoveryListener?.({ address: rinfo.address, eojList });
  }
}
