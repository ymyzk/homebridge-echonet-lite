import type { Logging } from "homebridge";

import type { EchonetLiteClient } from "./echonet-lite.js";
import type { DiscoveredDevice } from "./types.js";

const DISCOVERY_TIMEOUT_MS = 10 * 1000;

// Runs ECHONET Lite discovery scans: at most one at a time, ended by a timer
// after DISCOVERY_TIMEOUT_MS, with the multicast membership renewal paused while
// the socket is busy answering the scan. Starting a scan returns right away, so
// a HomeKit write is never left waiting for the whole scan.
export class DiscoveryController {
  private isDiscovering = false;
  private stopTimer: NodeJS.Timeout | null = null;
  private readonly stateListeners = new Set<(isDiscovering: boolean) => void>();

  constructor(
    private readonly log: Logging,
    private readonly el: EchonetLiteClient,
    // Invoked once per responding node while a scan is running.
    private readonly onDevice: (device: DiscoveredDevice) => void,
  ) {}

  get discovering(): boolean {
    return this.isDiscovering;
  }

  // A scan also ends on its own, so anything showing the state has to follow the
  // controller instead of only its own writes.
  onStateChange(listener: (isDiscovering: boolean) => void): void {
    this.stateListeners.add(listener);
  }

  start(): void {
    if (this.isDiscovering) {
      return;
    }
    this.setDiscovering(true);

    this.log.info("Starting discovery");
    this.el.stopMembershipRenewal();
    this.el.startDiscovery(this.onDevice);

    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this.stop();
    }, DISCOVERY_TIMEOUT_MS);
  }

  stop(): void {
    if (!this.isDiscovering) {
      return;
    }
    this.setDiscovering(false);

    // Cancelling the timer of the scan being stopped keeps it from ending a
    // later scan too early.
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    // After stopping discovery, el would listen to broadcast.
    this.log.info("Finished discovery");
    this.el.stopDiscovery();
    this.el.startMembershipRenewal();
  }

  private setDiscovering(value: boolean): void {
    this.isDiscovering = value;
    for (const listener of this.stateListeners) {
      listener(value);
    }
  }
}
