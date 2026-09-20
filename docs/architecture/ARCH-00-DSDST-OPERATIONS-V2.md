# ARCH-00 — DSDST Operations V2 master architecture

Status: **Accepted architecture baseline; implementation not started**

Date: 2026-09-20

Scope: Panel (P), Warehouse (W), Kit Studio (K), Label Printer/renderer (L), Operations (O)

Decision authority: repository owner

Supersedes: informal ownership assumptions; it does not erase accepted hardening or PR01

## 1. Outcome

DSDST V2 will evolve the current system into a **modular-monolith business core with separately deployable user interfaces and adapters**. The business core remains in the Panel repository and initially retains its single transactional operational database. Warehouse, Kit Studio, Label Printer, marketplace/carrier adapters, and other clients cross the core boundary only through authenticated contracts.

This is an incremental architecture, not a rewrite. It preserves proven assets while removing duplicate authority and ambiguous posting points.

The architecture has four hard goals:

1. one authoritative owner for every business fact;
2. one immutable operation identity and one posting for every physical or financial event;
3. historical truth captured at the moment of the event, not reconstructed from mutable master data;
4. recoverability and release provenance treated as part of correctness.

## 2. Evidence and limits

The baseline was derived from the actual local repository states listed in `CURRENT-SYSTEM-MAP.md`, the current source and migrations in all five repositories, the accepted Operations hardening documents, PR01 release-evidence controls, and `DSDST_Second_Audit_2026-09-19.md`.

The audit is a source-code audit, not proof of production state. No live database, container, image, volume, proxy, printer, marketplace account, carrier account, customer data, or production secret was inspected for ARCH-00. Production runtime and data correctness therefore remain **NOT VERIFIED**.

## 3. Architectural shape

```text
Human clients
  Panel UI ───────────────┐
  Warehouse PWA/BFF ─────┤ user session + scoped service identity
  Kit Studio UI/API ─────┤
  Label editor ──────────┤
  Customer Hub ──────────┤ adjacent bounded context; preserved
                          v
                Panel business core
  ┌─────────────────────────────────────────────────────────┐
  │ Identity & Access | Catalog | Procurement | Inventory   │
  │ Warehouse | Sales & Returns | Money & Finance | Pricing │
  │ Published Kits | Marketplace | Shipping | Print Jobs    │
  │ Audit/Idempotency | Reconciliation | Outbox             │
  └─────────────────────────────────────────────────────────┘
                          |
                  one transactional DB NOW
                          |
          versioned commands, queries, events, snapshots
             ┌────────────┼──────────────┐
             v            v              v
       Kit workspace   Label renderer   External adapters
       own draft DB    own templates    marketplace/carrier

Operations: compose, release provenance, backup/restore,
cross-system gates, monitoring and recovery orchestration
```

The word “module” means a code and transaction boundary inside the core, not a new service. Modules may share the same database only through owned repositories/services and declared read models. Direct cross-module table writes are forbidden.

## 4. Deployment model and decision gate

The current Compose source is local-host oriented, but the actual first-production venue has not been selected. **Local versus cloud transaction hosting is DECISION REQUIRED.** ARCH-00 fixes the constraints, not the unprovided business choice:

- There is exactly one writable transaction authority. Do not design bidirectional local/cloud write replication.
- External access terminates through authenticated TLS ingress or a private network. No database, renderer or internal application port is directly Internet-published.
- Printing remains a local device boundary. A remotely hosted core may dispatch durable work to a local scoped print agent, but neither network nor spool success proves physical delivery.
- Backups must have an encrypted off-site copy regardless of where the primary runs.
- External marketplace/carrier/FX calls tolerate outages through inbox/outbox retry and explicit stale/unavailable state; they do not block local read-only access unnecessarily.

If local production is selected, the acceptance design must cover UPS capacity, controlled shutdown, automatic power-on, Docker restart policy, LAN-only access during Internet outage, disk monitoring, off-site backup lag and a tested spare/restore path. Warehouse and already-loaded read-only views may remain usable during Internet loss; marketplace/carrier/FX sync is unavailable or queued, and no write may claim an external side effect succeeded.

