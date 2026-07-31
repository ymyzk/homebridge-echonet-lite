import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import EL from "echonet-lite";
import type { ELData, Rinfo, UserFunc } from "echonet-lite";
import type { Logging } from "homebridge";

import { OperationStatus, TargetTemperature } from "./codec.js";
import { EchonetLiteClient } from "./echonet-lite.js";
import type { EchonetLiteClientOptions } from "./echonet-lite.js";
import type { EOJ } from "./types.js";

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
    dropMembership: mock.fn(),
    addMembership: mock.fn(),
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

// Drives the client with the network stubbed out: EL.initialize hands back the
// userfunc so a test can deliver whatever frame it likes, and EL.sendDetails
// records requests instead of putting them on the wire.
async function createClient(
  options: EchonetLiteClientOptions = {},
  log: Logging = noopLog,
): Promise<{
  client: EchonetLiteClient;
  deliver: UserFunc;
  sent: { ip: unknown; esv: string; details: Record<string, string> }[];
  socket: ReturnType<typeof fakeSocket>;
}> {
  const sent: { ip: unknown; esv: string; details: Record<string, string> }[] = [];
  let deliver: UserFunc | undefined;
  const socket = fakeSocket();
  let tid = 0;

  mock.method(EL, "initialize", (_objList: string[], userfunc: UserFunc) => {
    deliver = userfunc;
    return socket;
  });
  mock.method(
    EL,
    "sendDetails",
    (ip: unknown, _seoj: unknown, _deoj: unknown, esv: string, details: Record<string, string>) => {
      sent.push({ ip, esv, details });
      tid += 1;
      return [tid >> 8, tid & 0xff];
    },
  );
  mock.method(EL, "release", () => {});
  mock.method(EL, "search", () => {});

  const client = new EchonetLiteClient(log, options);
  await client.init();
  assert.ok(deliver, "initialize should have been given a userfunc");
  return { client, deliver, sent, socket };
}

