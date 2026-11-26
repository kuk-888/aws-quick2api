/**
 * Clean-room implementation of AWS EventStream + CBOR framing
 * used by the AWS Quick bidirectional WebSocket gateway.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// --- CRC32 (IEEE 802.3) ---
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- Minimal CBOR Encoder / Decoder ---
function writeCborHead(major: number, value: number, out: number[]): void {
  const mt = major << 5;
  if (value < 24) {
    out.push(mt | value);
  } else if (value < 0x100) {
    out.push(mt | 24, value);
  } else if (value < 0x10000) {
    out.push(mt | 25, (value >> 8) & 0xff, value & 0xff);
  } else if (value < 0x100000000) {
    out.push(
      mt | 26,
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    );
  } else {
    const hi = Math.floor(value / 0x100000000);
    const lo = value >>> 0;
    out.push(
      mt | 27,
      (hi >>> 24) & 0xff,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      (lo >>> 24) & 0xff,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff,
    );
  }
}

function encodeCborValue(val: unknown, out: number[]): void {
  if (val === null || val === undefined) {
    out.push(0xf6);
    return;
  }
  if (typeof val === 'boolean') {
    out.push(val ? 0xf5 : 0xf4);
    return;
  }
  if (typeof val === 'number' && Number.isInteger(val)) {
    if (val >= 0) writeCborHead(0, val, out);
    else writeCborHead(1, -1 - val, out);
    return;
  }
  if (val instanceof Uint8Array) {
    writeCborHead(2, val.length, out);
    for (let i = 0; i < val.length; i++) out.push(val[i]);
    return;
  }
  if (typeof val === 'string') {
    const bytes = textEncoder.encode(val);
    writeCborHead(3, bytes.length, out);
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
    return;
  }
  if (Array.isArray(val)) {
    writeCborHead(4, val.length, out);
    for (const item of val) encodeCborValue(item, out);
    return;
  }
  if (typeof val === 'object') {
    const entries = Object.entries(val as Record<string, unknown>);
    writeCborHead(5, entries.length, out);
    for (const [k, v] of entries) {
      encodeCborValue(k, out);
      encodeCborValue(v, out);
    }
    return;
  }
  throw new Error(`Unsupported CBOR type: ${typeof val}`);
}

export function cborEncode(val: unknown): Uint8Array {
  const out: number[] = [];
  encodeCborValue(val, out);
  return new Uint8Array(out);
}

const MAX_CBOR_DEPTH = 32;
const MAX_CBOR_ITEMS = 65_536;
const MAX_CBOR_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_STREAM_FRAME_BYTES = 16 * 1024 * 1024;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function readCborArg(buf: Uint8Array, pos: number, ai: number): [number, number] {
  if (ai < 24) return [ai, pos];
  if (ai === 24) {
    if (pos + 1 > buf.length) throw new Error("Truncated CBOR uint8 argument");
    return [buf[pos]!, pos + 1];
  }
  if (ai === 25) {
    if (pos + 2 > buf.length) throw new Error("Truncated CBOR uint16 argument");
    return [(buf[pos]! << 8) | buf[pos + 1]!, pos + 2];
  }
  if (ai === 26) {
    if (pos + 4 > buf.length) throw new Error("Truncated CBOR uint32 argument");
    return [
      ((buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!) >>> 0,
      pos + 4,
    ];
  }
  if (ai === 27) {
    if (pos + 8 > buf.length) throw new Error("Truncated CBOR uint64 argument");
    let v = 0;
    for (let i = 0; i < 8; i++) v = v * 256 + buf[pos + i]!;
    if (!Number.isSafeInteger(v)) throw new Error("CBOR uint64 exceeds Number.MAX_SAFE_INTEGER");
    return [v, pos + 8];
  }
  throw new Error(`Unsupported CBOR additional info: ${ai}`);
}

interface CborDecodeState {
  items: number;
}

function setSafeMapProp(map: Record<string, unknown>, key: string, value: unknown): void {
  if (FORBIDDEN_OBJECT_KEYS.has(key)) return;
  Object.defineProperty(map, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function decodeCborAt(buf: Uint8Array, pos: number, depth: number, state: CborDecodeState): [unknown, number] {
  if (depth > MAX_CBOR_DEPTH) {
    throw new Error(`CBOR nesting depth exceeds limit (${MAX_CBOR_DEPTH})`);
  }
  if (++state.items > MAX_CBOR_ITEMS) {
    throw new Error(`CBOR item count exceeds limit (${MAX_CBOR_ITEMS})`);
  }
  if (pos >= buf.length) {
    throw new Error("Unexpected end of CBOR buffer");
  }
  const initial = buf[pos++]!;
  const major = initial >> 5;
  const ai = initial & 0x1f;

  if (major === 7) {
    if (ai === 20) return [false, pos];
    if (ai === 21) return [true, pos];
    if (ai === 22 || ai === 23) return [null, pos];
    throw new Error(`Unsupported CBOR simple/float: ${ai}`);
  }

  if (ai === 31) {
    if (major === 2) {
      const parts: Uint8Array[] = [];
      let total = 0;
      while (pos < buf.length && buf[pos] !== 0xff) {
        const [chunk, p] = decodeCborAt(buf, pos, depth + 1, state);
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(0);
        total += bytes.length;
        if (total > MAX_CBOR_BYTES) {
          throw new Error(`CBOR byte string exceeds limit (${MAX_CBOR_BYTES})`);
        }
        parts.push(bytes);
        pos = p;
      }
      if (pos >= buf.length || buf[pos] !== 0xff) {
        throw new Error("Unterminated indefinite-length CBOR byte string");
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const part of parts) {
        out.set(part, off);
        off += part.length;
      }
      return [out, pos + 1];
    }
    if (major === 3) {
      let str = '';
      while (pos < buf.length && buf[pos] !== 0xff) {
        const [chunk, p] = decodeCborAt(buf, pos, depth + 1, state);
        str += String(chunk ?? '');
        if (str.length > MAX_CBOR_BYTES) {
          throw new Error(`CBOR text string exceeds limit (${MAX_CBOR_BYTES})`);
        }
        pos = p;
      }
      if (pos >= buf.length || buf[pos] !== 0xff) {
        throw new Error("Unterminated indefinite-length CBOR text string");
      }
      return [str, pos + 1];
    }
    if (major === 4) {
      const arr: unknown[] = [];
      while (pos < buf.length && buf[pos] !== 0xff) {
        const [item, p] = decodeCborAt(buf, pos, depth + 1, state);
        arr.push(item);
        pos = p;
      }
      if (pos >= buf.length || buf[pos] !== 0xff) {
        throw new Error("Unterminated indefinite-length CBOR array");
      }
      return [arr, pos + 1];
    }
    if (major === 5) {
      const map: Record<string, unknown> = {};
      while (pos < buf.length && buf[pos] !== 0xff) {
        const [key, p1] = decodeCborAt(buf, pos, depth + 1, state);
        const [val, p2] = decodeCborAt(buf, p1, depth + 1, state);
        setSafeMapProp(map, String(key), val);
        pos = p2;
      }
      if (pos >= buf.length || buf[pos] !== 0xff) {
        throw new Error("Unterminated indefinite-length CBOR map");
      }
      return [map, pos + 1];
    }
    throw new Error(`Unsupported indefinite-length CBOR major type: ${major}`);
  }

  const [arg, nextPos] = readCborArg(buf, pos, ai);
  pos = nextPos;

  switch (major) {
    case 0:
      return [arg, pos];
    case 1:
      return [-1 - arg, pos];
    case 2:
      if (arg > MAX_CBOR_BYTES || pos + arg > buf.length) {
        throw new Error("CBOR byte string length out of bounds");
      }
      return [buf.slice(pos, pos + arg), pos + arg];
    case 3:
      if (arg > MAX_CBOR_BYTES || pos + arg > buf.length) {
        throw new Error("CBOR text string length out of bounds");
      }
      return [textDecoder.decode(buf.slice(pos, pos + arg)), pos + arg];
    case 4: {
      if (arg > MAX_CBOR_ITEMS || arg > buf.length - pos) {
        throw new Error("CBOR array length out of bounds");
      }
      const arr: unknown[] = [];
      for (let i = 0; i < arg; i++) {
        const [item, p] = decodeCborAt(buf, pos, depth + 1, state);
        arr.push(item);
        pos = p;
      }
      return [arr, pos];
    }
    case 5: {
      if (arg > MAX_CBOR_ITEMS || arg * 2 > buf.length - pos) {
        throw new Error("CBOR map length out of bounds");
      }
      const map: Record<string, unknown> = {};
      for (let i = 0; i < arg; i++) {
        const [k, p1] = decodeCborAt(buf, pos, depth + 1, state);
        const [v, p2] = decodeCborAt(buf, p1, depth + 1, state);
        setSafeMapProp(map, String(k), v);
        pos = p2;
      }
      return [map, pos];
    }
    default:
      throw new Error(`Unsupported CBOR major type: ${major}`);
  }
}

export function cborDecode(buf: Uint8Array): unknown {
  const [val] = decodeCborAt(buf, 0, 0, { items: 0 });
  return val;
}

// --- AWS EventStream Codec ---
const HV_STRING = 7;

export interface EventStreamMessage {
  headers: Record<string, unknown>;
  payload: Uint8Array;
}

export function encodeEventStream(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  const hdrChunks: number[] = [];
  for (const [name, val] of Object.entries(headers)) {
    const nameBytes = textEncoder.encode(name);
    const valBytes = textEncoder.encode(val);
    hdrChunks.push(nameBytes.length, ...nameBytes, HV_STRING, (valBytes.length >> 8) & 0xff, valBytes.length & 0xff, ...valBytes);
  }
  const headersLen = hdrChunks.length;
  const totalLen = 12 + headersLen + payload.length + 4;
  const frame = new Uint8Array(totalLen);
  const view = new DataView(frame.buffer);

  view.setUint32(0, totalLen, false);
  view.setUint32(4, headersLen, false);
  view.setUint32(8, crc32(frame.subarray(0, 8)), false);
  frame.set(hdrChunks, 12);
  frame.set(payload, 12 + headersLen);
  view.setUint32(totalLen - 4, crc32(frame.subarray(0, totalLen - 4)), false);
  return frame;
}

export function drainEventStream(buffer: Uint8Array, offset = 0): { messages: EventStreamMessage[]; consumed: number } {
  const messages: EventStreamMessage[] = [];
  let pos = offset;
  while (pos + 12 <= buffer.length) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + pos, 12);
    const totalLen = view.getUint32(0, false);
    const headersLen = view.getUint32(4, false);
    if (totalLen < 16 || totalLen > MAX_EVENT_STREAM_FRAME_BYTES || headersLen > totalLen - 16) {
      throw new Error(`Invalid EventStream frame dimensions (totalLen=${totalLen}, headersLen=${headersLen})`);
    }
    if (pos + totalLen > buffer.length) break;

    const headers: Record<string, unknown> = {};
    let j = pos + 12;
    const headersEnd = j + headersLen;
    while (j < headersEnd) {
      const nlen = buffer[j++]!;
      if (j + nlen >= headersEnd) break;
      const name = textDecoder.decode(buffer.subarray(j, j + nlen));
      j += nlen;
      const vt = buffer[j++]!;
      if (vt === HV_STRING) {
        if (j + 2 > headersEnd) break;
        const vlen = (buffer[j]! << 8) | buffer[j + 1]!;
        j += 2;
        if (j + vlen > headersEnd) break;
        setSafeMapProp(headers, name, textDecoder.decode(buffer.subarray(j, j + vlen)));
        j += vlen;
      } else if (vt === 0) {
        setSafeMapProp(headers, name, true);
      } else if (vt === 1) {
        setSafeMapProp(headers, name, false);
      } else if (vt === 2) {
        if (j + 1 > headersEnd) break;
        setSafeMapProp(headers, name, buffer[j++]!);
      } else if (vt === 3) {
        if (j + 2 > headersEnd) break;
        j += 2;
      } else if (vt === 4) {
        if (j + 4 > headersEnd) break;
        j += 4;
      } else if (vt === 5 || vt === 8) {
        if (j + 8 > headersEnd) break;
        j += 8;
      } else if (vt === 6) {
        if (j + 2 > headersEnd) break;
        const bl = (buffer[j]! << 8) | buffer[j + 1]!;
        if (j + 2 + bl > headersEnd) break;
        j += 2 + bl;
      } else if (vt === 9) {
        if (j + 16 > headersEnd) break;
        j += 16;
      } else {
        break;
      }
    }

    const payload = buffer.slice(headersEnd, pos + totalLen - 4);
    messages.push({ headers, payload });
    pos += totalLen;
  }
  return { messages, consumed: pos - offset };
}

export function encodeGatewayJsonFrame(obj: unknown): Uint8Array {
  const jsonBytes = textEncoder.encode(JSON.stringify(obj));
  const cborBody = cborEncode({ payload: jsonBytes });
  return encodeEventStream(
    {
      ':event-type': 'rawInputEvent',
      ':content-type': 'application/cbor',
      ':message-type': 'event',
    },
    cborBody,
  );
}

export type DecodedGatewayFrame =
  | { type: 'event'; data: Record<string, unknown> }
  | { type: 'error'; code: string; message: string };

export function decodeGatewayFrame(msg: EventStreamMessage): DecodedGatewayFrame | null {
  const mt = msg.headers[':message-type'];
  if (mt === 'error' || mt === 'exception') {
    const code = String(msg.headers[':error-code'] || msg.headers[':exception-type'] || 'unknown');
    const message = String(msg.headers[':error-message'] || '');
    return { type: 'error', code, message };
  }
  if (msg.payload.length === 0) return null;
  const decoded = cborDecode(msg.payload) as Record<string, unknown> | null;
  const inner = decoded?.payload;
  if (!inner) return null;
  const jsonStr = inner instanceof Uint8Array ? textDecoder.decode(inner) : String(inner);
  return { type: 'event', data: JSON.parse(jsonStr) as Record<string, unknown> };
}

/**
 * Cloud/Social (`/streaming/quickwork-chat-bidirectional-stream`) wire format:
 * Outbound: UTF-8 JSON `{ eventType: "rawInputEvent", payload: { payload: base64(json) } }`
 * Inbound:  EventStream frame (`:event-type = rawOutputEvent`) with UTF-8 JSON `{ payload: base64(json) }`
 */