If cloud production is selected, the acceptance design must cover office-Internet loss, secure remote access, latency, provider outage/recovery, data location, encrypted backup independence and the local printer agent. Local clients must show unavailable/stale state instead of creating an unsynchronized second database.

The venue decision requires measured cost, connectivity, outage tolerance, printer needs, recovery targets and responsible operator. A future change requires a new ADR.

## 5. Domain boundaries

The binding ownership matrix is in `DOMAIN-OWNERSHIP.md`. The principal boundaries are:

- **Identity & Access:** human identities, roles, permissions, session epochs/revocation, service principals, scopes.
- **Catalog:** product/SKU identity, canonical names, typed attributes, base unit, packaging definitions, dimensions and weight.
- **Procurement:** suppliers, purchase orders/offers, goods-receipt intent, invoice references.
- **Acquisition Cost:** landed-cost components, allocation method, source currency, FX snapshot and immutable lot/unit cost.
- **Inventory:** stock item/lot/container identity, inventory ledger, on-hand, reservations, adjustments and reconciliation.
- **Warehouse:** receiving, packaging, placement, movement, count, pick, pack and dispatch workflows built on Inventory commands.
- **Sales & Returns:** canonical orders, immutable order lines, payment state, cancellation/refund intent and return lifecycle.
- **Money & Finance:** monetary value objects, cash accounts/postings, expenses, realized income, FX and accounting projections.
- **Pricing:** price lists, price components, margin/tax/commission/shipping policy inputs and effective-dated approvals.
- **Kit Workspace:** editable kit design, compatibility, cuts and approval proposal in K.
- **Published Kits:** accepted immutable BOM/economic snapshot and sellable SKU in the core.
- **Marketplace:** connector credentials/configuration, ingestion cursor, external-to-canonical identity mapping and publish jobs.
- **Shipping:** shipment, parcels, carrier labels/tracking, dispatch confirmation and delivery state.
- **Printing:** print intent/job/attempt/delivery uncertainty in the core; template design/rendering in L.
- **Audit/Idempotency:** operation keys, immutable results, actor/device/request metadata and outbox.

## 6. Core transaction rule

Every state-changing command follows one path:

```text
authenticated actor + authorized capability + operation key + validated command
  -> owning domain service
  -> one database transaction
       business invariant checks
       aggregate state change
       immutable ledger/snapshot
       operation result
       audit record
       outbox event when needed
  -> committed response replayable by operation key
```

The same operation key and canonical payload returns the original result. The same key with a different payload returns a conflict. A retry, UI refresh, webhook replay, worker restart, or network timeout may never duplicate a stock, cash, refund, shipment, or print-intent effect.

External side effects use a transactional outbox and a durable attempt state. Database success is not equivalent to marketplace publication, carrier acceptance, backup upload, CUPS acceptance, or physical print.

## 7. Inventory and warehouse lifecycle

Inventory is event-derived and container-aware. The approved state model is:

```text
Planned receipt
  -> Receiving
  -> Received/Quarantined
  -> Containerized
  -> Placed (ON_HAND)
  -> Reserved
  -> Picked (still owned; staging location)
  -> Packed
  -> Dispatched (physical OUT)
  -> Delivered

Exceptional paths:
  quarantine -> released/rejected
  reserved -> released/expired
  picked/packed -> unpicked/unpacked
  dispatched -> return expected -> returned inspection
  returned inspection -> restocked/quarantined/scrapped
  any physical discrepancy -> count -> approved adjustment
```

Definitions:

- `on_hand`: accepted physical quantity under company control, including internal staging, excluding planned/unreceived and dispatched stock.
- `reserved`: on-hand quantity allocated to an active demand and not released.
- `available = on_hand - reserved`, per product/lot/location/status constraints.
- `picked` is a location/state transition, not automatically physical OUT.
- physical OUT occurs once, at the approved dispatch boundary.
- returns do not restore on-hand until physical receipt and disposition.
- count differences create explicit adjustment events after approval; clamping is forbidden.

`DECISION REQUIRED`: whether the business defines transfer to carrier staging or carrier handoff as dispatch. Implementation must block the OUT posting until the owner chooses and acceptance tests encode the choice.

