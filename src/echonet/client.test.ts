import { afterEach, describe, expect, it, vi } from "vitest";

import type { Socket } from "node:dgram";

import EL from "echonet-lite";
import type { ELData, Rinfo, UserFunc } from "echonet-lite";
import type { Logging } from "homebridge";

import { EchonetLiteClient } from "./client.js";
import { AirconOperationMode, OperationStatus, TargetTemperature, write } from "./codec.js";
import type { EOJ, EPC } from "./types.js";

const DEVICE = "192.168.1.50";
const AIRCON: EOJ = [0x01, 0x30, 0x01];
const CONTROLLER = "05ff01";

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logging;

// Stands in for the dgram socket EL.initialize returns.
function fakeSocket() {
  return {
    on: () => {},
    dropMembership: vi.fn(),
    addMembership: vi.fn(),
  };
}

// A frame as echonet-lite's parser would hand it over.
function frame(overrides: Partial<ELData>): ELData {
  return {
    EHD: "1081",
    TID: "0001",
    SEOJ: "013001",
    DEOJ: CONTROLLER,
    ESV: EL.GET_RES,
    OPC: "01",
    EDATA: "",
    DETAIL: "",
    DETAILs: {},
    ...overrides,
  };
}

const rinfo = (address = DEVICE): Rinfo => ({ address, family: "IPv4", port: 3610, size: 0 });

// The request queues dispatch their task on a microtask, so a request that has
// been started but not awaited has not reached EL.sendDetails yet. setImmediate
// runs after the microtask queue drains, which puts the request on the (stubbed)
// wire before a test asserts on it or delivers its response.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Drives the client with the network stubbed out: EL.initialize hands back the
// userfunc so a test can deliver whatever frame it likes, and EL.sendDetails
// records requests instead of putting them on the wire.
async function createClient(): Promise<{
  client: EchonetLiteClient;
  deliver: UserFunc;
  sent: { ip: unknown; esv: string | number; details: Record<string, string> }[];
  socket: ReturnType<typeof fakeSocket>;
}> {
  const sent: { ip: unknown; esv: string | number; details: Record<string, string> }[] = [];
  let deliver: UserFunc | undefined;
  const socket = fakeSocket();
  let tid = 0;

  vi.spyOn(EL, "initialize").mockImplementation((_objList, userfunc) => {
    deliver = userfunc;
    // Only the membership calls are ever exercised, so a handful of stubs
    // stands in for the whole dgram socket.
    return socket as unknown as Socket;
  });
  vi.spyOn(EL, "sendDetails").mockImplementation((ip, _seoj, _deoj, esv, details) => {
    sent.push({ ip, esv, details });
    tid += 1;
    return [tid >> 8, tid & 0xff];
  });
  vi.spyOn(EL, "release").mockImplementation(() => {});
  vi.spyOn(EL, "search").mockImplementation(() => {});

  const client = new EchonetLiteClient(noopLog);
  await client.init();
  // A throw rather than an expect(): this narrows UserFunc | undefined so the
  // returned object still type-checks.
  if (!deliver) {
    throw new Error("initialize should have been given a userfunc");
  }
  return { client, deliver, sent, socket };
}

