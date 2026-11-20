/**
 * Vehicle storage as a structure of arrays. A vehicle lives in a slot;
 * slots are recycled through a LIFO free list, `id` is unique for all time.
 */
export class Vehicles {
  readonly capacity: number;
  readonly alive: Uint8Array;
  readonly id: Int32Array;
  readonly lane: Int32Array;
  /** Index into `Routing.sinks`. */
  readonly dest: Int32Array;
  /** Arc length of the front bumper along the lane, m. */
  readonly s: Float64Array;
  readonly v: Float64Array;
  readonly acc: Float64Array;
  readonly departTime: Float64Array;

  /** One past the highest slot ever used; iterate `[0, highWater)`. */
  highWater = 0;
  count = 0;

  private readonly freeSlots: Int32Array;
  private freeTop: number;
  private nextId = 1;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.alive = new Uint8Array(capacity);
    this.id = new Int32Array(capacity);
    this.lane = new Int32Array(capacity);
    this.dest = new Int32Array(capacity);
    this.s = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
    this.acc = new Float64Array(capacity);
    this.departTime = new Float64Array(capacity);
    this.freeSlots = new Int32Array(capacity);
    for (let k = 0; k < capacity; k++) this.freeSlots[k] = capacity - 1 - k;
    this.freeTop = capacity;
  }

  /** Returns the slot, or -1 when full. */
  spawn(lane: number, s: number, v: number, dest: number, time: number): number {
    if (this.freeTop === 0) return -1;
    const slot = this.freeSlots[--this.freeTop]!;
    this.alive[slot] = 1;
    this.id[slot] = this.nextId++;
    this.lane[slot] = lane;
    this.dest[slot] = dest;
    this.s[slot] = s;
    this.v[slot] = v;
    this.acc[slot] = 0;
    this.departTime[slot] = time;
    if (slot >= this.highWater) this.highWater = slot + 1;
    this.count++;
    return slot;
  }

  despawn(slot: number): void {
    this.alive[slot] = 0;
    this.freeSlots[this.freeTop++] = slot;
    this.count--;
  }
}
