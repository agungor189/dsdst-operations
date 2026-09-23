# V2-18 Independent System Gate

Date: 2026-09-23  
Branch: `codex/v2-18-independent-system-gate`  
Scope: O, P, W, K, L, Customer Hub, renderer, Compose, recovery, and release controller  
Verdict: **FAIL — CODE VERIFIED / RUNTIME NOT VERIFIED**

V2-18 is the last code/system gate before a limited pilot. The source and isolated
system gates below are green. The gate remains FAIL because no collector-bound
production/candidate runtime evidence was available. A green source tree is not
runtime proof under PR01.

## 1. Exact source set

The supplied V2-17 revisions were verified before work began. Operations was at the
accepted V2-17 closure, which is an allowed controller descendant of the immutable O
content revision in `config/v2-17-source-set.json`; no component revision was silently
substituted.

| ID | Supplied V2-17 content | Verified starting state |
| --- | --- | --- |
| O | `05494350af247e3bb31cc87bfdbe0dcfe303348f` | closure `b62cc89d586ddde15c9a0fe9e5ee71a66d2b43d1` |
| P | `61ed1ad8fba25ed9d5c0b228308ff22da45febaf` | exact |
| W | `525e18c508c1191c0c4e4b725bda00defd930d2f` | exact |
| K | `0e0717c3f8d3f3f0af186b4c165524bc2e81724c` | exact |
| L / renderer | `add3987e0eb15e8742ecac490b5eb4e78b620ce5` | exact |
| Hub | `f030c29b6ee41765289993fda1e94d1e484b5cac` | exact |

The final immutable V2-18 release content is pinned by
`config/v2-18-source-set.json`:

| ID | Repository | V2-18 release content |
| --- | --- | --- |
| O | `agungor189/dsdst-operations` | `c632d0fd8d768529795d933d3d4f1d369a26faf1` |
| P | `agungor189/panel-kit-yonetimi` | `3f90996cedc73ff6f656d264db3ee3baa0bbdd03` |
| W | `agungor189/Dsdst-Warehouse` | `525e18c508c1191c0c4e4b725bda00defd930d2f` |
| K | `agungor189/dsdst-kit-studio` | `0e0717c3f8d3f3f0af186b4c165524bc2e81724c` |
| L / renderer | `agungor189/Label-Printer` | `add3987e0eb15e8742ecac490b5eb4e78b620ce5` |
| Hub | `agungor189/dsdst-customer-hub` | `79834966b43daec4ca32f906534aaf11fadd9d55` |

The Operations documentation/closure commit may descend from the pinned O content;
the verifier permits that exception only for O and requires every other repository to
remain exact.

## 2. Test matrix

| Gate | Evidence | Result |
| --- | --- | --- |
| Exact source / CI / E2E | V2-18 manifest, workflow-output parser, exact verifier, negative historical-manifest tests | PASS |
| O architecture/contracts | `npm test` | PASS — 218/218 |
| P domain/routes/security | `npm test` | PASS — 278/278 |
| W client/BFF | `npm test`; typecheck; build; post-build secret scan | PASS — 102/102 |
| K authoring client | `npm test`; typecheck; build | PASS — 78/78 |
| L and renderer | `npm test`; lint; build | PASS — 17/17 |
| Customer Hub | `npm test`; typecheck; build | PASS — 16/16 |
| Changed P/Hub builds | production builds after final code changes | PASS |
| Shell safety | `shellcheck` and `sh -n` for Operations/release scripts | PASS |
| Cross-system local E2E | exact O/P/W/K/L/Hub source; real processes; isolated databases | PASS — 1/1 |
| Compose merge model | prod + e2e/recovery/candidate rendered by Docker Compose | PASS — 1/1 |
| Recovery / release | included recovery integrity, RPO/RTO, controller, cutover, rollback and tamper tests | PASS |
| Container E2E | Ubuntu `dsdst-server`; exact set `SOURCE_SET_MANIFEST=config/v2-18-source-set.json ./scripts/e2e.sh` | PASS — 1/1, exit 0 |
| Deployed runtime | PR01 container/image/config/schema/volume/network/port evidence | NOT VERIFIED |