Each ledger entry carries `event_id`, `operation_id`, `product_id`, optional lot/container/location/reservation/order/shipment references, signed base-unit quantity, reason, actor and timestamp. Aggregates are rebuildable and reconciled against container balances.

## 8. CSV bootstrap and imports

CSV is an untrusted, reviewable staging format:

- catalog rows may create/update validated master-data proposals;
- historical/opening inventory imports create a named, dated, separately approved opening event batch;
- inbound plans create receipt intent only;
- no generic column may directly overwrite on-hand, cash, cost history, approved price, order history, or ledger rows;
- dry run, row-level errors, normalized units, duplicate detection, totals, reviewer identity and an import hash are mandatory;
- applying a batch is idempotent and immutable; correction is a compensating batch.

The present CSV path that writes `central_stock` and receipt planning in one flow is `REWRITE` before V2 inventory authority.

## 9. Procurement and acquisition cost

Procurement may remain a simple Panel module initially, but its model separates `Supplier`, `PurchaseOrder`, `PurchaseOrderLine`, `SupplierShipment`, `SupplierShipmentLine`, `GoodsReceipt`, `Lot`, `ShipmentCost`, `CostAllocation` and `CostFinalization`. Purchase-order approval is commercial intent; supplier shipment is expected movement; goods-receipt acceptance is the physical event.

Purchase price and acquisition cost are different facts. A finalized receipt lot captures:

- supplier and purchase document identity;
- quantity and unit of measure;
- native-currency unit price;
- FX rate, source, timestamp and rate direction;
- freight, insurance, customs, customs-related charges, port/terminal, customs broker, domestic transport, bank/transfer, inspection, handling and other allocated components;
- allocation rule and rounding residue;
- computed landed unit cost in accounting currency;
- provenance and approval state.

After approval, the lot cost snapshot is immutable. Later master-price or FX changes do not rewrite history. Corrections are versioned cost adjustments with a reason and accounting effect.

Allocation supports value, weight, volume, quantity, direct-SKU and explicitly approved manual methods. Each component records whether it is allocable and its evidence; allocation never invents tax meaning. Recoverable tax and inventory cost are distinct concepts.

`DECISION REQUIRED`: accounting currency; accepted FX sources and fallback policy; allocation default and rounding; treatment of each tax/charge in inventory cost; approval thresholds; weighted-average/FIFO/specific-lot consumption policy. Until decided, the dependent authoritative valuation path is blocked.

## 10. Money, currency, tax and reporting

Money is represented as `{amount_minor, currency}` using the currency's declared scale. Floating-point arithmetic is forbidden for authoritative money. A financial posting retains `original_amount`, `original_currency`, `account_amount`, `account_currency`, optional `base_try_amount`, `fx_rate`, `fx_source`, `fx_timestamp`, rate direction and rounding rule. `base_try_amount` is a snapshot projection when TRY is the accepted reporting currency, not permission to discard native amounts.

Reports never sum unlike currencies. They either group by native currency or use an explicit historical conversion snapshot. Current display FX is not historical transaction FX.

Sales and approved kits snapshot their full economic scope: unit prices, discounts, tax basis/rate, commissions, marketplace fees, shipping, packaging, labor, BOM quantities, component costs and FX provenance. Header, line and report totals are derived from one shared formula version. Reporting distinguishes `Revenue - COGS = Gross Profit`, then commission/packaging/shipping to `Order Contribution`, then operating expenses to `Operating Result`; which components are included and how they are allocated remains policy.

`DECISION REQUIRED`: accounting/reporting currency, VAT inclusive/exclusive policy, tax rounding level, discount allocation, commission/fee scope, shipping revenue/cost treatment, profit definition and approval thresholds. Defaults in existing code are evidence of current behavior, not accepted policy.

## 11. Units of measure and attributes

Each product has one immutable stock/base unit chosen from a controlled vocabulary that can express at least `piece`, `meter`, `square_meter`, `kg`, `roll`, `package` and `box` (stored internally at an approved integer precision such as millimetres/grams where appropriate). Purchase, stock, consumption and sale units may differ and convert through versioned rational factors with effective dates. Transaction quantities use fixed-precision integers in the base unit.

