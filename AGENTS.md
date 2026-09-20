# DSDST Operations repository rules

This repository owns deployment composition, release evidence, backup/restore orchestration, cross-system tests, and the binding DSDST Operations V2 architecture. It does not own business data or business rules.

Before changing any DSDST repository, read these binding documents:

- `docs/architecture/ARCH-00-DSDST-OPERATIONS-V2.md`
- `docs/architecture/INVARIANTS.md`
- `docs/architecture/DOMAIN-OWNERSHIP.md`
- `docs/architecture/SOURCE-OF-TRUTH.md`
- `docs/architecture/V2-IMPLEMENTATION-ROADMAP.md`
- the applicable ADRs in `docs/architecture/adr/`

If a requested implementation conflicts with these documents, do not implement it. Report the exact conflict and request an explicit owner decision/ADR.

## Non-negotiable rules

- Preserve the five independently deployable repositories and image provenance. Do not create a distributed business core or a shared writable database.
- Do not create a new source of truth or bypass the owner named in `DOMAIN-OWNERSHIP.md`.
- The Panel backend is the V2 modular-monolith business core. Panel UI, Warehouse, Kit Studio, Label Printer, renderer, Customer Hub, and future channels consume explicit APIs; they do not bypass domain services.
- A user interface is never a source of truth. Local UI caches, browser storage, imported files, and rendered documents are projections or inputs only.
- Every stock, money, approval, print, connector, and repair mutation requires authentication, authorization, an operation identity, an atomic domain transaction, and an immutable audit result.
- Never infer an unresolved business policy. Mark it `DECISION REQUIRED` and block the dependent write path.
- CSV is bootstrap/staging input. It may not silently create physical stock, cash, approved prices, or historical transactions.
- Historical sales, returns, costs, exchange rates, approved kit versions, and marketplace orders use immutable snapshots. Recalculation from current master data is forbidden.
- Production data correction is a separately approved repair operation with backup, preview, reconciliation, rollback, and evidence. A code migration is not permission to repair data.
- Secrets and customer/production data must not enter source control, logs, fixtures, release evidence, or support bundles.
- Runtime claims are `NOT VERIFIED` unless service-specific image digest, container identity, OCI/source revision, config fingerprint, and topology checks pass under the PR01 release-evidence contract.
- Do not weaken tests, skip failing invariants, force push, merge, deploy, restart, migrate, or touch production unless the task explicitly authorizes that action.
- Do not run destructive data, volume, backup or repository operations without explicit scope, recovery evidence and authorization.

## Change discipline

Keep PRs small and dependency-ordered. Start with a failing invariant/regression test, change the owning module only, verify repository-native tests plus relevant cross-repository contracts, and document schema/data/rollback impact. Changes that cross a domain boundary need a versioned API/event contract and an ADR when they alter an accepted architecture decision.

Architecture status labels are `NOW`, `READY`, and `LATER`; disposition labels are `KEEP`, `ADAPT`, `REWRITE`, and `REMOVE`. They describe approved direction, not completed implementation.