The local cross-system E2E executed real Panel, Warehouse BFF, Kit Studio, Label
Printer, renderer and Customer Hub processes. It covered password rotation and revoked
cookies; scoped service authentication; canonical catalog creation; procurement cost
snapshot; Warehouse receipt; canonical stock creation; immutable label template
selection; preview/render; package identity, suggestion and placement; sale financial
snapshot and reservation; and Warehouse picking. Stock was 5 after receipt and stayed
5 after placement, sale acceptance and internal pick, preserving the approved dispatch
boundary.

The subsequent Ubuntu `dsdst-server` container run brought Panel, Warehouse, Kit
Studio, Label Printer, renderer and Customer Hub up healthy and passed the same
canonical receiving, live-template, label, placement and picking workflow (tests 1,
pass 1, fail 0, exit 0). This closes the container-integration blocker. The E2E script
builds disposable local images, so this result does not establish an immutable registry
digest, OCI source/revision, deployed schema/config/topology provenance, recovery point
or cutover state.

## 3. Findings and fixes

### V218-01 — CI could test an obsolete source set

- Severity: P1
- Component: O / CI / source verification
- Invariant: A green V2-18 workflow must test the exact V2-18 source set.
- Reproduction: inspect the E2E workflow and defaults; component checkout assumptions
  still referred to historical revisions rather than one selected manifest.
- Root cause: workflow revisions and script defaults were duplicated instead of derived
  from the release manifest.
- Fix: added the V2-18 manifest and workflow-output parser; made CI/E2E select V2-18;
  required exact P/W/K/L/Hub revisions and only the documented O-controller descendant.
- Regression test: `tests/v2-18-source-set.test.mjs` and updated source-set tests.
- Residual risk: none in source; a remote workflow run is still runtime/external evidence.

### V218-02 — Customer Hub used a stale Panel auth contract

- Severity: P1
- Component: Hub ↔ P
- Invariant: Hub human sessions must be backed by an authenticated, scoped Panel service
  identity and must not invent a parallel authority.
- Reproduction: contract-test Hub login against current Panel service login/me/logout;
  the old client did not establish or close that service session.
- Root cause: Hub integration predated Panel's scoped service-auth contract.
- Fix: Hub now authenticates through `/api/auth/service/login`, validates through
  `/api/auth/service/me`, logs out through Panel, requires `PANEL_API_KEY` in production,
  and binds the local human session to the service identity.
- Regression test: `server/panel/client.contract.test.ts` plus Hub integration tests and
  the real local cross-system E2E.
- Residual risk: deployed key provisioning and revocation remain runtime-only.

### V218-03 — Stock discrepancy could leak into marketplace availability

- Severity: P1
- Component: P inventory / channel outbound
- Invariant: physically non-sellable or discrepancy-blocked stock must not be published
  as sellable stock; canonical on-hand and publishable stock are distinct.
- Reproduction: create positive on-hand with an open `STOCK_DISCREPANCY` and project a
  stock update.
- Root cause: outbound projection used canonical available quantity without consulting
  the exact reconciliation block.
- Fix: positive stock is published as zero while any relevant stock-discrepancy block
  remains open; canonical on-hand is retained for reconciliation and the reason is
  recorded.
- Regression test: channel gateway tests for discrepancy-blocked publication.
- Residual risk: live marketplace acknowledgement is runtime-only.

### V218-04 — Legacy analytics changed the meaning of revenue/profit

- Severity: P1
- Component: P dashboard, product analytics, insights
- Invariant: reporting must derive from immutable sale snapshots with named financial
  semantics; gross after seller discount is not gross before discount.
- Reproduction: sale gross 100,000 minor, discount 10,000 minor; legacy queries reported
  100,000 where the after-discount gross/revenue basis is 90,000.
- Root cause: legacy `sales`/`sale_items` columns were mixed with V2-09/V2-10 snapshot
  semantics and could fabricate profit for unsnapshotted sales.
- Fix: dashboard, product analytics and insights now read immutable snapshot, line and
  component facts; metrics explicitly use after-discount VAT-inclusive gross; legacy
  profit is blocked/null rather than guessed.
- Regression test: `server/routes/v218FinancialReporting.test.ts`.
- Residual risk: historical unsnapshotted records remain explicitly incomplete, not
  silently recalculated.

### V218-05 — Hub CSRF exemption was broader than the signed webhook

