# Current system map

Status: evidence-based snapshot for ARCH-00, not production certification.

Observed: 2026-09-20.

## Repository baselines

| Code | Repository | Inspected branch | Inspected commit | Current responsibility |
| --- | --- | --- | --- | --- |
| O | `agungor189/dsdst-operations` | `codex/pr01-release-evidence` | `1e5e6f0993e8b6524e706e7c0e3e494ca483bbec` | Compose, CI/E2E, backup/restore scripts, deployment docs, release evidence. |
| P | `agungor189/panel-kit-yonetimi` | `main` | `287c8aef8e8e5c770d1ab7e517fe4f83b1dbd6bb` | Panel UI/API, identity, operational SQLite, catalog, stock, sales, finance, warehouse backend, connector staging, print queue. |
| W | `agungor189/Dsdst-Warehouse` | `codex/dsdst-operations-v1` | `7915b3f9edffe6d337e5754f18df7a50fe6c62c3` | Warehouse PWA and same-origin BFF; proxies authenticated commands to P. |
| K | `agungor189/dsdst-kit-studio` | `main` | `fc90fceba94a308016ebfbfddcd78f5ae8ef20a2` | Kit design, compatibility, variants, versions/snapshots, local catalog cache and uploads. |
| L | `agungor189/Label-Printer` | `main` | `326ac545e208aa665365abf8dde6cb9cf4ecb961` | Label editor, JSON template state and headless PDF renderer. |

O includes accepted hardening work and PR01 after its review remediation. These commits are the architecture input; no repository was reset to the older audit baseline.

The independent audit used an older W main commit (`13b4d266...`) and O main commit (`c775bc1...`). ARCH-00 checked the actual heads above and treats audit findings as inputs to reproduce or close, not as current-runtime truth.

The owner states that existing databases contain test/example data and the first real production deployment will use fresh persistent data locations. ARCH-00 therefore does not plan legacy production migration, historical reconciliation/backfill or repair. Existing schemas and sample data were still inspected to understand behavior; future repair controls are designed for history created after go-live.

## Runtime topology described by source

| Compose service | Host exposure | Internal dependencies | Persistent state |
| --- | --- | --- | --- |
| `dsdst-panel` | loopback `3000` by default | renderer; external FX/marketplaces | Panel SQLite, uploads, Panel backups |
| `dsdst-warehouse` | loopback `3006` | Panel API, renderer | no business DB |
| `dsdst-kit-studio` | loopback `3012` | Panel catalog/auth | K SQLite, uploads |
| `dsdst-customer-hub` | loopback `3100` | Panel | Hub SQLite, attachments, backups |
| `label-printer` | loopback `3013` | Panel auth | shared label JSON state |
| `warehouse-label-renderer` | internal `3010`; no host publish | label state read-only | no independent state |
| `operations-toolbox` | profile-only | read-only source volumes | backup destination only |

The Compose source declares read-only root filesystems, dropped capabilities, no-new-privileges, loopback publishing, and an internal network. Those are strong controls but do not prove the actual production container IDs, image digests, mounts, networks, ports, revisions, secrets, proxy rules or running configuration. PR01 requires service-specific runtime provenance; production remains **NOT VERIFIED** here.

## Current dependency paths

```text
Panel browser -> P Express -> P SQLite
Warehouse browser -> W BFF -> P /api/warehouse/v1 -> P SQLite
Kit browser -> K API -> K SQLite
                         -> P kit-catalog/auth -> P SQLite
Label browser -> L API -> app-state.json
                         -> P auth
P print worker -> L renderer -> CUPS/device
Marketplace adapter in P -> marketplace staging -> product matching
O scripts -> service APIs/volumes -> backup set
```

## Current data and behavior inventory

### P — Panel and operational backend

