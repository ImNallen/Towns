import type { SnapshotIO } from '../sim/snapshot';
import type { World } from '../sim/world';

function bytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Collect views synchronously, then freeze them into one buffer before compression yields. */
class Writer implements SnapshotIO {
  readonly mode = 'write';
  readonly parts: Uint8Array[] = [];
  length = 0;

  arrays(...views: ArrayBufferView[]) {
    for (const view of views) {
      this.parts.push(bytes(view));
      this.length += view.byteLength;
    }
  }
  table(rows: readonly ArrayBufferView[]) {
    const width = rows[0]?.byteLength ?? 0;
    const columns = new Uint8Array(width * rows.length);
    // Adjacent destinations often share lane costs. Group like bytes so gzip
    // can find those runs even when a whole routing table spans many MiB.
    for (let r = 0; r < rows.length; r++) {
      const row = bytes(rows[r]!);
      for (let c = 0; c < width; c++) columns[c * rows.length + r] = row[c]!;
    }
    this.arrays(columns);
  }
  number(value: number) {
    this.arrays(Float64Array.of(value));
    return value;
  }
  strings(values: string[]) {
    const text = new TextEncoder().encode(JSON.stringify(values));
    this.number(text.length);
    this.arrays(text);
  }
  finish() {
    const buffer = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      buffer.set(part, offset);
      offset += part.length;
    }
    return buffer;
  }
}

class Reader implements SnapshotIO {
  readonly mode = 'read';
  offset = 0;
  constructor(readonly buffer: Uint8Array) {}

  private take(count: number) {
    if (!Number.isSafeInteger(count) || count < 0 || this.offset + count > this.buffer.length)
      throw new Error('Invalid snapshot field length.');
    const start = this.offset;
    this.offset += count;
    return this.buffer.subarray(start, this.offset);
  }
  arrays(...views: ArrayBufferView[]) {
    for (const view of views) bytes(view).set(this.take(view.byteLength));
  }
  table(rows: readonly ArrayBufferView[]) {
    const width = rows[0]?.byteLength ?? 0;
    const columns = this.take(width * rows.length);
    for (let r = 0; r < rows.length; r++) {
      const row = bytes(rows[r]!);
      for (let c = 0; c < width; c++) row[c] = columns[c * rows.length + r]!;
    }
  }
  number() {
    const b = this.take(8);
    const value = new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
    if (!Number.isFinite(value)) throw new Error('Invalid snapshot number.');
    return value;
  }
  strings(values: string[]) {
    const text: unknown = JSON.parse(new TextDecoder().decode(this.take(this.number())));
    if (!Array.isArray(text) || text.length !== values.length || !text.every(s => s === null || typeof s === 'string'))
      throw new Error('Invalid town event log.');
    for (let i = 0; i < text.length; i++) {
      if (text[i] === null) delete values[i];
      else values[i] = text[i];
    }
  }
}

function base64(data: Uint8Array) {
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 32768) chunks.push(String.fromCharCode(...data.subarray(i, i + 32768)));
  return btoa(chunks.join(''));
}

export async function packWorld(world: World): Promise<string> {
  const writer = new Writer();
  world.snapshotState(writer);
  const stream = new Blob([writer.finish()]).stream().pipeThrough(new CompressionStream('gzip'));
  return base64(new Uint8Array(await new Response(stream).arrayBuffer()));
}

export async function unpackWorld(world: World, encoded: string, signal?: AbortSignal) {
  // Size the output against the constructed world's arrays, independent of claims in the file.
  let size = 0;
  world.snapshotState({
    mode: 'measure',
    arrays(...views) { for (const v of views) size += v.byteLength; },
    table(rows) { for (const v of rows) size += v.byteLength; },
    number(value) { size += 8; return value; },
    strings() { size += 8; },
  });
  const limit = size + 65536; // variable-length names in the town event ring
  if (encoded.length > Math.ceil((limit * 1.01 + 256) / 3) * 4) throw new Error('Invalid compressed snapshot size.');
  const raw = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const buffer = new Uint8Array(limit);
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > limit) throw new Error('Snapshot exceeds the expected world size.');
      buffer.set(value, length);
      length += value.length;
    }
  } finally {
    await reader.cancel();
  }
  const state = new Reader(buffer.subarray(0, length));
  world.snapshotState(state);
  if (state.offset !== length) throw new Error('Unexpected trailing snapshot data.');
}