- Severity: P1
- Component: Customer Hub security
- Invariant: unsafe browser requests require the exact configured Origin; only the exact
  independently signed webhook endpoint may bypass Origin.
- Reproduction: submit an unsafe request under a webhook-like path without Origin.
- Root cause: exemption matching was path-prefix based.
- Fix: require exact `/api/webhooks/meta`; all other unsafe requests require exact Origin.
- Regression test: `server/auth/csrf.test.ts`, including a future webhook path denial.
- Residual risk: edge-proxy header behavior must be observed at runtime.

### V218-06 — Compose overlays inherited production port publications

- Severity: P1
- Component: O Compose
- Invariant: E2E and recovery publish no host ports; candidate publishes only five
  loopback-bound ports.
- Reproduction: render merged prod + overlay models and inspect `ports`.
- Root cause: normal Compose sequence merging retained base production port entries.
- Fix: use explicit override/reset semantics and validate the merged model.
- Regression test: `tests/v2-18-compose.test.mjs`.
- Residual risk: observed host bindings remain runtime-only.

### V218-07 — Local E2E could run with a different Node ABI

- Severity: P2
- Component: O local E2E
- Invariant: native modules must execute with the repository/toolchain ABI under test.
- Reproduction: the runner downloaded Node 24 while repositories and images used Node 22,
  causing native SQLite ABI failure.
- Root cause: the runner selected a downloaded convenience runtime.
- Fix: default to the installed repository Node executable.
- Regression test: V2-18 source/E2E contract test plus successful local E2E.
- Residual risk: developer machines still must provide a compatible Node executable.

### V218-08 — macOS temporary-path alias broke Kit upload safety

- Severity: P2
- Component: O local E2E / K filesystem guard
- Invariant: test fixtures must not weaken Kit's symlink/parent-path protection.
- Reproduction: macOS `/var` resolves through `/private/var`; Kit rejected the aliased
  upload parent.
- Root cause: the runner passed the lexical temp path rather than its physical path.
- Fix: resolve the temporary root with `pwd -P` before starting services.
- Regression test: successful local E2E with Kit's safety check unchanged.
- Residual risk: none identified.

### V218-09 — System E2E bypassed canonical V2 boundaries

- Severity: P1
- Component: O cross-system E2E
- Invariant: the gate must exercise owner APIs, immutable procurement/sale snapshots and
  Warehouse execution, not retired imports or direct stock mutation.
- Reproduction: old test used legacy product import, batch/placement and direct receipt
  paths; canonical APIs rejected those shortcuts.
- Root cause: the E2E predated V2-05 through V2-09 ownership boundaries.
- Fix: rewrote the path around canonical catalog, procurement, Warehouse receipt,
  identity/suggestion/placement and immutable sale-financial contracts.
- Regression test: `tests/operations.e2e.mjs`.
- Residual risk: carrier/provider network calls remain contract-tested rather than live.

### V218-10 — Kit E2E service identity lacked catalog read scope

- Severity: P1
- Component: P seed / K ↔ P
- Invariant: Kit may read Panel catalog using a least-privilege service identity while
  Panel remains publication/approval authority.
- Reproduction: start Kit with the seeded key and perform Panel catalog sync.
- Root cause: the E2E seed omitted `catalog:read` from the Kit service key.
- Fix: added only the missing read scope.
- Regression test: exact local cross-system E2E.
- Residual risk: deployed scope assignment remains runtime-only.

### V218-11 — Customer Hub E2E backup volume was undeclared

- Severity: P1
- Component: O Compose / Hub
- Invariant: every named state/backup volume in a merged model must be declared and
  isolated to the test project.
- Reproduction: render/run prod + E2E with `CUSTOMER_HUB_BACKUP_DIR=customer_hub_backups`;
  Compose rejected the undefined volume.
- Root cause: E2E selected a named volume but the overlay declared only networks.
- Fix: declare the isolated Hub backup volume in the E2E overlay and reproduce that env
  selection in the merge-model regression.
- Regression test: `tests/v2-18-compose.test.mjs`.
- Residual risk: none for the E2E overlay; the exact Ubuntu container E2E is green.

### V218-12 — Runtime provenance is absent

- Severity: P1 (open go-live blocker)
- Component: deployed O/P/W/K/L/Hub/renderer topology
- Invariant: runtime claims require service-specific image digest, container identity,
  OCI/source revision, configuration fingerprint, schema and topology evidence.
