import Bobolink from "bobolink";
import type { Logging } from "homebridge";
import EchonetLite from "node-echonet-lite";
import type { ELPropertyData, ELResponse } from "node-echonet-lite";

import type { DiscoveredObjects, EOJ } from "./types.js";

const REJOIN_INTERVAL_MS = 4 * 60 * 1000;

// Typed, promisified wrapper around node-echonet-lite. Get/set requests are
// funneled through queues to avoid flooding devices, and the private
// LAN-transport internals (UDP socket, multicast membership) are confined here.
export class EchonetLiteClient {
  private readonly el = new EchonetLite({ lang: "ja", type: "lan" });
  private readonly getQueue = new Bobolink({ concurrency: 50 });
  private readonly setQueue = new Bobolink({ concurrency: 1 });
  private rejoinTimer: NodeJS.Timeout | null = null;

  constructor(private readonly log: Logging) {}

  init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.el.init((err) => {
        if (err !== null) {
          reject(err);
          return;
        }
        const udp = this.el.mELNet.udp;
        udp.on("close", () => this.log.info("UDP close"));
        udp.on("connect", () => this.log.info("UDP connect"));
        udp.on("error", (err) => this.log.error("UDP error:", err));
        resolve();
      });
    });
  }

  // Starts a discovery scan. `onObjects` is invoked once per responding address.
  startDiscovery(onObjects: (objects: DiscoveredObjects) => void): void {
    this.el.startDiscovery((err, res) => {
      if (err) {
        this.log.error("Error in discovery:", err);
        return;
      }
      const eojList = res.device.eoj.filter((e) => e.length >= 3).map((e): EOJ => [e[0], e[1], e[2]]);
      onObjects({ address: res.device.address, eojList });
    });
  }

  stopDiscovery(): void {
    this.el.stopDiscovery();
  }

  getClassName(eoj: EOJ): string | null {
    return this.el.getClassName(eoj[0], eoj[1]);
  }

  getPropertyMaps(address: string, eoj: EOJ): Promise<ELResponse> {
    return new Promise((resolve, reject) => {
      this.el.getPropertyMaps(address, eoj, (err, res) => (err ? reject(err) : resolve(res)));
    });
  }

  getPropertyValue(address: string, eoj: EOJ, epc: number): Promise<ELResponse> {
    return this.runQueued(this.getQueue, () => {
      return new Promise((resolve, reject) => {
        this.el.getPropertyValue(address, eoj, epc, (err, res) => (err ? reject(err) : resolve(res)));
      });
    });
  }

  setPropertyValue(address: string, eoj: EOJ, epc: number, edt: ELPropertyData): Promise<ELResponse> {
    return this.runQueued(this.setQueue, () => {
      return new Promise((resolve, reject) => {
        this.el.setPropertyValue(address, eoj, epc, edt, (err, res) => (err ? reject(err) : resolve(res)));
      });
    });
  }

  onNotify(listener: (res: ELResponse) => void): void {
    this.el.on("notify", listener);
  }

  // The multicast group membership is renewed periodically because some
  // network environments silently drop it, which stops notifications.
  startMembershipRenewal(): void {
    if (this.rejoinTimer !== null) {
      return;
    }
    this.rejoinTimer = setInterval(() => {
      try {
        this.el.mELNet._dropMembership();
        this.el.mELNet._addMembership();
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

  private async runQueued(queue: Bobolink, task: () => Promise<ELResponse>): Promise<ELResponse> {
    const state = await queue.put(task);
    if (state.err !== undefined || state.res === null) {
      throw state.err ?? new Error("ECHONET Lite request failed");
    }
    return state.res;
  }
}
