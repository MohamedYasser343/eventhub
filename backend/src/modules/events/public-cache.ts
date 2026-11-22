import type { Cache } from "../../cache.ts";
import type { EventItem } from "./repository.ts";

// Cache-aside for the PUBLIC event detail only (lecture 13, ADR-012).
//
// Key: event:public:v1:<id>. "public" = the one shape every caller sees today
// (id, name, seats); "v1" = the DTO version, so a changed shape never reads old bytes.
// Anything personalized or organizer-only must get its own key family, never this one.
//
// Every failure here is swallowed and counted: the caller then reads the database.
export const EVENT_KEY_PREFIX = "event:public:v1:";
export const eventKey = (id: number) => `${EVENT_KEY_PREFIX}${id}`;

export interface CacheStats {
  hits: number;
  misses: number; // includes unusable entries
  corrupt: number; // cached bytes that failed validation (counted in misses too)
  errors: number; // backend failure or timeout on get/set
  sourceReads: number; // times the primary store was read for a public get
  invalidations: number;
  invalidationErrors: number; // DEL failed after a committed write: stale until TTL
}

const fresh = (): CacheStats => ({ hits: 0, misses: 0, corrupt: 0, errors: 0, sourceReads: 0, invalidations: 0, invalidationErrors: 0 });

function parse(raw: string, id: number): EventItem | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return undefined;
    const e = v as Record<string, unknown>;
    // Exactly the public fields, and the id must be the one requested.
    if (Object.keys(e).length !== 3) return undefined;
    if (e["id"] !== id || typeof e["name"] !== "string" || !Number.isSafeInteger(e["seats"])) return undefined;
    return { id, name: e["name"], seats: e["seats"] as number };
  } catch {
    return undefined;
  }
}

export class PublicEventCache {
  readonly stats: CacheStats = fresh();

  constructor(
    private readonly backend: Cache,
    private readonly ttlSeconds: number,
    private readonly onError: (what: "get" | "set" | "del" | "corrupt", id: number) => void = () => {},
  ) {}

  resetStats(): void {
    Object.assign(this.stats, fresh());
  }

  async read(id: number): Promise<EventItem | undefined> {
    let raw: string | null;
    try {
      raw = await this.backend.get(eventKey(id));
    } catch {
      this.stats.errors++;
      this.stats.misses++;
      this.onError("get", id);
      return undefined;
    }
    if (raw === null) {
      this.stats.misses++;
      return undefined;
    }
    const event = parse(raw, id);
    if (!event) {
      this.stats.corrupt++;
      this.stats.misses++;
      this.onError("corrupt", id);
      await this.backend.del(eventKey(id)).catch(() => {}); // best effort; the refill overwrites it anyway
      return undefined;
    }
    this.stats.hits++;
    return event;
  }

  async write(event: EventItem): Promise<void> {
    try {
      await this.backend.set(eventKey(event.id), JSON.stringify({ id: event.id, name: event.name, seats: event.seats }), this.ttlSeconds);
    } catch {
      this.stats.errors++;
      this.onError("set", event.id);
    }
  }

  // Called only after the database change has committed. A failure must not turn a
  // successful mutation into an error: staleness is then bounded by the TTL.
  async invalidate(id: number): Promise<void> {
    try {
      await this.backend.del(eventKey(id));
      this.stats.invalidations++;
    } catch {
      this.stats.invalidationErrors++;
      this.onError("del", id);
    }
  }
}