- Reproduction: the exact-source Ubuntu container E2E passes, but it uses locally built
  disposable images and no accepted PR01 production/candidate evidence bundle was
  supplied.
- Root cause: an integration test proves cross-system behavior, not registry identity or
  the physical identity/configuration/state of a deployed runtime.
- Fix: none fabricated; status remains `NOT VERIFIED`.
- Regression test: release-evidence validators correctly reject incomplete or invented
  runtime claims.
- Residual risk: actual deployed images, config, schema, volumes, networks, ports, health,
  recovery point and cutover state are unknown.

## 4. Boundary and adversarial coverage

| Area | Verified invariant |
| --- | --- |
| Authentication | cookie-only browser JWTs, logout/password-change revocation, disabled/changed users, readonly denial, scoped service keys, wrong-key denial, exact Origin, service-bound Hub sessions |
| Inventory | non-negative on-hand/reserved, `reserved <= on_hand`, ledger/location equality, concurrency/idempotency, corrections, returns, kerf/profile cuts, discrepancy-blocked publication |
| Finance | integer minor units, VAT/FX/discount/commission/COGS, expense facts, partial/full return provenance, immutable sale snapshots, explicit reporting semantics |
| Channels | duplicate/stale/versioned inbound, pagination, mapping/commission unknowns, package reconciliation, retry/429/timeout, outbound dedupe, stock/price/tracking publication |
| Shipping | create/dedupe/void/retry/timeout/tracking/multi-parcel; only confirmed physical handoff dispatches stock/COGS |
| Printing | L template authority and CAS, P immutable job snapshot/dedupe, render/worker uncertainty, reasoned reprint, `DELIVERY_UNKNOWN`; spool acknowledgement is not physical delivery |
| Kit | Panel catalog sync, compatibility/pricing, profile cuts and unknown economics, immutable publication/sale snapshot; Panel retains approval authority |
| Reconciliation | read-only detection, exact scope block, approval/audit, domain-command repair, idempotency; no startup or migration repair |
| Recovery | complete P/K/L/Hub state, uploads/attachments, hashes/HMAC, source/image/schema provenance, tamper/corruption/incomplete/stale rejection, isolated drill logic |
| Release | approval/plan/image/source/migration/health/smoke/final-hydration gates, route reconciliation, crash/retry, one-writer fencing, rollback safety and append-only evidence |
| Compose | merged ports, loopback, internal network, volume isolation, read-only roots, dropped capabilities, no-new-privileges, health checks and renderer shared state |

## 5. Remaining risks and runtime-only gates

No open P0 remains. All source-discovered P1 and P2 defects except runtime provenance are
closed by regression tests. One P1 go-live blocker remains:

1. **Registry/OCI artifact gate.** Publish P/W/K/Hub/L and the O toolbox from their exact
   V2-18 revisions to an approved registry. Every candidate reference must be
   `repository@sha256:<64 hex>` and retain `RepoDigests`. Images must carry exact
   `org.opencontainers.image.source` and `org.opencontainers.image.revision` labels. P,
   W, K and Hub require independent image identities; Label Printer and renderer must use
   the same L image, digest and revision. A local tag, local image ID, Git HEAD, build log
   or successful E2E image is not runtime provenance. The manual
   `publish-v2-18-images.yml` workflow and its fail-closed manifest validator are now
   source-ready; this item remains open until a successful GHCR run produces and preserves
   the six immutable registry references.
2. **Read-only PR01 provenance gate.** On an already running, digest-pinned exact V2-18
   runtime, collect one bound observation for all six services: unique full container
   IDs, declared/observed registry reference, immutable image ID/digest, OCI labels,
   redacted config fingerprint, read-only schema version, exact volume source identity,
   networks and ports. Validate it together with a redacted release-evidence manifest.
3. **Recovery gate.** Create an exact V2-18 recovery point containing P/K/L/Hub state and
   files, source set and runtime provenance; persist it offsite; then complete an isolated
   restore drill within RPO/RTO. The reviewed recovery profile now accepts only the exact
   canonical V2-18 manifest (while preserving V2-16 compatibility); execution evidence is
   still missing. A V2-16 point cannot be relabeled as V2-18 evidence.