- No free-text unit participates in calculation.
- Dimensions use integer millimetres; mass uses integer grams unless a domain-specific higher precision is approved.
- A conversion is captured in historical snapshots.
- Unit changes after transactions require a new product/version or an approved migration.
- Typed catalog attributes have schema, unit, cardinality and applicability; searchable projections do not become authority.

Core typed fields cover identities and calculation-critical dimensions. Extensible, schema-validated attributes cover category-specific facts without a migration for every new descriptive field. Examples: fabric stock in linear metres with fixed-width typed attribute; profile stock in metres with standard bar length; cap as pieces with compatible-size reference; wheel as pieces with diameter/height/load-capacity typed attributes. Calculation-critical fields cannot be uncontrolled JSON or free text.

`DECISION REQUIRED`: the supported UOM vocabulary, allowed fractional precision per product class, cut-loss/kerf rules, and full-bar versus net-consumption costing.

## 12. Kit design, approval and publishing

K remains the interactive design workspace and owns drafts, compatibility evaluations, cuts and authored versions. It does not own canonical product cost, stock, cash, marketplace state, or global price policy.

Approval is a handshake:

1. K freezes an authored version with normalized quantities and referenced catalog versions.
2. K submits an approval proposal with an idempotency key.
3. The core resolves authoritative catalog/cost/policy inputs and returns a complete preview.
4. An authorized human approves the exact content hash.
5. The core stores the immutable published-kit snapshot and creates/updates the sellable SKU.
6. K records the core publication ID and content hash; it does not locally mutate the approved snapshot.

Any later change creates a new version. Current costs may produce a non-authoritative simulation, never rewrite an approved economic snapshot.

## 13. Marketplace and shipping lifecycle

Current source implements Trendyol configuration with explicit stage/production endpoints, encrypted integration-key selection, connection testing, periodic package sync, status normalization, `marketplace_orders`/`marketplace_order_lines` staging and SKU/barcode/stock-code matching. It intentionally does not auto-create sales. Hepsiburada has credential connection-test code and general channel/cash configuration, but no equivalent canonical order sync was found. N11 and Amazon appear as configurable key/channel/commission choices, not complete order connectors. No Shopify connector was found. These are current code observations, not verified external integration behavior.

Marketplace adapters translate external payloads into a canonical order inbox. Raw payload digest, external order/version identity, cursor and receipt time are retained with secret/customer-data redaction. Import is idempotent. Unmatched SKU, invalid currency, changed order totals or missing policy enters quarantine; it does not silently become a sale.

Canonical lifecycle:

```text
received -> validated -> accepted -> reserved -> pick/pack -> shipment created
-> carrier accepted -> dispatched -> delivered
       \-> cancelled / refund pending / returned
```

Marketplace state, payment state, fulfillment state, carrier state, cash posting and physical inventory state are separate state machines joined by explicit references. A status string from one system may not directly post another domain.

Connector secrets are encrypted at rest, never returned after creation, scoped per connector, rotatable and excluded from evidence/logs. Stage and production credentials, endpoints, cursors, inbox rows and publish jobs are separated and cannot be cross-used. Webhooks are signature-verified, timestamp-bounded and replay-safe; periodic reconciliation detects missed or reordered events.

`DECISION REQUIRED`: authoritative cancellation cutoffs, partial fulfillment/refund rules, marketplace settlement reconciliation, supported carriers, label purchase/void behavior and delivery-proof retention.

## 14. Printing boundary

The core owns print job intent, payload snapshot, template ID/version, target printer, attempts and terminal/uncertain states. L owns template authoring and deterministic rendering. The local print worker owns CUPS interaction.

`RENDERED`, `SUBMITTED`, `ACKNOWLEDGED`, `PRINTED_CONFIRMED`, `FAILED`, and `DELIVERY_UNKNOWN` are distinct. A successful `lp` submission is not physical delivery. Retry behavior depends on whether the prior attempt is provably absent; otherwise the job is `DELIVERY_UNKNOWN` and requires operator action.

The current duplicate template authority in Panel and L must converge: L is the template source of truth; the core stores immutable template version references/snapshots needed for a print job.

## 15. Identity, authorization and audit

P is the sole human identity authority for this system. Sessions include a server-checked epoch/version so logout, password change, disablement and role changes revoke prior sessions. Browser-facing services keep tokens in secure HttpOnly cookies and validate the live user for every protected request.

