# DSDST V2 implementation roadmap

Status: sequencing contract. It authorizes no implementation by itself.

## Rules of execution

- PR01 release evidence remediation is prepared from O commit `1e5e6f0993e8b6524e706e7c0e3e494ca483bbec`, but remains under independent final review. It is not an accepted implementation dependency until that review records an exact accepted commit.
- Start no item until its dependencies and owner decisions are closed.
- One PR should close one coherent invariant with a red regression test, migration/rollback statement and exact cross-repository impact.
- Code correctness, historical-data repair, runtime deployment and production acceptance are separate gates.
- A new table or abstraction without moving the authoritative write path does not close a gate.
- No repair runs as part of application startup, schema migration or deployment.

## Delivery streams

| ID / title | Domain | Dependencies | Objective | Acceptance | Stage | Repo(s) |
| --- | --- | --- | --- | --- | --- | --- |
| V2-00 — ARCH-00 | Architecture | PR01 accepted | Bind system ownership, invariants and sequence. | Owner review of documents/rules; no behavior change. | NOW | O + AGENTS in P/W/K/L |
| V2-01 — Exact oracle and schema baseline | Data/testing | V2-00 | Define exact business oracle, fresh DB and supported upgrades. | Deterministic fresh/upgrade unit/integration fixtures with synthetic data. | NOW | P, K, L, O |
| V2-02 — Security containment | Security | V2-01 affected-path tests | Close path/upload/runtime and immediate user/service authorization risks. | Negative tests and supported runtime/dependency scan pass. | NOW | P, W, K/L as affected |
| V2-03 — Identity/capabilities | Identity | V2-01; owner capability mapping | Add revocable sessions and separate human/service authorization. | Logout/password/disable/role-change and impersonation negatives pass. | NOW | P, W, K, L |
| V2-04 — Command foundation | Core platform | V2-01; recovery fixture | Establish module seams, idempotency, audit and outbox. | Replay/mismatch/concurrency/crash tests prove one effect. | NOW | P |
| V2-05 — Catalog/UOM | Catalog | V2-04; UOM decisions | Establish stable product, typed attributes and conversions. | Versioned APIs and historical conversion snapshot tests pass. | NOW | P; K/W consumers |
| V2-06 — Procurement/acquisition cost | Procurement/Cost | V2-04–05; cost/FX decisions | Model PO/shipment/receipt and immutable landed lot cost. | Allocation, residue, provenance and incomplete-input tests pass. | NOW | P |
| V2-07 — Inventory/reservation | Inventory | V2-04–06; dispatch/consumption decisions | Make ledger/container/reservation records authoritative. | Conservation, uniqueness and concurrent last-unit tests pass. | NOW | P |
| V2-08 — Warehouse/bootstrap | Warehouse | V2-07 | Rewire workflows and split CSV catalog/opening/receipt semantics. | One receipt/OUT; plan-vs-physical; count/return and zero-stock import tests pass. | NOW | P, W |
| V2-09 — Sale snapshots | Sales/Money | V2-04–07; finance decisions | Accept sales once with immutable BOM/money/cost/FX snapshot. | Historical immutability and exact header/line totals pass. | NOW | P |
| V2-10 — Return/refund/finance | Returns/Finance | V2-09; policy decisions | Separate physical return from refund and converge cash/reporting. | Independent state, balanced posting and reconciliation tests pass. | NOW | P |
| V2-11 — Kit publication | Kit/Pricing | V2-05–06, V2-09; kit decisions | Publish exact K authored content through core approval. | Content/policy hash and immutable publication tests pass. | NOW if kits launch; else READY | K, P |
| V2-12 — Channel gateway | Marketplace | V2-03–05, V2-09 | Generalize inbox/outbox, mapping, quarantine and reconciliation. | Signature/replay/stage-prod/changed-version tests pass. | READY | P |
| V2-13 — Shipment/carrier | Shipping | V2-07–10, V2-12; shipping decisions | Model parcels, carrier events and dispatch integration. | Idempotent label/void/partial shipment/dispatch tests pass. | READY | P, W |
| V2-14 — Template/print state | Printing | V2-03–04; template migration plan | Version templates and represent print delivery uncertainty. | Concurrent-save, snapshot, lease and unknown-delivery tests pass. | NOW where labels launch | L, P, W |
| V2-15 — Reconciliation/repair capability | Audit/Repair | V2-07–14 relevant modules | Provide read-only detection and future bounded post-launch repair. | Synthetic dry-run/approval/rollback/audit tests pass; no legacy production repair. | READY | P, O |
| V2-16 — Recovery package | Recovery | V2-01; required state models; RPO/RTO decisions | Produce one coherent encrypted recovery set and isolated restore. | Checksummed exact-release restore and invariant smoke pass. | NOW | O, P, K, L, Hub |
| V2-17 — Runtime/release gate | Operations | V2-02; PR01 | Pin supported images and verify real deployment topology. | Service-specific runtime manifest is VERIFIED; actual access required. | NOW before go-live | O + all images |
| V2-18 — Independent system gate | Quality/Security | V2-03–17 applicable NOW items | Re-audit exact release with adversarial cross-system E2E. | Exact set passes; no open go-live P0/P1. | NOW before go-live | O + all repos |
| V2-19 — Limited pilot | Operations | V2-18; signed recovery/rollback | Exercise controlled first real workflows. | Independent stock/cash checks and stop criteria pass. | NOW | O + operators |
| V2-20 — Measured evolution | Operations/Architecture | successful V2-19 | Establish SLO/capacity evidence and review deferred architecture. | Observed load/recovery evidence; ADR for any expansion. | LATER | O + owners |

