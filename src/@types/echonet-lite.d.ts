// Minimal hand-written declarations for echonet-lite (it ships no types, and
// there is no DefinitelyTyped package). Only the surface consumed by this
// plugin is typed; the upstream JSDoc in its index.js is the reference for
// field names.
//
// Note that the module is a single global singleton rather than a class, so
// only one ECHONET Lite stack can exist per process.
declare module "echonet-lite" {
  import type { Socket } from "node:dgram";

  // The sender of a received packet, as handed over by dgram.
  export interface Rinfo {
    address: string;
    family: "IPv4" | "IPv6";
    port: number;
    size: number;
  }

  // A parsed ECHONET Lite frame. Every field is a hex string: the library never
  // exposes buffers or numbers here.
  export interface ELData {
    // "1081" for the standard frame format.
    EHD: string;
    // Transaction ID, 4 hex characters. Echoed by the responder, which is what
    // makes it possible to match a response to its request.
    TID: string;
    // Source and destination objects, 6 hex characters each, e.g. "013001".
    SEOJ: string;
    DEOJ: string;
    // ECHONET Lite service code, 2 hex characters. Compare against the ESV
    // constants below.
    ESV: string;
    OPC: string;
    EDATA: string;
    DETAIL: string;
    // Lower-case 2-character EPC to its EDT as a hex string. An empty string
    // means the property carried no data (PDC = 0), which is how a request is
    // phrased and how an unreadable property comes back.
    DETAILs: Record<string, string>;
  }

  export interface ELOptions {
    // Pins the IPv4 interface used for sending. Left unset it becomes
    // "0.0.0.0", which still binds a fixed source port on every send.
    v4?: string;
    v6?: string;
    // Drop packets this process sent itself.
    ignoreMe?: boolean;
    // When true the library fires its own GETs for every property of every
    // device it learns about, and re-reads every EPC after each SET. This
    // plugin queues its own requests, so it must be turned off.
    autoGetProperties?: boolean;
    autoGetDelay?: number;
    debugMode?: boolean;
  }

  // Called for every valid inbound frame, including responses to requests this
  // process sent. There is no per-request callback.
  export type UserFunc = (rinfo: Rinfo, els: ELData, err: Error | null) => void;

  // A hex string ("05ff01") or a byte array ([0x05, 0xff, 0x01]).
  type EOJArg = string | number[];
  // A dotted address, or the rinfo of a packet to reply to.
  type IPArg = string | Rinfo;

  // Sends return the transaction ID as a fresh 2-byte array; it is a copy, not
  // a reference to the library's running counter, so it stays valid.
  type TID = number[];

  interface EchonetLite {
    // `objList` declares the objects this node exposes, e.g. ["05ff01"] for a
    // controller. Binding is asynchronous even though this call is not, so do
    // not send anything in the same tick.
    initialize(objList: string[], userfunc: UserFunc, ipVer?: number, options?: ELOptions): Socket;
    // Closes the sockets and clears the facilities observer.
    release(): void;
    // Multicasts a node-profile GET for d6/83/9d/9e/9f. Responses arrive
    // through the userfunc; there is no per-device callback.
    search(): void;

    sendOPC1(
      ip: IPArg,
      seoj: EOJArg,
      deoj: EOJArg,
      esv: string | number,
      epc: string | number,
      edt: string | number | number[],
    ): TID;
    // `DETAILs` maps EPC to EDT, both hex strings; "" requests a property.
    sendDetails(ip: IPArg, seoj: EOJArg, deoj: EOJArg, esv: string | number, details: Record<string, string>): TID;

    // The receiving sockets, bound to port 3610. Public, which is what makes
    // the multicast membership renewal possible without private internals.
    sock4: Socket | null;
    sock6: Socket | null;
    // The interfaces sends go out on. `v4` is "0.0.0.0" unless pinned.
    usingIF: { v4: string; v6: string };

    EL_port: number;
    EL_Multi: string;
    EL_Multi6: string;
    NODE_PROFILE: string;
    NODE_PROFILE_OBJECT: string;

    // ECHONET Lite service codes, as the 2-character hex strings that appear in
    // ELData.ESV.
    SETI_SNA: string;
    SETC_SNA: string;
    GET_SNA: string;
    INF_SNA: string;
    SETGET_SNA: string;
    SETI: string;
    SETC: string;
    GET: string;
    INF_REQ: string;
    SETGET: string;
    SET_RES: string;
    GET_RES: string;
    INF: string;
    INFC: string;
    INFC_RES: string;
    SETGET_RES: string;
  }

  const EL: EchonetLite;
  export default EL;
}
