# EventHub — product specification

Status: target product vision, **not implemented functionality**.

## Goal
A complete platform for discovering, organizing and booking events, built incrementally to learn backend engineering before building the user interface.

## Actors and capabilities
| Actor | Eventual capabilities |
| --- | --- |
| Attendee | Register, sign in, browse/search published events, reserve tickets, complete simulated checkout, access own tickets, cancel eligible reservations. |
| Organizer | Create/edit/publish/cancel owned events, configure capacity and ticket types, inspect bookings and check in valid tickets. |
| Admin | Moderate events and accounts, investigate booking issues and view operational metrics. |

## Domain model (conceptual only)
User, Event, TicketType, Reservation, Booking, PaymentAttempt, Ticket, CheckIn, Notification. Do not create schema before database milestone. Event time zone is explicit; timestamps use UTC internally when persistence is added. Amounts use integer minor units plus currency. Roles and ownership are enforced in the backend; frontend visibility is not permission.

## Core workflow
Organizer publishes event -> attendee discovers it -> reserves quantity -> mock payment succeeds or reservation expires -> booking confirmed and ticket issued -> confirmation delivered -> organizer validates ticket at check-in.

## Business invariants (introduced progressively)
- Only published, eligible events can be booked; quantities are positive and within available inventory.
- Confirmed sales plus active reservations must not exceed available capacity. Reservation expiry releases inventory exactly once; database is authoritative once introduced.
- State transitions are explicit: reservation active -> confirmed/expired/cancelled; confirmed booking issues tickets only once. Failed/late payment must not silently oversell.
- Payment is simulated. Repeated callbacks/retries must not create duplicate bookings, charges or tickets once idempotency is introduced.
- Ticket belongs to a confirmed booking; check-in must reject invalid, revoked and previously used tickets. Organizer can access only owned resources.
- Cancellation/refund policy and reserved seating are later design decisions; start with general admission, no actual money or sensitive card data.

## Non-functional targets
Correctness first, least privilege, validated inputs, observable failures, reproducible local setup, measured performance, graceful recovery. Final stress exercise: limited inventory against increasing concurrent traffic with zero overselling/duplicate confirmation; record hardware, workload, latency and actual outcomes, not invented results. Scale loads gradually.

## Scope boundaries
During course: backend only; manual HTTP clients as needed. After course and owner approval: attendee UI, organizer dashboard and admin interface, accessible responsive design, frontend/API integration and full-stack E2E tests. Deployment is a later milestone. Real payments, complex seat maps, multi-region architecture and paid infrastructure are not initial requirements.

## Technology
No fixed final stack. Recommended initial exercise: native HTTP server (TypeScript/Node.js or owner-approved alternative). Evaluate framework, SQL database, caching, queues, search, storage, realtime and observability tools at their lessons. Record decisions and version choices.
