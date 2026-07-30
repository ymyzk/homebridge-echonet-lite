// Minimal hand-written declarations for node-echonet-lite (no bundled or
// DefinitelyTyped types). Only the surface consumed by this plugin is typed.
declare module "node-echonet-lite" {
  import { EventEmitter } from "node:events";
  import type { Socket } from "node:dgram";

  // Known EDT/property payload fields used by this plugin. Payload shapes
  // vary per EPC, so all fields are optional.
  export interface ELPropertyData {
    status?: boolean;
    level?: number;
    mode?: number;
    temperature?: number;
    compressor?: boolean;
    uid?: string;
    // Property maps returned by getPropertyMaps().
    inf?: number[];
    set?: number[];
    get?: number[];
    prop?: { epc: number; edt: ELPropertyData | null; buffer: Buffer }[];
    [key: string]: unknown;
  }

  export interface ELDevice {
    address: string;
    eoj: number[][];
  }

  export interface ELMessage {
    seoj: number[];
    deoj: number[];
    data: ELPropertyData | null;
    prop?: { epc: number; edt: ELPropertyData | null; buffer: Buffer }[];
  }

  export interface ELResponse {
    device: ELDevice;
    message: ELMessage;
  }

  export default class EchonetLite extends EventEmitter {
    constructor(options: { lang?: string; type: "lan" | "serial" });
    init(callback: (err: Error | null) => void): void;
    startDiscovery(callback: (err: Error | null, res: ELResponse) => void): void;
    stopDiscovery(): void;
    getClassName(classGroupCode: number, classCode: number): string | null;
    getPropertyMaps(address: string, eoj: number[], callback: (err: Error | null, res: ELResponse) => void): void;
    getPropertyValue(
      address: string,
      eoj: number[],
      epc: number,
      callback: (err: Error | null, res: ELResponse) => void,
    ): void;
    setPropertyValue(
      address: string,
      eoj: number[],
      epc: number,
      edt: ELPropertyData,
      callback: (err: Error | null, res: ELResponse) => void,
    ): void;
    close(callback?: () => void): void;
    on(event: "notify", listener: (res: ELResponse) => void): this;
    // Private internals of the LAN transport. Used for multicast-membership
    // renewal and UDP diagnostics; may break on library upgrades.
    mELNet: {
      udp: Socket;
      _dropMembership(): void;
      _addMembership(): void;
    };
  }
}