Service principals are distinct from human actors. A service key proves the caller application and scope; it never substitutes for a human identity on user-initiated actions. A command records both service and human actor when applicable.

Authorization is capability-based and enforced in the owning backend. UI hiding is not authorization. High-impact actions—role/key changes, cost policy, price approval, count adjustment, repair, restore and connector activation—require explicit capabilities and audit.

Audit records are append-only, redact secrets and sensitive payload fields, and contain actor, service, action, target, operation ID, before/after digests, reason and timestamp. Production audit retention and access policy are `DECISION REQUIRED`.

## 16. PWA and offline behavior

Warehouse remains installable as a PWA. Static shell/assets may be cached; authenticated API responses and secrets may not be cached by the service worker. Offline mode is read-only unless a future command type has an explicitly designed conflict and idempotency protocol.

Stock, receipt, count, pick, dispatch, price, cash and approval writes fail closed while offline. The UI must visibly distinguish stale projections from live authoritative state. Background sync for business mutations is `LATER` and requires a dedicated ADR.

The shared client standard for any installable DSDST UI is: versioned manifest, standalone display where useful, responsive/mobile-safe navigation, complete purpose-built icons, accessible touch targets, an explicit update-available prompt, deterministic cache invalidation, no secret/API response caching, and diagnostics that show client version and server connectivity. Kit Studio and other UIs adopt PWA packaging only when the operational benefit justifies it; PWA is not a blanket requirement.

## 17. Security baseline

- TLS at every untrusted hop; restricted ingress; internal services not host-published unless required.
- Secure, HttpOnly, SameSite cookies; CSRF protection where cookie authentication crosses unsafe methods.
- Least-privilege human capabilities and service scopes; key rotation and revocation.
- Strict input schemas, size limits, MIME/content validation and controlled storage paths.
- Parameterized queries and domain validation; fail-closed migrations.
- Secret manager or protected environment injection; no secrets in images, Git, logs, metrics, backups manifests or evidence.
- Encryption for off-site backups and sensitive connector credentials; tested restore keys.
- Dependency/image scanning, supported runtimes, immutable image digests and PR01 provenance gates.
- Rate limits and abuse controls on login, webhook, upload, render and expensive query paths.
- Production repair endpoints disabled by default and enabled only for an approved repair package.

Existing hardening is `KEEP`; it is not evidence that application-level invariants are complete.

## 18. Backup, disaster recovery and history

A recoverable release is a set, not a single DB file. The recovery package includes:

- transactionally consistent core database snapshot;
- K workspace database and uploads;
- L template state;
- Panel/Customer Hub attachments and uploads;
- schema/application versions, service-specific image digests and OCI revisions;
- redacted config fingerprints and backup manifest checksums;
- encryption/key-recovery instructions stored separately;
- restore order and verification expectations.

Backups are encrypted, access-controlled, retained under policy and copied off-site. A scheduled isolated restore must boot the exact release set and pass integrity, referential, ledger, object-count, checksum and smoke checks without touching production.

`DECISION REQUIRED`: business RPO, RTO, retention schedule, legal/customer-data retention, backup region/provider and responsible owner. Until accepted and demonstrated, backup/restore is **NOT VERIFIED**.

History is append-only by default. Corrections use reversals or superseding versions. Mutable master data may be edited, but historical documents retain their snapshots.

## 19. Observability and reconciliation

Structured logs and metrics carry operation/correlation IDs but no secrets or unnecessary personal data. Required signals include command conflicts, transaction latency/locks, outbox lag, connector retries, reservation age, negative/imbalanced stock attempts, print unknowns, backup age, restore-test age and release identity.

Read-only reconciliation compares:

- inventory ledger aggregates, container balances and product projections;
- reservations against active demand;
- sales/refunds against cash and marketplace settlements;
- lot cost allocations and rounding residues;
- print jobs against attempts;
- backup manifest content against the deployed release.

Reconciliation reports differences; they never auto-repair.

## 20. Evolution stages

### NOW — safety and contracts