Items may be split into smaller PRs, but their dependency order and gate semantics remain.

## Audit PR02–PR30 disposition

The audit backlog remains valuable, but its numbering assumed patch-by-patch remediation rather than the V2 domain dependency graph. The mapping below prevents accidental implementation in the old order.

| Audit PR | Original intent | V2 disposition | New home / reason |
| --- | --- | --- | --- |
| PR01 | Runtime/release evidence | **KEEP — final review pending** | Foundational PR01; not an implementation dependency until its remediated exact commit is independently accepted. |
| PR02 | K consistent snapshot and backup manifest | **REMAP** | V2-16; recovery-set design must include all state, not K alone. |
| PR03 | Exact business invariant oracle | **KEEP, FIRST** | V2-01; prerequisite to business rewiring. |
| PR04 | Prevent deletion outside uploads | **KEEP** | V2-02 security containment. |
| PR05 | Verify Warehouse human read authorization | **KEEP/EXPAND** | V2-02 then V2-03 service/user separation. |
| PR06 | Upload byte/extension security | **KEEP** | V2-02 across all upload boundaries. |
| PR07 | Session revocation | **KEEP/EXPAND** | V2-03 session epoch for all clients. |
| PR08 | Inventory and immutable BOM contract | **SPLIT** | V2-05 UOM/catalog, V2-07 inventory, V2-09 sale-time BOM. |
| PR09 | Fail-closed migrations and fixtures | **KEEP, MOVE EARLIER** | V2-01 before new schema work. |
| PR10 | Operation key and immutable result ledger | **KEEP, MOVE EARLIER** | V2-04 common mutation foundation. |
| PR11 | CSV opening vs inbound | **KEEP/EXPAND** | V2-08 after ledger/receipt models exist. |
| PR12 | Snapshot sale consumption recipe | **KEEP** | V2-09; uses V2-05 UOM and V2-07 inventory. |
| PR13 | Separate reservation from real stock | **KEEP/EXPAND** | V2-07 canonical reservation model. |
| PR14 | Package pick as single physical OUT | **REMAP** | V2-07/08; OUT boundary is owner decision, not assumed to be pick. |
| PR15 | Count clamp and package state | **KEEP/EXPAND** | V2-08 explicit count adjustment and reconciliation. |
| PR16 | Financial cancellation vs physical return | **KEEP/EXPAND** | V2-10 independent refund/return state machines. |
| PR17 | Currency-safe sale/expense cash posting | **KEEP** | V2-09/10 after money policy and idempotency. |
| PR18 | Currency-aware dashboard/opening valuation | **REMAP** | V2-06 acquisition cost plus V2-10 reporting projections. |
| PR19 | One finance scope/backend totals | **KEEP/EXPAND** | V2-09/10 shared formula and immutable snapshots. |
| PR20 | Acquisition cost and repair quarantine | **SPLIT** | V2-06 cost model; V2-15 repair only after correct writers. |
| PR21 | Immutable approved kit economics | **KEEP/EXPAND** | V2-11 core publication handshake. |
| PR22 | Profile currency and kit tax/cost policy | **REMAP** | Owner decisions plus V2-06 and V2-11; no coded default. |
| PR23 | Label write queue/CAS | **KEEP** | V2-14, with L as sole template owner. |
| PR24 | Print final attempt/unknown delivery | **KEEP** | V2-14 durable attempt state. |
| PR25 | Read-only reconciliation report | **KEEP, DELAY** | V2-15 after authoritative models/writers are stable. |
| PR26 | Approved small repair batches | **KEEP, SEPARATE** | V2-15; never part of migration/deploy. |
| PR27 | Full restore staging/gate/rollback | **KEEP/EXPAND** | V2-16 complete recovery set. |
| PR28 | Supported runtime and fixed images | **KEEP** | V2-17 using PR01 provenance. |
| PR29 | Independent cross-system re-audit E2E | **KEEP** | V2-18 after all safety gates. |
| PR30 | Pilot runbook/daily checks | **KEEP/EXPAND** | V2-19 with explicit stop/rollback and independent counts. |

