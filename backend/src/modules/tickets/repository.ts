export interface Ticket {
  ticketId: string;
  eventId: number;
}

// Storage contract for tickets. Only reads exist for now (synthetic data).
export interface TicketRepository {
  findByUser(userId: number): Ticket[];
}

// Wraps the existing in-memory map (tests seed it directly).
export class InMemoryTicketRepository implements TicketRepository {
  constructor(private readonly byUser: Map<number, Ticket[]>) {}
  findByUser(userId: number): Ticket[] {
    return this.byUser.get(userId) ?? [];
  }
}
