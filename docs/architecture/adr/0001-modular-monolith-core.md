# ADR-0001 — Modular-monolith business core with separate clients

Status: Accepted

Date: 2026-09-20

## Context

P already holds the operational database and most cross-domain transactions. W is a stateless workflow client, K has a valuable design workspace, L has a renderer/editor boundary, and O composes the system. Audit evidence found ambiguous business posting, not a need for distributed services or a full rewrite.

## Decision

Evolve P's backend into a modular monolith. Keep P/W/K/L/O as independently deployable repositories and images. Human UIs and adapters use authenticated APIs; only core domain modules mutate operational facts. Modules own repositories/tables and interact through declared ports inside a shared transaction or committed outbox.

## Consequences

- Cross-domain invariants can be atomic without distributed transactions.
- `server.ts` is decomposed incrementally behind regression tests.
- W remains DB-less; K and L retain only their bounded-context state.
- No module/service extraction occurs without measured need and a new ADR.
- This decision does not certify current P behavior or production data.

## Rejected

- Big-bang rewrite: too much migration and regression risk.
- Microservices now: increases consistency/recovery cost without evidence of scale need.
- Shared writable DB across services: erases ownership and security boundaries.