4. **Candidate/cutover gate.** After 1–3, prove a separately named candidate project,
   networks, ports and new volume identities, then migration preflight, hydration,
   health, read-only smoke, connectivity, one-writer fencing and route reconciliation.
   The reviewed controller now accepts exact V2-17 and V2-18 profiles and regression-tests
   the V2-18 prepare-through-rollback state path. Runtime execution evidence is still
   missing. Candidate services must never mount an existing production volume. Cloudflare
   mutation remains a separately approved final action and was not performed here.

## 6. Next safe runtime-provenance step

The next safe action is registry preparation followed by read-only collection; it is not
a deploy, restart, migration, restore or route mutation. Run from the exact V2-18 O
checkout on the authorized host without `set -x`, `tee` or terminal recording:

```sh
set -euo pipefail
cd /approved/path/dsdst-operations

EXPECTED_SOURCE_SET_RELEASE=V2-18 \
SOURCE_SET_MANIFEST=config/v2-18-source-set.json \
node scripts/verify-source-set.mjs --allow-operations-descendant
```

Before any candidate is started, its protected environment must pass the digest-reference
shape check and each approved reference must exist in the registry. The variables below
must come from the approved artifact record, not from local tags:

```sh
V218_PROJECT=dsdst-candidate-v2-18
V218_CANDIDATE_ENV=/approved/secrets/v2-18-candidate.env

node scripts/release/verify-candidate-env.mjs \
  "$V218_CANDIDATE_ENV" "$V218_PROJECT"

: "${PANEL_IMAGE:?set approved digest reference}"
: "${WAREHOUSE_IMAGE:?set approved digest reference}"
: "${KIT_STUDIO_IMAGE:?set approved digest reference}"
: "${CUSTOMER_HUB_IMAGE:?set approved digest reference}"
: "${LABEL_PRINTER_IMAGE:?set approved digest reference}"
: "${OPERATIONS_TOOLBOX_IMAGE:?set approved digest reference}"

for image in \
  "$PANEL_IMAGE" "$WAREHOUSE_IMAGE" "$KIT_STUDIO_IMAGE" \
  "$CUSTOMER_HUB_IMAGE" "$LABEL_PRINTER_IMAGE" "$OPERATIONS_TOOLBOX_IMAGE"
do
  docker buildx imagetools inspect "$image" >/dev/null
done
```

Do not call `candidate-stack.sh up` from this report update. Once an authorized,
already-running exact V2-18 digest-pinned runtime exists, collect only read-only evidence:

```sh
EVIDENCE_COMPOSE_FILE=/approved/path/dsdst-operations/compose.prod.yml
EVIDENCE_ENV_FILE=/approved/secret-store/v2-18-runtime.env
EVIDENCE_DIR=/approved/redacted/v2-18
install -d -m 0700 "$EVIDENCE_DIR"

node scripts/collect-runtime-provenance.mjs \
  "$EVIDENCE_COMPOSE_FILE" "$EVIDENCE_ENV_FILE" \
  > "$EVIDENCE_DIR/runtime-provenance.json"

jq -e --slurpfile sourceSet config/v2-18-source-set.json '
  ($sourceSet[0].repositories
    | map({key: .repository, value: .revision}) | from_entries) as $expected
  | all(.services[]; .revision == $expected[.source_repository])
' "$EVIDENCE_DIR/runtime-provenance.json"

node scripts/validate-release-evidence.mjs \
  "$EVIDENCE_DIR/release-evidence.json" \
  "$EVIDENCE_DIR/runtime-provenance.json"
```

The final validator command is run only after `release-evidence.json` is populated from
that same collector capture. Any missing registry digest, wrong/missing OCI label,
source-set mismatch, local-only image, reused independent image, L/renderer mismatch,
old production volume on a candidate, unexpected network or non-loopback port must fail
closed and remain `NOT VERIFIED`.

## 7. Final verdict and V2-19 entry criteria

**V2-18: FAIL.**

- Source/code/system status: **CODE VERIFIED**.
- Runtime/deployment status: **RUNTIME NOT VERIFIED**.
- Open severity count: P0 = 0; P1 = 1 runtime go-live blocker; P2 = 0; P3 = 0.
- V2-19 limited pilot is blocked until all four ordered runtime-only items above are evidenced
  against the exact V2-18 source set and the PR01 validator reports VERIFIED.
