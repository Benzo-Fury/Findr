/**
 * Finds Google Cast devices on the local network with an mDNS query for
 * `_googlecast._tcp.local`, sent from a port of its own so the system's mDNS
 * responder can keep 5353; devices answer a query like that straight back to
 * the asking port (RFC 6762's legacy unicast). The socket is bound to the
 * local network address so the query leaves through the LAN even when a VPN
 * holds the default route.
 *
 * Anything on the network can answer, so a device is always reached at the
 * address its answer came from, never one the answer names: otherwise one
 * device could have Findr connect anywhere, this machine included.
 */

import { createSocket } from "node:dgram";
import type { CastDevice } from "./CastLink";

/** The mDNS multicast group and port. */
const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;

/** The service every Cast device advertises. */
const SERVICE = "_googlecast._tcp.local";

/** DNS record types read here. */
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 } as const;

/** The Cast port, when an answer leaves it out. */
const DEFAULT_PORT = 8009;

/** One resource record, as far as it is read. */
interface DnsRecord {
  name: string;
  type: number;
  data: Buffer;
  /** Where `data` starts in the message, for names compressed against it. */
  dataOffset: number;
}

export class Mdns {
  /**
   * Asks for Cast devices and resolves with those that answered within
   * `timeoutMs`, one per device. Never rejects; a network that won't carry
   * multicast just finds nothing.
   */
  public static search(localAddress: string | null, timeoutMs = 2500): Promise<CastDevice[]> {
    return new Promise((resolve) => {
      const devices = new Map<string, CastDevice>();
      const socket = createSocket({ type: "udp4", reuseAddr: true });
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Already closed
        }
        resolve([...devices.values()]);
      };
      const timer = setTimeout(finish, timeoutMs);

      // Every answer describes the device that sent it
      socket.on("message", (message, sender) => {
        let device: CastDevice | null = null;
        try {
          device = Mdns.parse(message, sender.address);
        } catch {
          // A malformed answer is no device
        }
        if (device) devices.set(device.id, device);
      });
      socket.on("error", (error) => {
        console.warn("[Playback] Google Cast search failed:", error.message);
        finish();
      });

      socket.bind(0, localAddress ?? undefined, () => {
        try {
          if (localAddress) socket.setMulticastInterface(localAddress);
          socket.setMulticastTTL(255);
        } catch {
          // The default interface will do
        }

        // UDP gets lost; ask twice
        const query = Mdns.query();
        const send = () => {
          if (!finished) socket.send(query, MDNS_PORT, MDNS_ADDRESS, () => {});
        };
        send();
        setTimeout(send, 400);
      });
    });
  }

  // ---------- Messages ---------- //

  /** A query for the Cast service's PTR records. */
  public static query(): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4); // one question
    const question = Buffer.alloc(4);
    question.writeUInt16BE(TYPE.PTR, 0);
    question.writeUInt16BE(1, 2); // class IN
    return Buffer.concat([header, Mdns.encodeName(SERVICE), question]);
  }

  /**
   * Reads an answer from `sender` into the Cast device it describes, or null
   * when it describes none. The device's id and name come from its TXT
   * record, its port from its SRV record, and its address from the sender.
   */
  public static parse(message: Buffer, sender: string): CastDevice | null {
    const records = Mdns.records(message);

    // The instance the answer is about
    const instance = records.find((record) => record.type === TYPE.PTR && record.name.toLowerCase() === SERVICE);
    const instanceName = instance ? Mdns.readName(message, instance.dataOffset)[0] : records.find((record) => record.type === TYPE.TXT)?.name;
    if (!instanceName) return null;

    // Its TXT keys: id, fn (friendly name), md (model)
    const txt = records.find((record) => record.type === TYPE.TXT && record.name === instanceName);
    const keys = txt ? Mdns.readTxt(txt.data) : new Map<string, string>();
    const id = keys.get("id");
    if (!id) return null;

    // Its port
    const srv = records.find((record) => record.type === TYPE.SRV && record.name === instanceName);
    const port = srv && srv.data.length >= 6 ? srv.data.readUInt16BE(4) : DEFAULT_PORT;

    return { id, name: keys.get("fn") || keys.get("md") || "Chromecast", model: keys.get("md") || null, host: sender, port };
  }

  // ---------- Inner workings ---------- //

  /** Every resource record in a message: answers, authority and additional alike. */
  private static records(message: Buffer): DnsRecord[] {
    const questions = message.readUInt16BE(4);
    const count = message.readUInt16BE(6) + message.readUInt16BE(8) + message.readUInt16BE(10);
    let offset = 12;

    // Skip the questions
    for (let index = 0; index < questions; index++) offset = Mdns.readName(message, offset)[1] + 4;

    // Read each record's name, type and data
    const records: DnsRecord[] = [];
    for (let index = 0; index < count; index++) {
      const [name, afterName] = Mdns.readName(message, offset);
      const type = message.readUInt16BE(afterName);
      const length = message.readUInt16BE(afterName + 8);
      const dataOffset = afterName + 10;
      if (dataOffset + length > message.length) throw new Error("record runs past the message");
      records.push({ name, type, data: message.subarray(dataOffset, dataOffset + length), dataOffset });
      offset = dataOffset + length;
    }
    return records;
  }

  /** Reads a possibly compressed name at `offset`, returning it and the offset after it. */
  private static readName(message: Buffer, offset: number): [string, number] {
    const labels: string[] = [];
    let position = offset;
    let end: number | null = null;

    // Follow labels and pointers, guarding against pointer loops
    for (let hops = 0; hops < 64; hops++) {
      const length = message[position];
      if (length === undefined) throw new Error("name runs past the message");
      if (length === 0) return [labels.join("."), end ?? position + 1];
      if ((length & 0xc0) === 0xc0) {
        end ??= position + 2;
        position = message.readUInt16BE(position) & 0x3fff;
        continue;
      }
      labels.push(message.subarray(position + 1, position + 1 + length).toString("utf8"));
      position += 1 + length;
    }
    throw new Error("name has too many labels");
  }

  /** A TXT record's `key=value` strings. */
  private static readTxt(data: Buffer): Map<string, string> {
    const keys = new Map<string, string>();
    let offset = 0;
    while (offset < data.length) {
      const length = data[offset] ?? 0;
      const entry = data.subarray(offset + 1, offset + 1 + length).toString("utf8");
      const equals = entry.indexOf("=");
      if (equals > 0) keys.set(entry.slice(0, equals).toLowerCase(), entry.slice(equals + 1));
      offset += 1 + length;
    }
    return keys;
  }

  /** A name as uncompressed DNS labels. */
  private static encodeName(name: string): Buffer {
    const parts = name.split(".").map((label) => {
      const bytes = Buffer.from(label);
      return Buffer.concat([Buffer.from([bytes.length]), bytes]);
    });
    return Buffer.concat([...parts, Buffer.from([0])]);
  }
}
