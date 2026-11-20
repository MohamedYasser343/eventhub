import type { EventFields } from "../../validation.ts";

export interface EventItem {
  id: number;
  name: string;
  seats: number;
}

// Storage contract the service depends on. Deliberately SYNCHRONOUS: with the
// in-memory store every call is atomic on Node's single thread, which keeps the
// existing "look up again after the body arrived" no-lost-update behaviour. A
// SQL implementation would be async and needs transactions (later lecture), so
// this contract is a learning seam, not a promise of a drop-in swap (ADR-009).
export interface EventRepository {
  findById(id: number): EventItem | undefined;
  findAll(): EventItem[];
  insert(fields: EventFields, ownerId: number): EventItem;
  replace(id: number, fields: EventFields): EventItem | undefined; // undefined: no such event
  remove(id: number): boolean;
  ownerOf(id: number): number | undefined;
}

// Wraps the existing in-memory array and owner map (the same objects tests and
// the lecture 08 code already use), so behaviour is unchanged.
export class InMemoryEventRepository implements EventRepository {
  private nextId: number;
  constructor(
    private readonly items: EventItem[],
    private readonly owners: Map<number, number>,
  ) {
    // Monotonic: an id is never reused, even after its event is deleted.
    this.nextId = Math.max(0, ...items.map((e) => e.id)) + 1;
  }
  findById(id: number) {
    return this.items.find((e) => e.id === id);
  }
  findAll() {
    return [...this.items];
  }
  insert(fields: EventFields, ownerId: number) {
    const event: EventItem = { id: this.nextId++, ...fields };
    this.items.push(event);
    this.owners.set(event.id, ownerId);
    return event;
  }
  replace(id: number, fields: EventFields) {
    const index = this.items.findIndex((e) => e.id === id);
    if (index === -1) return undefined;
    const event: EventItem = { id, ...fields };
    this.items[index] = event;
    return event;
  }
  remove(id: number) {
    const index = this.items.findIndex((e) => e.id === id);
    if (index === -1) return false;
    this.items.splice(index, 1);
    this.owners.delete(id);
    return true;
  }
  ownerOf(id: number) {
    return this.owners.get(id);
  }
}
