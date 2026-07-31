import type { Logging } from "homebridge";

import type { EchonetLiteClient } from "./client.js";
import type { DiscoveredObjects } from "./types.js";

const DISCOVERY_DURATION_MS = 10 * 1000;

// Runs ECHONET Lite discovery scans: at most one at a time, ended by a timer
// after DISCOVERY_DURATION_MS, with the multicast membership renewal paused while
// the socket is busy answering the scan. Starting a scan returns right away, so
// a HomeKit write is never left waiting for the whole scan.
export class DiscoveryController {
  private discovering = false;
  private stopTimer: NodeJS.Timeout | null = null;
  private readonly stateListeners = new Set<(isDiscovering: boolean) => void>();

  constructor(
    private readonly log: Logging,
    private readonly client: EchonetLiteClient,
    // Invoked once per responding address while a scan is running.
    private readonly onObjects: (objects: DiscoveredObjects) => void,
  ) {}

  get isDiscovering(): boolean {
    return this.discovering;
  }

  // A scan also ends on its own, so anything showing the state has to follow the
  // controller instead of only its own writes.
  onStateChange(listener: (isDiscovering: boolean) => void): void {
    this.stateListeners.add(listener);
  }

  start(): void {
    if (this.discovering) {
      return;
    }
    this.setDiscovering(true);

    this.log.info("Starting discovery");

    // Renewal drops and re-adds the multicast membership, so it is paused while
    // a scan is in flight.
    this.client.stopMembershipRenewal();
    this.client.startDiscovery(this.onObjects);

    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this.stop();
    }, DISCOVERY_DURATION_MS);
  }

  stop(): void {
    if (!this.discovering) {
      return;
    }
    this.setDiscovering(false);

    // Cancelling the timer of the scan being stopped keeps it from ending a
    // later scan too early.
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }

    this.log.info("Finished discovery");

    // The scan is over, so resume the renewal that keeps notifications flowing.
    this.client.stopDiscovery();
    this.client.startMembershipRenewal();
  }

  private setDiscovering(isDiscovering: boolean): void {
    this.discovering = isDiscovering;
    for (const listener of this.stateListeners) {
      listener(isDiscovering);
    }
  }
}