describe("EchonetLiteClient", () => {
  // restoreMocks in vitest.config.ts covers the spies, but not the timers the
  // membership renewal test enables.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a get with the decoded property", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus);
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].esv).toBe(EL.GET);
    expect(sent[0].details).toEqual({ "80": "" });

    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "30" } }), null);
    expect(await pending).toEqual([true]);
    client.close();
  });

  it("resolves to null when the device answers with no data for the property", async () => {
    const { client, deliver } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, TargetTemperature);
    await flush();
    deliver(rinfo(), frame({ TID: "0001", DETAILs: { b3: "" } }), null);
    expect(await pending).toEqual([null]);
    client.close();
  });

  it("ignores a frame whose ESV is a request rather than a response", async () => {
    // The loopback spike hit exactly this: our own outgoing GET came back with
    // the same transaction ID and consumed the pending entry.
    const { client, deliver } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus);
    await flush();

    deliver(
      rinfo(),
      frame({ TID: "0001", ESV: EL.GET, SEOJ: CONTROLLER, DEOJ: "013001", DETAILs: { "80": "" } }),
      null,
    );
    // Still waiting, so the real response can still land.
    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "31" } }), null);

    expect(await pending).toEqual([false]);
    client.close();
  });

  it("ignores a response from a different object with the same transaction ID", async () => {
    const { client, deliver } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus);
    await flush();

    deliver(rinfo(), frame({ TID: "0001", SEOJ: "029001", DETAILs: { "80": "30" } }), null);
    deliver(rinfo(), frame({ TID: "0001", SEOJ: "013001", DETAILs: { "80": "31" } }), null);

    expect(await pending).toEqual([false]);
    client.close();
  });

  it("ignores a response from a different address with the same transaction ID", async () => {
    const { client, deliver } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus);
    await flush();

    deliver(rinfo("192.168.1.99"), frame({ TID: "0001", DETAILs: { "80": "30" } }), null);
    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "31" } }), null);

    expect(await pending).toEqual([false]);
    client.close();
  });

  it("rejects when the device answers a set with an error service code", async () => {
    const { client, deliver } = await createClient();
    const pending = client.setProperties(DEVICE, AIRCON, write(TargetTemperature, 25));
    await flush();

    deliver(rinfo(), frame({ TID: "0001", ESV: EL.SETC_SNA, DETAILs: { b3: "19" } }), null);
    await expect(pending).rejects.toThrow(/rejected the request/);
    client.close();
  });

  it("reads several properties in a single request", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus, TargetTemperature);
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].esv).toBe(EL.GET);
    expect(sent[0].details).toEqual({ "80": "", b3: "" });

    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "30", b3: "19" } }), null);
    // The tuple is typed positionally, so these need no narrowing.
    const [status, temperature]: [boolean | null, number | null] = await pending;
    expect(status).toBe(true);
    expect(temperature).toBe(25);
    client.close();
  });

  it("treats a Get_SNA as a partial answer rather than a failure", async () => {
    // One unsupported property must not cost the caller the others that came
    // back in the same response.
    const { client, deliver, sent } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus, AirconOperationMode);
    await flush();

    deliver(rinfo(), frame({ TID: "0001", ESV: EL.GET_SNA, DETAILs: { "80": "30", b0: "" } }), null);
    expect(await pending).toEqual([true, null]);
    // The device told us what it knows, so there is nothing to ask again.
    expect(sent).toHaveLength(1);
    client.close();
  });

  it("retries a Get_SNA that answered nothing at all", async () => {
    // What a device says when it is too busy to look anything up. Taken at face
    // value it reads as every property being unavailable, which downstream shows
    // an air conditioner as switched off.
    const { client, deliver, sent } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus, AirconOperationMode);
    await flush();

    deliver(rinfo(), frame({ TID: "0001", ESV: EL.GET_SNA, DETAILs: { "80": "", b0: "" } }), null);
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    deliver(rinfo(), frame({ TID: "0002", DETAILs: { "80": "30", b0: "42" } }), null);
    expect(await pending).toEqual([true, 2]);
    client.close();
  });

  it("gives up on a device that stays busy", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus);
    const busy = (tid: string) => frame({ TID: tid, ESV: EL.GET_SNA, DETAILs: { "80": "" } });

    await flush();
    deliver(rinfo(), busy("0001"), null);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    deliver(rinfo(), busy("0002"), null);
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    deliver(rinfo(), busy("0003"), null);

    await expect(pending).rejects.toThrow(/answered no part of a get/);
    // Three attempts, then the caller is told rather than left waiting.
    expect(sent).toHaveLength(3);
    client.close();
  });

  it("retries a request the device did not answer in time", async () => {
    const { client, deliver, sent } = await createClient();
    // Enabled only now: init() waits on a real timer for the socket to bind.
    vi.useFakeTimers();

    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);

    // The attempt times out, then the backoff before the next one elapses.
    await vi.advanceTimersByTimeAsync(3 * 1000);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(2);

    deliver(rinfo(), frame({ TID: "0002", DETAILs: { "80": "30" } }), null);
    expect(await pending).toEqual([true]);
    client.close();
  });

  it("does not retry a write the device refused", async () => {
    // A read is worth trying again; a write is the one thing HomeKit waits on
    // end to end, and spending the budget on it outlasts its patience.
    const { client, deliver, sent } = await createClient();
    const pending = client.setProperties(DEVICE, AIRCON, write(TargetTemperature, 25));
    await flush();

    deliver(rinfo(), frame({ TID: "0001", ESV: EL.SETC_SNA, DETAILs: { b3: "" } }), null);
    await expect(pending).rejects.toThrow(/rejected the request/);
    expect(sent).toHaveLength(1);
    client.close();
  });

  it("sends one request at a time to a device, and both devices at once", async () => {
    // Asking a node for several things at once is what earns the Get_SNA above,
    // and instances 013001 and 013005 of one air conditioner share a node.
    const { client, deliver, sent } = await createClient();
    const first = client.getProperties(DEVICE, AIRCON, OperationStatus);
    const second = client.getProperties(DEVICE, [0x01, 0x30, 0x05], OperationStatus);
    const other = client.getProperties("192.168.1.51", AIRCON, OperationStatus);
    await flush();

    expect(sent).toHaveLength(2);
    expect(sent.map((request) => request.ip)).toEqual([DEVICE, "192.168.1.51"]);

    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "30" } }), null);
    expect(await first).toEqual([true]);
    deliver(rinfo("192.168.1.51"), frame({ TID: "0002", DETAILs: { "80": "30" } }), null);
    expect(await other).toEqual([true]);

    await vi.waitFor(() => expect(sent).toHaveLength(3));
    deliver(rinfo(), frame({ TID: "0003", SEOJ: "013005", DETAILs: { "80": "31" } }), null);
    expect(await second).toEqual([false]);
    client.close();
  });

  it("collapses a repeated property into one EPC and decodes it into every slot", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, TargetTemperature, TargetTemperature);
    await flush();

    expect(sent[0].details).toEqual({ b3: "" });
    deliver(rinfo(), frame({ TID: "0001", DETAILs: { b3: "19" } }), null);
    expect(await pending).toEqual([25, 25]);
    client.close();
  });

  it("sends nothing when asked for no properties", async () => {
    const { client, sent } = await createClient();
    expect(await client.getProperties(DEVICE, AIRCON)).toEqual([]);
    await client.setProperties(DEVICE, AIRCON);
    await flush();

    expect(sent).toHaveLength(0);
    client.close();
  });

  it("encodes a set and waits for the response", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.setProperties(DEVICE, AIRCON, write(TargetTemperature, 25));
    await flush();

    expect(sent[0].esv).toBe(EL.SETC);
    expect(sent[0].details).toEqual({ b3: "19" });

    deliver(rinfo(), frame({ TID: "0001", ESV: EL.SET_RES, DETAILs: { b3: "" } }), null);
    await pending;
    client.close();
  });

  it("writes several properties in a single request", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.setProperties(
      DEVICE,
      AIRCON,
      write(OperationStatus, true),
      write(TargetTemperature, 25),
      write(AirconOperationMode, 2),
    );
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].esv).toBe(EL.SETC);
    expect(sent[0].details).toEqual({ "80": "30", b3: "19", b0: "42" });

    deliver(rinfo(), frame({ TID: "0001", ESV: EL.SET_RES, DETAILs: { "80": "", b3: "", b0: "" } }), null);
    await pending;
    client.close();
  });

  it("delivers notifications only for the matching device", async () => {
    const { client, deliver } = await createClient();
    const seen: EPC[][] = [];
    client.onNotify((n) => seen.push([...n.properties.keys()]));

    deliver(rinfo(), frame({ ESV: EL.INF, SEOJ: "013001", DEOJ: CONTROLLER, DETAILs: { "80": "30", b3: "19" } }), null);
    expect(seen).toEqual([[0x80, 0xb3]]);
    client.close();
  });

  it("stops delivering notifications after unsubscribing", async () => {
    const { client, deliver } = await createClient();
    let count = 0;
    const unsubscribe = client.onNotify(() => count++);

    deliver(rinfo(), frame({ ESV: EL.INF, DETAILs: { "80": "30" } }), null);
    unsubscribe();
    deliver(rinfo(), frame({ ESV: EL.INF, DETAILs: { "80": "30" } }), null);

    expect(count).toBe(1);
    client.close();
  });

  it("parses the instance list into discovered objects, once per address", async () => {
    const { client, deliver } = await createClient();
    const discovered: { address: string; eojList: EOJ[] }[] = [];
    client.startDiscovery((objects) => discovered.push(objects));

    // Two objects: an air conditioner and a general lighting device.
    const instanceList = "02" + "013001" + "029001";
    deliver(rinfo(), frame({ SEOJ: "0ef001", DETAILs: { d6: instanceList } }), null);
    // A retransmission of the same answer must not report the node twice.
    deliver(rinfo(), frame({ SEOJ: "0ef001", DETAILs: { d6: instanceList } }), null);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toEqual({
      address: DEVICE,
      eojList: [
        [0x01, 0x30, 0x01],
        [0x02, 0x90, 0x01],
      ],
    });
    client.close();
  });

  it("stops reporting discoveries once the scan is stopped", async () => {
    const { client, deliver } = await createClient();
    let count = 0;
    client.startDiscovery(() => count++);
    client.stopDiscovery();

    deliver(rinfo(), frame({ SEOJ: "0ef001", DETAILs: { d6: "01013001" } }), null);
    expect(count).toBe(0);
    client.close();
  });

  it("renews the multicast membership by dropping and re-adding it", async () => {
    const { client, socket } = await createClient();
    // init() already scheduled the renewal on the real clock, so drop that
    // interval and reschedule it once time is under this test's control.
    client.stopMembershipRenewal();
    // clearInterval has to be faked alongside setInterval: stopMembershipRenewal
    // below has to actually cancel the fake interval for the last assertion.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    client.startMembershipRenewal();

    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(socket.dropMembership).toHaveBeenCalledTimes(1);
    expect(socket.addMembership).toHaveBeenCalledTimes(1);
    // Dropping before re-adding is the whole point: a membership a router has
    // silently forgotten is only restored by rejoining it.
    expect(socket.dropMembership.mock.calls[0]).toEqual([EL.EL_Multi, undefined]);

    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(socket.addMembership).toHaveBeenCalledTimes(2);

    client.stopMembershipRenewal();
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(socket.addMembership).toHaveBeenCalledTimes(2);
    client.close();
  });

  it("rejects everything still in flight when closed", async () => {
    const { client } = await createClient();
    const pending = client.getProperties(DEVICE, AIRCON, OperationStatus);
    await flush();
    client.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("rejects a request still queued behind another when closed", async () => {
    // Left to run, it would send on a socket that has already been released and
    // then sit there until its own timeout expired.
    const { client, sent } = await createClient();
    const inFlight = client.getProperties(DEVICE, AIRCON, OperationStatus);
    const queued = client.getProperties(DEVICE, AIRCON, TargetTemperature);
    await flush();
    expect(sent).toHaveLength(1);

    client.close();
    await expect(inFlight).rejects.toThrow(/closed/);
    await expect(queued).rejects.toThrow(/closed/);
    expect(sent).toHaveLength(1);
  });

  it("refuses a second initialize, which would replace the singleton's sockets", async () => {
    const { client } = await createClient();
    await expect(client.init()).rejects.toThrow(/already initialized/);
    client.close();
  });
});
