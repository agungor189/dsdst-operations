# ADR-0003 — Inventory ledger, reservation and one physical boundary

Status: Accepted with one policy gate

Date: 2026-09-20

## Context

Current paths can mutate `central_stock` at CSV import, placement, sale, pick, count and adjustment. Sale plus package pick can double-post the same consumption. Returns and refunds also conflate financial and physical state.

## Decision

Make immutable inventory events and container balances authoritative. `central_stock` becomes a projection. Receipt acceptance creates IN; internal placement/move/pick/pack changes state/location; one approved dispatch transition creates OUT. Reservations reduce availability but not on-hand. Physical returns create inventory only after receipt and disposition. Counts create approved difference events and never clamp silently.

`DECISION REQUIRED`: the owner must choose whether dispatch means transfer to carrier staging or verified carrier handoff. No authoritative OUT implementation may guess.

## Consequences

- Sale acceptance and picking cannot both consume physical stock.
- Historical picks/returns require immutable sale-time BOM and UOM snapshots.
- Test/example balances are not migrated; first production starts fresh. Any future post-launch discrepancy requires read-only reconciliation and separately approved repair.
- Exact conservation/concurrency tests are release gates.