describe("EchonetLiteClient", () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it("resolves a get with the decoded property", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.getProperty(DEVICE, AIRCON, OperationStatus);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].esv, EL.GET);
    assert.deepEqual(sent[0].details, { "80": "" });

    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "30" } }), null);
    assert.equal(await pending, true);
    client.close();
  });

  it("resolves to null when the device answers with no data for the property", async () => {
    const { client, deliver } = await createClient();
    const pending = client.getProperty(DEVICE, AIRCON, TargetTemperature);
    deliver(rinfo(), frame({ TID: "0001", DETAILs: { b3: "" } }), null);
    assert.equal(await pending, null);
    client.close();
  });

  it("ignores a frame whose ESV is a request rather than a response", async () => {
    // The loopback spike hit exactly this: our own outgoing GET came back with
    // the same transaction ID and consumed the pending entry.
    const { client, deliver } = await createClient();
    const pending = client.getProperty(DEVICE, AIRCON, OperationStatus);

    deliver(
      rinfo(),
      frame({ TID: "0001", ESV: EL.GET, SEOJ: CONTROLLER, DEOJ: "013001", DETAILs: { "80": "" } }),
      null,
    );
    // Still waiting, so the real response can still land.
    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "31" } }), null);

    assert.equal(await pending, false);
    client.close();
  });

  it("ignores a response from a different object with the same transaction ID", async () => {
    const { client, deliver } = await createClient();
    const pending = client.getProperty(DEVICE, AIRCON, OperationStatus);

    deliver(rinfo(), frame({ TID: "0001", SEOJ: "029001", DETAILs: { "80": "30" } }), null);
    deliver(rinfo(), frame({ TID: "0001", SEOJ: "013001", DETAILs: { "80": "31" } }), null);

    assert.equal(await pending, false);
    client.close();
  });

  it("ignores a response from a different address with the same transaction ID", async () => {
    const { client, deliver } = await createClient();
    const pending = client.getProperty(DEVICE, AIRCON, OperationStatus);

    deliver(rinfo("192.168.1.99"), frame({ TID: "0001", DETAILs: { "80": "30" } }), null);
    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "31" } }), null);

    assert.equal(await pending, false);
    client.close();
  });

  it("rejects when the device answers with an error service code", async () => {
    const { client, deliver } = await createClient();
    const pending = client.getProperty(DEVICE, AIRCON, OperationStatus);

    deliver(rinfo(), frame({ TID: "0001", ESV: EL.GET_SNA, DETAILs: { "80": "" } }), null);
    await assert.rejects(pending, /rejected the request/);
    client.close();
  });

  it("encodes a set and waits for the response", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.setProperty(DEVICE, AIRCON, TargetTemperature, 25);

    assert.equal(sent[0].esv, EL.SETC);
    assert.deepEqual(sent[0].details, { b3: "19" });

    deliver(rinfo(), frame({ TID: "0001", ESV: EL.SET_RES, DETAILs: { b3: "" } }), null);
    await pending;
    client.close();
  });

  it("expands property maps into EPC lists", async () => {
    const { client, deliver, sent } = await createClient();
    const pending = client.getPropertyMaps(DEVICE, AIRCON);

    assert.deepEqual(sent[0].details, { "9d": "", "9e": "", "9f": "" });
    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "9d": "0280b0", "9e": "01b3", "9f": "0380b0bb" } }), null);

    assert.deepEqual(await pending, { inf: [0x80, 0xb0], set: [0xb3], get: [0x80, 0xb0, 0xbb] });
    client.close();
  });

  it("delivers notifications only for the matching device", async () => {
    const { client, deliver } = await createClient();
    const seen: number[][] = [];
    client.onNotify((n) => seen.push([...n.properties.keys()]));

    deliver(rinfo(), frame({ ESV: EL.INF, SEOJ: "013001", DEOJ: CONTROLLER, DETAILs: { "80": "30", b3: "19" } }), null);
    assert.deepEqual(seen, [[0x80, 0xb3]]);
    client.close();
  });

  it("stops delivering notifications after unsubscribing", async () => {
    const { client, deliver } = await createClient();
    let count = 0;
    const unsubscribe = client.onNotify(() => count++);

    deliver(rinfo(), frame({ ESV: EL.INF, DETAILs: { "80": "30" } }), null);
    unsubscribe();
    deliver(rinfo(), frame({ ESV: EL.INF, DETAILs: { "80": "30" } }), null);

    assert.equal(count, 1);
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

    assert.equal(discovered.length, 1);
    assert.deepEqual(discovered[0], {
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
    assert.equal(count, 0);
    client.close();
  });

  it("renews the multicast membership by dropping and re-adding it", async (t) => {
    const { client, socket } = await createClient();
    // init() already scheduled the renewal on the real clock, so drop that
    // interval and reschedule it once time is under this test's control.
    client.stopMembershipRenewal();
    t.mock.timers.enable({ apis: ["setInterval"] });
    client.startMembershipRenewal();

    t.mock.timers.tick(4 * 60 * 1000);
    assert.equal(socket.dropMembership.mock.callCount(), 1);
    assert.equal(socket.addMembership.mock.callCount(), 1);
    // Dropping before re-adding is the whole point: a membership a router has
    // silently forgotten is only restored by rejoining it.
    assert.deepEqual(socket.dropMembership.mock.calls[0].arguments, [EL.EL_Multi, undefined]);

    t.mock.timers.tick(4 * 60 * 1000);
    assert.equal(socket.addMembership.mock.callCount(), 2);

    client.stopMembershipRenewal();
    t.mock.timers.tick(4 * 60 * 1000);
    assert.equal(socket.addMembership.mock.callCount(), 2);
    client.close();
  });

  it("rejects everything still in flight when closed", async () => {
    const { client } = await createClient();
    const pending = client.getProperty(DEVICE, AIRCON, OperationStatus);
    client.close();
    await assert.rejects(pending, /closed/);
  });

  it("holds back gets beyond the configured concurrency", async () => {
    const { client, deliver, sent } = await createClient({ getConcurrency: 1 });
    const first = client.getProperty(DEVICE, AIRCON, OperationStatus);
    const second = client.getProperty(DEVICE, AIRCON, TargetTemperature);

    // The second request is still queued, so nothing went out for it yet.
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].details, { "80": "" });

    deliver(rinfo(), frame({ TID: "0001", DETAILs: { "80": "30" } }), null);
    assert.equal(await first, true);

    // Freeing the slot releases the queued request.
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1].details, { b3: "" });
    deliver(rinfo(), frame({ TID: "0002", DETAILs: { b3: "19" } }), null);
    assert.equal(await second, 25);
    client.close();
  });

  it("falls back to the default concurrency when the configured value is unusable", async () => {
    const warnings: unknown[][] = [];
    const log = { ...noopLog, warn: (...args: unknown[]) => warnings.push(args) } as unknown as Logging;
    const { client, sent } = await createClient({ getConcurrency: 0 }, log);

    const first = client.getProperty(DEVICE, AIRCON, OperationStatus);
    const second = client.getProperty(DEVICE, AIRCON, TargetTemperature);

    // A concurrency of 0 would have stalled the queue outright.
    assert.equal(sent.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(" "), /Ignoring invalid getConcurrency/);

    client.close();
    await assert.rejects(first, /closed/);
    await assert.rejects(second, /closed/);
  });

  it("refuses a second initialize, which would replace the singleton's sockets", async () => {
    const { client } = await createClient();
    await assert.rejects(client.init(), /already initialized/);
    client.close();
  });
});
