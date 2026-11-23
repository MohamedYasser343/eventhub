import { validateEventInput, validateEventPatch } from "../../validation.ts";
import type { FieldError, ListQuery, SearchQuery } from "../../validation.ts";
import type { Role } from "../../auth.ts";
import type { EventItem, EventRepository } from "./repository.ts";
import type { PublicEventCache } from "./public-cache.ts";

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
  // `publicCache` is optional: without it every read goes to the repository.
  constructor(
    private readonly repo: EventRepository,
    private readonly publicCache?: PublicEventCache,
  ) {}

  list(): Promise<EventItem[]> {
    return this.repo.findAll();
  }
  get(id: number): Promise<EventItem | undefined> {
    return this.repo.findById(id);
  }
  // Public detail read, cache-aside. ONLY the public GET uses this. Authorization,
  // edits and tickets keep using the uncached get()/repo reads, so a stale copy can
  // never decide who may edit or what may be sold. Not-found is NOT cached: ids are
  // serial, so a cached 404 would go stale the moment that event is created.
  async getPublic(id: number): Promise<EventItem | undefined> {
    const cache = this.publicCache;
    if (!cache) return this.repo.findById(id);
    const hit = await cache.read(id);
    if (hit) return hit;
    cache.stats.sourceReads++;
    const event = await this.repo.findById(id);
    if (event) await cache.write(event);
    return event;
  }
  // Collection query: authorized scope (events are public, so all) -> filter ->
  // deterministic sort (id is the unique tie-break, always ascending) -> page slice,
  // all executed by the repository. totalPages = ceil(total / limit).
  async query(q: ListQuery): Promise<{ data: EventItem[]; total: number; totalPages: number }> {
    const { data, total } = await this.repo.query(q);
    return { data, total, totalPages: Math.ceil(total / q.limit) };
  }
  // Ranked full-text search. All events are public today (no draft/cancelled state),
  // so there is no visibility filter; add it here when such a state exists.
  async search(q: SearchQuery): Promise<{ data: EventItem[]; total: number; totalPages: number }> {
    const { data, total } = await this.repo.search(q);
    return { data, total, totalPages: Math.ceil(total / q.limit) };
  }

  // Business authorization. Organizers manage only events they own.
  canCreate(actor: Actor): boolean {
    return actor.role === "organizer" || actor.role === "admin";
  }
  private async canEdit(actor: Actor, id: number): Promise<boolean> {
    return actor.role === "admin" || (actor.role === "organizer" && (await this.repo.ownerOf(id)) === actor.id);
  }

  // Cheap pre-flight (existence, then permission) so a caller can reject before
  // reading a request body. Every mutating method below re-checks, so the rule
  // holds for any caller (HTTP, CLI, job), not only the one that pre-flights.
  async authorizeEdit(actor: Actor, id: number): Promise<Outcome<EventItem>> {
    const current = await this.repo.findById(id);
    if (!current) return fail({ kind: "not-found" });
    if (!(await this.canEdit(actor, id))) return fail({ kind: "forbidden" });
    return { ok: true, value: current };
  }

  async create(actor: Actor, input: unknown): Promise<Outcome<EventItem>> {
    if (!this.canCreate(actor)) return fail({ kind: "forbidden" });
    const v = validateEventInput(input); // validate fully before touching the store
    if (!v.ok) return fail({ kind: "invalid", errors: v.errors });
    return { ok: true, value: await this.repo.insert(v.value, actor.id) };
  }

  async replace(actor: Actor, id: number, input: unknown): Promise<Outcome<EventItem>> {
    const auth = await this.authorizeEdit(actor, id);
    if (!auth.ok) return auth;
    const v = validateEventInput(input);
    if (!v.ok) return fail({ kind: "invalid", errors: v.errors });
    const event = await this.repo.replace(id, v.value);
    await this.publicCache?.invalidate(id); // after the commit; a throw above skips it
    return event ? { ok: true, value: event } : fail({ kind: "not-found" });
  }

  // Merges into the event as read just before the write, then validates the result.
  // Unlike the old synchronous store, a concurrent change between read and write can
  // be overwritten (documented in ADR-011; row locking is a later lecture).
  async patch(actor: Actor, id: number, input: unknown): Promise<Outcome<EventItem>> {
    const auth = await this.authorizeEdit(actor, id);
    if (!auth.ok) return auth;
    const v = validateEventPatch(input, auth.value);
    if (!v.ok) return fail({ kind: "invalid", errors: v.errors });
    const event = await this.repo.replace(id, v.value);
    await this.publicCache?.invalidate(id); // after the commit; a throw above skips it
    return event ? { ok: true, value: event } : fail({ kind: "not-found" });
  }

  // Existing contract: 404 is decided before the admin-only permission check.
  async remove(actor: Actor, id: number): Promise<Outcome<true>> {
    if (!(await this.repo.findById(id))) return fail({ kind: "not-found" });
    if (actor.role !== "admin") return fail({ kind: "forbidden" });
    const removed = await this.repo.remove(id);
    await this.publicCache?.invalidate(id); // after the commit; a throw above skips it
    return removed ? { ok: true, value: true } : fail({ kind: "not-found" });
  }
}
