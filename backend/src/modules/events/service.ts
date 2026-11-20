import { validateEventInput, validateEventPatch } from "../../validation.ts";
import type { FieldError, ListQuery } from "../../validation.ts";
import type { Role } from "../../auth.ts";
import type { EventItem, EventRepository } from "./repository.ts";

// Application layer for events. Knows nothing about HTTP: no req/res, no status
// codes. It returns typed outcomes; the controller maps them to responses.
export interface Actor {
  id: number;
  role: Role;
}
export type EventError =
  | { kind: "not-found" }
  | { kind: "forbidden" }
  | { kind: "invalid"; errors: FieldError[] };
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: EventError };

const fail = (error: EventError): { ok: false; error: EventError } => ({ ok: false, error });

export class EventService {
  constructor(private readonly repo: EventRepository) {}

  list(): EventItem[] {
    return this.repo.findAll();
  }
  get(id: number): EventItem | undefined {
    return this.repo.findById(id);
  }
  // Collection query: authorized scope (events are public, so all) -> filter ->
  // deterministic sort (id is the unique tie-break, always ascending) -> page slice.
  // total counts every matching event BEFORE slicing; totalPages = ceil(total/limit).
  query(q: ListQuery): { data: EventItem[]; total: number; totalPages: number } {
    const needle = q.q?.toLowerCase();
    const matching = this.repo.findAll().filter(
      (e) => (needle === undefined || e.name.toLowerCase().includes(needle)) && (q.minSeats === null || e.seats >= q.minSeats),
    );
    matching.sort((a, b) => {
      const x = a[q.sort.field];
      const y = b[q.sort.field];
      return (x < y ? -q.sort.direction : x > y ? q.sort.direction : 0) || a.id - b.id;
    });
    return {
      data: matching.slice(q.offset, q.offset + q.limit),
      total: matching.length,
      totalPages: Math.ceil(matching.length / q.limit),
    };
  }
  search(needle: string): EventItem[] {
    const n = needle.toLowerCase();
    return this.repo.findAll().filter((e) => e.name.toLowerCase().includes(n));
  }

  // Business authorization. Organizers manage only events they own.
  canCreate(actor: Actor): boolean {
    return actor.role === "organizer" || actor.role === "admin";
  }
  private canEdit(actor: Actor, id: number): boolean {
    return actor.role === "admin" || (actor.role === "organizer" && this.repo.ownerOf(id) === actor.id);
  }

  // Cheap pre-flight (existence, then permission) so a caller can reject before
  // reading a request body. Every mutating method below re-checks, so the rule
  // holds for any caller (HTTP, CLI, job), not only the one that pre-flights.
  authorizeEdit(actor: Actor, id: number): Outcome<EventItem> {
    const current = this.repo.findById(id);
    if (!current) return fail({ kind: "not-found" });
    if (!this.canEdit(actor, id)) return fail({ kind: "forbidden" });
    return { ok: true, value: current };
  }

  create(actor: Actor, input: unknown): Outcome<EventItem> {
    if (!this.canCreate(actor)) return fail({ kind: "forbidden" });
    const v = validateEventInput(input); // validate fully before touching the store
    if (!v.ok) return fail({ kind: "invalid", errors: v.errors });
    return { ok: true, value: this.repo.insert(v.value, actor.id) };
  }

  replace(actor: Actor, id: number, input: unknown): Outcome<EventItem> {
    const auth = this.authorizeEdit(actor, id);
    if (!auth.ok) return auth;
    const v = validateEventInput(input);
    if (!v.ok) return fail({ kind: "invalid", errors: v.errors });
    const event = this.repo.replace(id, v.value);
    return event ? { ok: true, value: event } : fail({ kind: "not-found" });
  }

  // Merges into the event as it is NOW (no lost update), then validates the result.
  patch(actor: Actor, id: number, input: unknown): Outcome<EventItem> {
    const auth = this.authorizeEdit(actor, id);
    if (!auth.ok) return auth;
    const v = validateEventPatch(input, auth.value);
    if (!v.ok) return fail({ kind: "invalid", errors: v.errors });
    const event = this.repo.replace(id, v.value);
    return event ? { ok: true, value: event } : fail({ kind: "not-found" });
  }

  // Existing contract: 404 is decided before the admin-only permission check.
  remove(actor: Actor, id: number): Outcome<true> {
    if (!this.repo.findById(id)) return fail({ kind: "not-found" });
    if (actor.role !== "admin") return fail({ kind: "forbidden" });
    return this.repo.remove(id) ? { ok: true, value: true } : fail({ kind: "not-found" });
  }
}