## Business decisions required before implementation

| Decision | Owner evidence needed | Blocks |
| --- | --- | --- |
| Accounting/reporting currency | finance owner sign-off and examples | V2-06, V2-09–11 |
| FX sources/fallback/staleness/rounding | finance owner + provider reliability | V2-06, V2-09–11 |
| VAT basis, rounding and profit scope | finance/commercial owner examples | V2-09–11 |
| Margin versus markup terminology/formula | commercial/finance owner examples | V2-09, V2-11 |
| Acquisition allocation and cost-flow method | finance/procurement owner | V2-06–10 |
| Base UOM vocabulary and precision | product/warehouse owner | V2-05–11 |
| Kerf/waste and full-bar/net kit costing | production/commercial owner | V2-11 |
| Remnant ownership, usability and valuation | production/finance owner | V2-06, V2-11 |
| Physical dispatch boundary | warehouse/shipping owner | V2-07–10, V2-13 |
| Reservation expiry/backorder policy | sales/warehouse owner | V2-07–10 |
| Partial cancel/refund/return rules | sales/finance/warehouse owner | V2-10, V2-12–13 |
| Settlement and bank reconciliation | finance/marketplace owner | V2-10, V2-12 |
| Carrier scope and label/void semantics | shipping owner | V2-13 |
| Audit/history and customer-data retention | security/legal/business owner | V2-03 onward |
| RPO/RTO/retention/off-site provider | operations/business owner | V2-16, pilot |
| Approval thresholds for cost, price, count, refund and repair | domain owners | V2-06–15 |
| Local versus cloud production venue | operations/business owner with measured options | V2-16–19 |

## Gate checklist

### Architecture gate

- Owner accepts ARCH-00, domain ownership, unresolved decisions and roadmap.
- Repo AGENTS rules are present and no code behavior changed.

### Code gate per item

- failing regression observed first;
- owner module and boundary identified;
- fresh/upgrade migration fixtures pass;
- unit, integration and affected cross-repo contracts pass;
- no test weakening or hidden data mutation;
- threat, rollback and observability impact documented.

### Data gate

There is no legacy production data to repair for first launch. This gate governs future post-launch repair capability; fresh-launch acceptance instead proves new volumes, zero stock/cash after catalog import and the first real events.

- read-only reconciliation quantifies affected records without exposing sensitive data;
- recovery point is accepted and restore-tested;
- repair manifest is separately approved;
- repair is bounded, idempotent, audited and reversible or compensating;
- post-repair reconciliation is signed.

### Runtime gate

- PR01 service-specific provenance is `VERIFIED` for the deployed release;
- actual ports, networks, volumes and config fingerprints match;
- backup/recovery set references the same release;
- security and E2E gates pass on that exact set.

### Production pilot gate

- limited users/workflows/data scope;
- explicit stop thresholds and rollback owner;
- parallel independent physical stock and cash checks;
- connector/printer failure exercises;
- no unexplained discrepancy at sign-off.

## Explicitly forbidden shortcuts

- implementing PR02 simply because it was next numerically;
- big-bang rewrite or microservice split;
- making `central_stock` correct by hiding a second posting;
- using current product cost/FX/BOM to backfill history without approved provenance;
- treating a K snapshot or marketplace payload as core approval;
- marking print delivered after submission only;
- making tests green with skip/xfail, broad tolerances or weaker assertions;
- combining schema change, historical repair and deploy into one irreversible step;
- claiming production readiness without actual runtime and restore evidence.
