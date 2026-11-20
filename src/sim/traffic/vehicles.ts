/**
 * Vehicle storage as a structure of arrays. A vehicle lives in a slot;
 * slots are recycled through a LIFO free list, `id` is unique for all time.
 */
export class Vehicles {
  readonly capacity: number;
  readonly alive: Uint8Array;
  readonly id: Int32Array;
  readonly lane: Int32Array;
  /** Routing destination index. */
  readonly dest: Int32Array;
  /** Resident driving this car, or -1 for through traffic. */
  readonly owner: Int32Array;
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
    this.owner = new Int32Array(capacity).fill(-1);
    this.s = new Float64Array(capacity);
    this.v = new Float64Array(capacity);
    this.acc = new Float64Array(capacity);
    this.departTime = new Float64Array(capacity);
    this.freeSlots = new Int32Array(capacity);
    for (let k = 0; k < capacity; k++) this.freeSlots[k] = capacity - 1 - k;
    this.freeTop = capacity;
  }

  /** Copy every slot and the allocator, including recycled slots and the next id. */
  copyFrom(source: Vehicles): void {
    if (this.capacity !== source.capacity) throw new Error('Vehicle capacities must match');
    this.alive.set(source.alive);
    this.id.set(source.id);
    this.lane.set(source.lane);
    this.dest.set(source.dest);
    this.owner.set(source.owner);
    this.s.set(source.s);
    this.v.set(source.v);
    this.acc.set(source.acc);
    this.departTime.set(source.departTime);
    this.freeSlots.set(source.freeSlots);
    this.freeTop = source.freeTop;
    this.nextId = source.nextId;
    this.highWater = source.highWater;
    this.count = source.count;
  }

  /** Returns the slot, or -1 when full. */
  spawn(lane: number, s: number, v: number, dest: number, time: number, owner = -1): number {
    if (this.freeTop === 0) return -1;
    const slot = this.freeSlots[--this.freeTop]!;
    this.alive[slot] = 1;
    this.id[slot] = this.nextId++;
    this.lane[slot] = lane;
    this.dest[slot] = dest;
    this.owner[slot] = owner;
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