- Keep five repos and current deployment topology.
- Establish exact invariants, API contracts, operation keys, migration fixtures and fresh-database baseline.
- Contain accepted security issues.
- Introduce modular boundaries inside P before moving behavior.
- Add authoritative ledger/snapshot structures through forward-only migrations.
- Keep risky stock/finance/repair paths non-authoritative until their gates pass.

### READY — authority after evidence

- Inventory/warehouse lifecycle has one physical posting and reconciles.
- Sales/returns/finance use immutable money, BOM, cost and FX snapshots.
- K approval publishes through the core contract.
- Connectors and shipping use inbox/outbox and independent state machines.
- Identity/session/service scopes and print delivery uncertainty are enforced.
- Full recovery package restores in isolation; exact cross-system gates pass.

### LATER — only after measurement

- Cloud relocation or database-engine change.
- Offline business writes/background sync.
- Service extraction from the modular monolith.
- Event streaming, analytics warehouse, multi-site inventory or advanced forecasting.
- Automated accounting/carrier expansion beyond accepted policies.

No `LATER` item is a prerequisite for a safe V2 modular monolith.

### Capability classification

| Capability | Stage | Reason |
| --- | --- | --- |
| Fresh DB/schema bootstrap, admin bootstrap and zero-stock catalog import | NOW | Required before first real record. |
| Identity/session revocation and service-scope separation | NOW | Safety boundary for every client. |
| Catalog/UOM, procurement receipt, lot cost, inventory/reservation, sales snapshots | NOW | Minimum authoritative business core. |
| Warehouse receipt/place/pick/pack/count/dispatch workflow | NOW | First production physical lifecycle. |
| Currency-safe cash/expense and basic reports | NOW | Prevent inconsistent financial history. |
| K draft, quote, approval and core publication | NOW if kits are sold; otherwise READY | Backend contract should precede first approved kit. |
| Versioned templates and safe print queue | NOW where labels are operational | Physical workflow dependency. |
| Trendyol stage ingestion/quarantine | READY | Preserve current work; enable production only after canonical order gates. |
| Additional marketplaces and Shopify | READY contract, LATER connector code | Common adapter contract first; no speculative adapters. |
| Shipment/carrier core state | READY | Model must support fulfillment; carrier-specific adapters are demand-led. |
| Encrypted off-site backup and isolated restore | NOW | Required before authoritative production. |
| Offline disaster-recovery bundle | READY | Design/package format now; automation depth follows RPO/RTO. |
| Advanced analytics, forecasting, multi-site, event streaming | LATER | No current evidence of need. |
| Offline business writes and bidirectional replication | LATER | High conflict/consistency cost; separate ADR required. |
| Database-engine or service split | LATER | Triggered only by measurements. |

## 21. Repository and subsystem disposition

| Area | Disposition | Direction |
| --- | --- | --- |
| Panel UI | KEEP/ADAPT | Keep simple operator UI; consume core contracts and remove authoritative client calculations. |
| P operational DB and API | ADAPT | Become explicit modular-monolith core; preserve data and incremental migrations. |
| P monolithic `server.ts` routing | REWRITE incrementally | Extract by owning domain behind tests; no big-bang rewrite. |
| Catalog | ADAPT | Stable identity plus typed UOM/attributes and versioned API. |
| Inventory | REWRITE core posting model | Ledger/reservation/container authority; current stock field becomes projection. |
| Warehouse | KEEP/ADAPT | Preserve W workflow/BFF and P services; rewire lifecycle to Inventory commands. |
| Sales/Returns | REWRITE critical transaction path | Immutable snapshots, reservation/dispatch and independent refund/return states. |
| Finance/Money | REWRITE calculations, preserve raw facts | Currency-safe postings and one formula owner. |
| Procurement | ADAPT/EXPAND minimally | Add PO/shipment/receipt/cost boundaries without complex UI. |
| Pricing | REWRITE policy boundary | Effective/versioned approval and shared calculations. |
| Auth | ADAPT | Preserve P authority and secure cookies; add session revocation/capabilities. |
| Marketplaces | ADAPT | Keep Trendyol staging and credential controls; introduce generic inbox/outbox before more channels. |
| W PWA/BFF and no-local-DB model | KEEP | Strengthen actor propagation, stale-state display and contract tests. |
| K design/compatibility/version workspace | KEEP/ADAPT | Keep drafts; remove second authority for canonical cost/price/catalog; publish via core. |
| P legacy kit editor/model | REMOVE after migration | Read-only migration bridge, then retire when K/core snapshots reconcile. |
| L editor and renderer | KEEP/ADAPT | Make templates versioned/CAS-safe; remove product list as business authority. |
| P label-template duplication | REMOVE | Core references L template versions; no second editor authority. |
| Print queue/worker | ADAPT | Preserve durable queue; model leases, attempts and delivery unknown explicitly. |
| Backup/restore | ADAPT | Build one consistent, encrypted, checksummed recovery package and restore gate. |
| O Compose hardening and PR01 evidence | KEEP | Extend to recovery set and V2 gates without weakening provenance. |
| Existing tests | KEEP/ADAPT | Keep coverage; add exact invariant/concurrency/fresh-upgrade/cross-system oracles. |
| Current CSV stock mutation | REWRITE | Split catalog proposal, opening batch and receipt plan. |
| Current cash/FX/profit calculations | REWRITE by shared policy | Preserve raw history; migrate only with reconciliation. |
| Customer Hub | KEEP as adjacent context | Preserve independent data; define contracts in a later scoped architecture task. |

