# EventHub

A backend-first, evolving event booking and ticketing platform built from first principles. The final goal is a complete full-stack product, not just an API.

## Learning journey

Follow [Backend from first principles by Sriniously](https://www.youtube.com/playlist?list=PLui3EUkuMTPgZcV0QhQrOcwMPcBCcd_Q1), adding a small implementation or experiment after each video, especially positions 5–30. Start simple, measure behavior, and introduce abstractions only when their underlying problem is understood.

## Learning-to-implementation workflow

ChatGPT teaches and discusses each lecture, then on explicit learner confirmation commits its notes and practical assignment to main under [docs/lectures/](docs/lectures/). Coding agents use those notes to implement the scoped exercise, review, test and record implementation evidence. [Progress](docs/PROGRESS.md) tracks learning and implementation independently. See [AGENTS.md](AGENTS.md) for the full handoff rules.

## Project status

Planning only. First implementation milestone: HTTP (video 5). No application features implemented yet.

## Final product vision

Attendees discover events, reserve and purchase tickets through simulated payments, receive digital tickets and check in. Organizers manage events, capacity and bookings; administrators oversee the platform. Frontend development follows the backend curriculum.

## Documentation

- [Agent instructions](AGENTS.md)
- [Claude instructions](CLAUDE.md)
- [Product specification](docs/PROJECT_SPEC.md)
- [Learning roadmap](docs/LEARNING_ROADMAP.md)
- [Progress tracker](docs/PROGRESS.md)
- [Architecture](docs/architecture/README.md)

## Development philosophy

Learn the mechanism before adopting the abstraction. Prefer simple local experiments, reproducible tests and evidence over speculative complexity. Do not interpret roadmap items as completed features or benchmark results.

The backend language and tools are subject to owner approval; TypeScript with native Node HTTP is the initial recommendation, not an irreversible decision. No paid infrastructure is required for the learning phase.