export function encodeCloudInputFrame(obj: unknown): Uint8Array {
  const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  return textEncoder.encode(JSON.stringify({ eventType: 'rawInputEvent', payload: { payload: b64 } }));
}

export function decodeCloudOutputFrame(msg: EventStreamMessage): DecodedGatewayFrame | null {
  const mt = msg.headers[':message-type'];
  if (mt === 'error' || mt === 'exception') {
    const code = String(msg.headers[':error-code'] || msg.headers[':exception-type'] || 'unknown');
    let message = String(msg.headers[':error-message'] || '');
    if (!message && msg.payload.length > 0) {
      message = textDecoder.decode(msg.payload);
    }
    return { type: 'error', code, message };
  }
  if (msg.headers[':event-type'] !== 'rawOutputEvent' || msg.payload.length === 0) {
    return null;
  }
  const wrapper = JSON.parse(textDecoder.decode(msg.payload)) as { payload?: string };
  if (typeof wrapper?.payload !== 'string') return null;
  const innerJson = Buffer.from(wrapper.payload, 'base64').toString('utf8');
  return { type: 'event', data: JSON.parse(innerJson) as Record<string, unknown> };
}

const MAX_CHUNKED_FRAME_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKED_FRAME_PARTS = 512;
const MAX_INFLIGHT_CHUNK_GROUPS = 16;
const CHUNK_GROUP_TTL_MS = 60_000;

