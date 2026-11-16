# Architecture

## Current
No runtime architecture implemented. Initial exercise: client (curl) -> native HTTP server -> in-memory event data. Persistence, authentication and other components appear only when applicable.

## Evolution (planned)
1. Simple native HTTP server and request handling.
2. Layered backend and SQL persistence with booking invariants.
3. Cache, jobs, search and resilience as justified by lessons.
4. Observability, secure operation, scaling and concurrency experiments.
5. Object storage, real-time updates, API contracts and integrations.
6. Owner-approved frontend and deployment.

Potential end state: browser clients -> reverse proxy -> stateless backend instances -> SQL database (authoritative), optional cache, job workers, search index and object storage. Observability spans components. These are candidates, not deployed infrastructure; actual architecture and dependencies must be documented after each relevant milestone.

Keep diagrams aligned with implemented state; log major changes as decisions. Separate planned diagrams from actual.
