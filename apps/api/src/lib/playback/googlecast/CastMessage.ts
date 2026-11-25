/**
 * The one message the Google Cast protocol (CASTV2) sends either way over its
 * TLS connection: a protobuf `CastMessage`, each framed by its length as a
 * 4-byte big-endian number. Findr only ever sends and reads JSON payloads, so
 * this encodes and decodes just the fields those use; binary payloads (device
 * authentication) are skipped when read.
 */

/** A Cast message with a JSON (UTF-8) payload. */
export interface CastFrame {
  /** Who sent it, such as `sender-0` or `receiver-0`, or an app's transport id. */
  sourceId: string;
  /** Who it is for; `*` broadcasts. */
  destinationId: string;
  /** What it is about, such as `urn:x-cast:com.google.cast.media`. */
  namespace: string;
  /** The JSON text. */
  payload: string;
}

/** The largest message either side may send, as Cast limits them. */
export const MAX_FRAME_BYTES = 64 * 1024;

// ---------- Field numbers ---------- //

/** `CastMessage` fields, from Chromium's `cast_channel.proto`. */
const FIELD = { protocolVersion: 1, sourceId: 2, destinationId: 3, namespace: 4, payloadType: 5, payloadUtf8: 6, payloadBinary: 7 } as const;

/** Protobuf wire types used here. */
const VARINT = 0;
const LENGTH_DELIMITED = 2;

export class CastMessage {
  // ---------- Encoding ---------- //

  /** One message, with its length prefix, ready to write to the socket. */
  public static encode(frame: CastFrame): Buffer {
    const body = Buffer.concat([
      CastMessage.varintField(FIELD.protocolVersion, 0),
      CastMessage.bytesField(FIELD.sourceId, Buffer.from(frame.sourceId)),
      CastMessage.bytesField(FIELD.destinationId, Buffer.from(frame.destinationId)),
      CastMessage.bytesField(FIELD.namespace, Buffer.from(frame.namespace)),
      CastMessage.varintField(FIELD.payloadType, 0),
      CastMessage.bytesField(FIELD.payloadUtf8, Buffer.from(frame.payload)),
    ]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, body]);
  }

  // ---------- Decoding ---------- //

  /**
   * Reads one message body (without its length prefix). Returns null for a
   * binary message, which Findr has no use for; throws on a malformed one.
   */
  public static decode(body: Buffer): CastFrame | null {
    const frame: Partial<CastFrame> = {};
    let binary = false;
    let offset = 0;

    while (offset < body.length) {
      const [key, afterKey] = CastMessage.readVarint(body, offset);
      const field = Number(key >> 3n);
      const wireType = Number(key & 7n);
      offset = afterKey;

      // Numbers: only the payload type matters
      if (wireType === VARINT) {
        const [value, next] = CastMessage.readVarint(body, offset);
        if (field === FIELD.payloadType && value !== 0n) binary = true;
        offset = next;
        continue;
      }
      if (wireType !== LENGTH_DELIMITED) throw new Error(`unexpected wire type ${wireType}`);

      // Strings and bytes
      const [length, start] = CastMessage.readVarint(body, offset);
      const end = start + Number(length);
      if (end > body.length) throw new Error("field runs past the message");
      const text = body.subarray(start, end).toString("utf8");
      if (field === FIELD.sourceId) frame.sourceId = text;
      else if (field === FIELD.destinationId) frame.destinationId = text;
      else if (field === FIELD.namespace) frame.namespace = text;
      else if (field === FIELD.payloadUtf8) frame.payload = text;
      offset = end;
    }

    if (binary) return null;
    if (frame.sourceId === undefined || frame.destinationId === undefined || frame.namespace === undefined) throw new Error("message is missing its addressing");
    return { sourceId: frame.sourceId, destinationId: frame.destinationId, namespace: frame.namespace, payload: frame.payload ?? "" };
  }

  // ---------- Inner workings ---------- //

  /** A varint field. */
  private static varintField(field: number, value: number): Buffer {
    return Buffer.concat([CastMessage.varint((field << 3) | VARINT), CastMessage.varint(value)]);
  }

  /** A length-delimited field. */
  private static bytesField(field: number, value: Buffer): Buffer {
    return Buffer.concat([CastMessage.varint((field << 3) | LENGTH_DELIMITED), CastMessage.varint(value.length), value]);
  }

  /** A non-negative number as a protobuf varint. */
  private static varint(value: number): Buffer {
    const bytes: number[] = [];
    let rest = value;
    do {
      const low = rest & 0x7f;
      rest = Math.floor(rest / 128);
      bytes.push(rest > 0 ? low | 0x80 : low);
    } while (rest > 0);
    return Buffer.from(bytes);
  }

  /** Reads a varint at `offset`, returning it and the offset after it. */
  private static readVarint(buffer: Buffer, offset: number): [bigint, number] {
    let value = 0n;
    let shift = 0n;
    for (let index = offset; index < buffer.length && shift < 70n; index++) {
      const byte = buffer[index] ?? 0;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return [value, index + 1];
      shift += 7n;
    }
    throw new Error("varint runs past the message");
  }
}
