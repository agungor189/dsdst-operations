# ADR-0009 — Reconciliation may rebuild explicitly safe projections only

Status: Accepted

Date: 2026-09-23

Decision authority: repository owner, V2-15 locked decisions

## Context

ARCH-00 originally stated that reconciliation reports differences and never auto-repair. That remains correct for source-of-truth records, but V2-15 requires a narrower operational distinction between canonical contradictions and disposable projection drift.

## Decision

P owns reconciliation runs, deterministic findings, repair proposals, approvals and scoped blocks. A reconciliation run may automatically rebuild only a projection/read model that is explicitly registered as disposable and whose value is deterministically derived from immutable canonical records. V2-15 initially registers only `products.central_stock`, derived exactly from authoritative inventory lots.

Inventory ledger events, lot quantities/costs, reservations, sales/kit/return/shipment/print history and all other canonical facts are never automatically changed. Their contradictions create a finding, an exact SKU/order block and an admin repair workflow. An approved canonical repair is executed through the existing authoritative domain command, not through reconciliation table SQL.

Every automatic projection rebuild and every canonical repair lifecycle records before/after evidence, reason, actor, operation identity and timestamp. Evidence is append-only and never repaired by deletion.

## Consequences

- The broad ARCH-00 prohibition remains binding for canonical/source-of-truth facts.
- Adding another auto-repairable projection requires an explicit registry change, deterministic derivation and regression coverage.
- Critical findings block only their affected SKU/order.
- A block clears only after a clean complete recheck or explicit admin verification.
- Schema migration, reconciliation, repair execution and deployment remain separate operations.

