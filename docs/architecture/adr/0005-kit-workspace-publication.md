# ADR-0005 — Kit workspace and core publication handshake

Status: Accepted

Date: 2026-09-20

## Context

K has useful compatibility, cut, variant and version behavior but also local price/cost defaults. P has a separate legacy kit model. Neither should become a competing catalog/economic authority.

## Decision

K owns editable drafts and authored kit versions. P owns canonical catalog/cost/pricing and the published sellable kit. Publication freezes K content, resolves core economic policy, previews the exact snapshot, records authorized approval of its hash, and writes an immutable core publication. K records the returned publication ID/hash.

P legacy kit writes become read-only once migration begins and are removed only after reconciliation.

## Consequences

- Editing a draft never silently changes a sellable kit.
- Current-cost re-evaluation is a simulation or new version.
- API/idempotency and UOM/economic policies are prerequisites.
- K remains independently useful without becoming a second business core.