## 22. Fresh production bootstrap

There is no production business history to migrate. Existing databases contain test/example data and are not a production migration source. First production uses new persistent locations and this ordered gate:

1. verify the exact release images/config/topology through PR01;
2. create new empty persistent volumes and initialize the final schema from zero;
3. create the first admin through a one-time secure bootstrap, rotate/disable bootstrap material and verify session/capabilities;
4. import catalog master data through versioned CSV dry run, review and idempotent apply;
5. assert every stock projection is zero and no stock/cash/history movement was created by import;
6. configure approved business policies, accounts, locations, UOMs, connectors and templates; unresolved dependent features remain disabled;
7. create and independently restore the initial recovery package;
8. record the first real goods receipt as physical IN, then follow reservation, pick/pack and one physical OUT;
9. reconcile inventory/cash and capture pilot evidence before expanding scope.

Legacy production migration, historical backfill and historical data repair are **not required** for this first launch. Repair architecture remains `READY` for future post-launch history; test/example databases are archived or discarded under an explicit non-production procedure, never copied into production.

## 23. Principal risks

| Risk | Architectural control |
| --- | --- |
| Multiple current stock writers survive behind new abstractions | Exact invariant oracle; one Inventory repository; prohibit direct writes; fresh DB gate. |
| Undefined commercial policy is encoded as a default | `DECISION REQUIRED`; incomplete state; approval uses policy version/hash. |
| K or connector becomes a second authority | Ownership contracts, read-only caches, core publication/inbox. |
| SQLite concurrency or host availability is insufficient | Measure locks/load/recovery; one writer; accepted RPO/RTO; later ADR if thresholds fail. |
| Local/cloud choice creates split brain | One writable authority; no bidirectional replication. |
| External retries duplicate effects | Idempotency ledger, inbox/outbox, unique external identities. |
| Printer/network success is mistaken for physical completion | Explicit attempt and delivery-unknown states. |
| Backup exists but cannot restore the exact system | Recovery-set manifest, checksums, immutable release provenance, isolated drills. |
| Sensitive credentials/data leak into evidence/tests | service allowlists/redaction, synthetic fixtures, encrypted credentials, scans. |
| Architecture becomes too broad for a small business | dependency-ordered NOW scope; READY contracts; LATER features not implemented. |

## 24. Explicit non-goals

ARCH-00 does not implement code, migrate data, repair history, certify production, choose unresolved business/accounting policy, merge repositories, create microservices, replace SQLite, deploy, restart or authorize PR02.

## 25. Decision gates

Implementation may begin only through the dependency order in `V2-IMPLEMENTATION-ROADMAP.md`. A gate is closed only by passing tests and evidence on the exact release set. Documentation, green unit tests, or a code fix alone do not prove historical data correctness or runtime deployment.

Any proposal that changes a source of truth, physical stock boundary, monetary semantics, deployment authority, authentication model, or recovery contract requires an ADR and owner approval before implementation.
