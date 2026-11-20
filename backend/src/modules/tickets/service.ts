import type { EventService } from "../events/service.ts";
import type { Ticket, TicketRepository } from "./repository.ts";

export class TicketService {
  constructor(
    private readonly repo: TicketRepository,
    private readonly events: Pick<EventService, "get">,
  ) {}

  // Own tickets only: the caller id comes from the verified session, never from input.
  mine(userId: number): Ticket[] {
    return this.repo.findByUser(userId);
  }

  // Object-level check: someone else's ticket is indistinguishable from a missing one.
  ownedById(userId: number, ticketId: string): Ticket | undefined {
    return this.repo.findByUser(userId).find((t) => t.ticketId === ticketId);
  }

  // Synthetic tickets derived from the event; nothing is reserved or stored.
  // undefined when the event does not exist.
  forEvent(eventId: number): { ticketId: string; eventId: number; type: "general" }[] | undefined {
    const event = this.events.get(eventId);
    if (!event) return undefined;
    return Array.from({ length: Math.min(event.seats, 3) }, (_, i) => ({
      ticketId: `T-${eventId}-${i + 1}`,
      eventId,
      type: "general" as const,
    }));
  }
}