interface ChunkGroup {
  totalChunks: number;
  parts: Map<number, string>;
  totalBytes: number;
  createdAt: number;
  transport?: unknown;
}

/**
 * Reassembles AWS Quick S2C `_chunked_frame` fragments into the complete JSON event object.
 * Passes through all non-chunked events with zero overhead.
 */
export class ChunkedFrameAssembler {
  private readonly groups = new Map<string, ChunkGroup>();

  push(ev: Record<string, unknown>): Record<string, unknown> | null {
    if (ev.type !== '_chunked_frame') return ev;

    const chunkId = typeof ev.chunk_id === 'string' ? ev.chunk_id : '';
    const chunkIndex = typeof ev.chunk_index === 'number' ? ev.chunk_index : -1;
    const totalChunks = typeof ev.total_chunks === 'number' ? ev.total_chunks : -1;
    const data = typeof ev.data === 'string' ? ev.data : '';

    if (
      !chunkId ||
      !Number.isInteger(chunkIndex) ||
      !Number.isInteger(totalChunks) ||
      totalChunks <= 0 ||
      totalChunks > MAX_CHUNKED_FRAME_PARTS ||
      chunkIndex < 0 ||
      chunkIndex >= totalChunks
    ) {
      return null;
    }

    const now = Date.now();
    for (const [id, grp] of this.groups) {
      if (now - grp.createdAt > CHUNK_GROUP_TTL_MS) {
        this.groups.delete(id);
      }
    }

    let group = this.groups.get(chunkId);
    if (!group) {
      if (this.groups.size >= MAX_INFLIGHT_CHUNK_GROUPS) {
        const oldestKey = this.groups.keys().next().value;
        if (oldestKey) this.groups.delete(oldestKey);
      }
      group = {
        totalChunks,
        parts: new Map(),
        totalBytes: 0,
        createdAt: now,
        transport: ev._transport,
      };
      this.groups.set(chunkId, group);
    }

    if (group.totalChunks !== totalChunks) {
      this.groups.delete(chunkId);
      return null;
    }

    if (!group.parts.has(chunkIndex)) {
      const partBytes = Buffer.byteLength(data, 'utf8');
      if (group.totalBytes + partBytes > MAX_CHUNKED_FRAME_TOTAL_BYTES) {
        this.groups.delete(chunkId);
        return null;
      }
      group.parts.set(chunkIndex, data);
      group.totalBytes += partBytes;
    }
    if (ev._transport !== undefined) {
      group.transport = ev._transport;
    }

    if (group.parts.size < group.totalChunks) {
      return null;
    }

    const ordered: string[] = [];
    for (let i = 0; i < group.totalChunks; i++) {
      const part = group.parts.get(i);
      if (part === undefined) {
        this.groups.delete(chunkId);
        return null;
      }
      ordered.push(part);
    }
    const transport = group.transport;
    this.groups.delete(chunkId);

    try {
      const parsed = JSON.parse(ordered.join('')) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (parsed._transport === undefined && transport !== undefined) {
          parsed._transport = transport;
        }
        return parsed;
      }
    } catch {
      // Malformed chunked payload — drop safely
    }
    return null;
  }

  clear(): void {
    this.groups.clear();
  }
}