Observed tables and migrations cover products/logistics/images/platform prices/BOM; stock movements; users/API keys; sales and sale items; transactions, cash accounts, cash movements and exchange rates; marketplace order staging; B2B firms/offers/follow-ups; legacy kits/profiles; warehouse locations, layouts, inbound lots/batches/packages, placement, movements, counts, pick progress/sessions, reservations and print jobs.

Observed strengths:

- one database can provide atomic domain transactions;
- SQLite WAL, foreign-key and busy-timeout initialization exists;
- warehouse writes are centralized behind services/routes;
- scoped Panel API keys and encrypted integration credentials exist;
- online Panel backup, activity logging, snapshot fields and test infrastructure exist.

Observed conflicts to resolve:

- `products.central_stock` has multiple posting paths, including sale, placement, pick/count/adjust and CSV;
- sale and later package pick can represent the same physical consumption twice;
- historical sales/picks may consult current BOM/cost data;
- native currency, TRY conversion, cash-account currency and reporting totals have inconsistent semantics;
- legacy kit and K represent overlapping concepts;
- template ownership is duplicated between P warehouse tables and L state;
- a large `server.ts` permits cross-domain writes without an enforced module boundary;
- marketplace ingestion is staging/matching, not a complete canonical order/settlement lifecycle.

### W — Warehouse

W is a React/Vite installable PWA plus Express BFF. It stores the Panel JWT in an HttpOnly SameSite cookie, adds the Warehouse service key server-side, and forwards receiving, package, placement, movement, count, picking, label and layout operations to P. It has no independent business database. The service worker caches the application shell; API writes are designed to fail when offline.

This is the correct V2 direction. W is a workflow client, not stock authority. Remaining risks are actor/service separation, exact stale/offline behavior, and enforcing the single physical-event rule in P.

### K — Kit Studio

K has an independent SQLite workspace. It stores suppliers, profiles/specifications, complementary products, Panel connector cache, compatibility rules, kit drafts/variants/lines, pricing snapshots, versions and images. It uses integer cents/basis points and snapshot columns in several paths. It authenticates humans through P and syncs a scoped read-only Panel catalog.

K currently also carries local purchase/sale prices, markup defaults, tax defaults and kit-level cost/price fields. Those are useful design inputs but overlap core catalog/cost/pricing authority. V2 retains K drafts and authored versions while moving publication and authoritative economics to a core approval contract.

### L — Label Printer and renderer

L persists product-list/editor settings and templates in `data/app-state.json`; save uses a temporary file and rename. The renderer reads the same state read-only and generates PDFs behind an internal API key. Human editor access uses P permissions. P owns the durable print queue and CUPS worker.

V2 keeps editor/renderer separation. Template writes need revision/CAS or a transactional store to prevent concurrent lost updates. Product lists in L are editor inputs only, never catalog authority. The duplicate P/L template model must be retired.

### O — Operations

O owns hardened Compose, CI/E2E orchestration, backup/restore scripts and documentation. PR01 adds a redacted manifest/schema/validator, service-specific runtime provenance collection, config fingerprints and adversarial tests. Runtime verification requires actual container/image identity and OCI revision; Git checkout HEAD alone is not proof.

Current backup assets are useful but do not yet prove a transactionally coherent, encrypted, off-site, full-system recovery set or an isolated end-to-end restore.

### Customer Hub adjacency

O also composes Customer Hub. It is outside the five-repository ARCH-00 code scope but is a real deployed adjacent bounded context with its own DB/attachments. ARCH-00 preserves it. Any V2 business integration or ownership change requires a separately scoped review and ADR; it may not be silently folded into P.

## Current readiness carried forward

The audit's central conclusion still governs until replaced by gate evidence: catalog review, layout planning, kit drafting and controlled label preparation may be useful, but stock, picking, sales, refunds, cash, finance, broad auth, backup/restore, production runtime and scalability are not accepted as authoritative merely because source paths exist.

No ARCH-00 document closes a code, historical-data, runtime or production gate.
