# Domain ownership

Ownership means the only component allowed to accept authoritative commands for that concept. Storage location alone does not create ownership. Consumers use versioned APIs/events and may keep disposable projections.

## Binding ownership matrix

| Domain / aggregate | Authoritative owner | System of record | Allowed writers | Consumers / projections | Boundary rule |
| --- | --- | --- | --- | --- | --- |
| Human identity, role, capability, session epoch | P Identity & Access module | Core DB | P auth/admin services | P/W/K/L/Hub sessions | No local user databases in W/K/L; live validation required. |
| Service principal, key hash, scope, revocation | P Identity & Access module | Core DB | P security admin | W/K/L/adapters | Service identity never substitutes for user identity. |
| Product/SKU, aliases, typed attributes, base UOM | P Catalog module | Core DB | P catalog commands | W, K cache, L print payload, connectors | UI/cache/import cannot be master. |
| Supplier identity and procurement document | P Procurement module | Core DB | P procurement commands | receipt, cost, finance | K supplier records become design references/projections where overlapping. |
| Receipt intent and goods receipt | P Procurement + Inventory modules | Core DB | P domain command invoked by P/W | W workflow, finance | W orchestrates UI only; receipt plan is not stock. |
| Lot/container/location stock and ledger | P Inventory module | Core DB | P Inventory service only | W, P UI, sales, reconciliation | No direct product stock writes outside Inventory. |
| Reservation | P Inventory module | Core DB | P reservation commands | sales, W pick | Reservation is not OUT. |
| Warehouse workflow | P Warehouse module; W is interaction client | Core DB | P Warehouse commands | W PWA, P admin/report | Workflow state and inventory posting are coordinated in one transaction. |
| Canonical order/sale and immutable lines | P Sales module | Core DB | P Sales commands/adapters through inbox | W, finance, connectors | Marketplace staging cannot directly mutate stock/cash. |
| Return/refund intent and state | P Sales & Returns module | Core DB | P return/refund commands | inventory, finance, marketplace | Physical return and money refund are separate effects. |
| Shipment/parcels/tracking | P Shipping module | Core DB | P Shipping commands + carrier adapter results | W, marketplace, customer channels | Carrier status never directly posts stock without domain transition. |
| Cash accounts, postings, expense/income documents | P Money & Finance module | Core DB | P finance commands | reports/reconciliation | Currency-safe posting only; UI calculations are projections. |
| FX observations and transaction FX snapshots | P Money & Finance module | Core DB | approved provider importer/manual approval | pricing, cost, sales, reports | Display/current FX cannot rewrite history. |
| Acquisition-cost policy and lot cost snapshots | P Acquisition Cost module | Core DB | P cost commands/approval | inventory valuation, pricing, kit publish | Product master cost is a current projection, not historical truth. |
| Price lists/policies/effective approved prices | P Pricing module | Core DB | authorized P pricing commands | sales, K simulations, marketplaces | Connector/platform publish is an external side effect. |
| Editable kit drafts, compatibility and authored versions | K Kit Workspace | K DB | K authenticated commands | K UI, core approval proposal | K may cache P catalog read-only; no canonical stock/cost/price writes. |
| Published/sellable kit and approved economic snapshot | P Published Kits module | Core DB | core approval command | P/W/K/connectors | Snapshot references exact K authored content hash. |
| Legacy kit data | P legacy model during migration | Core DB | read-only after migration start | migration/reconciliation | Retire after signed reconciliation; no competing new writes. |
| Marketplace raw inbox/cursor/external mapping | P Marketplace module | Core DB plus protected payload store if needed | connector adapter | Sales, support, reconciliation | Verify signature and deduplicate before canonical order. |
| Marketplace credential | P security/integration vault boundary | encrypted core storage or approved secret manager | authorized integration admin | adapter runtime only | Never exposed after creation or copied to O evidence. |
| Label template and version | L Template domain | L state/store | L editor API with CAS | renderer, P print job snapshot | P template tables retire as editable authority. |
| Print job intent/state | P Printing module | Core DB | P print commands/worker results | W/P UI, L renderer | Job snapshots L template version; physical delivery may be unknown. |
| PDF rendering | L renderer | deterministic output, not SoT | renderer only | P/local worker | Rendering has no inventory/finance authority. |
| Physical printer interaction | local print worker/CUPS boundary | durable attempts in core; device external | worker | operators/status UI | Spool acceptance is not physical confirmation. |
| Release manifest/runtime provenance | O Release domain | versioned schema + generated evidence | O collector/validator | CI/operators/audit | Only runtime-derived, service-specific evidence may verify. |
| Backup manifest/recovery orchestration | O Recovery domain | backup repository/catalog | O scripts/operators | restore drills/audit | O does not become owner of business rows. |
| Customer Hub conversations/attachments | Customer Hub, unchanged | Hub DB/attachments | Hub service | future approved integrations | Outside five-repo domain redesign; separate ADR required. |

## Domain contract index

Public contracts below are target contract families, not claims that every endpoint exists. Commands are authenticated, authorized, idempotent and versioned; queries return projections with source version/staleness.

| Domain | Purpose and owned data | Public command/query contracts | Dependencies | Prohibited writes and key invariants |
| --- | --- | --- | --- | --- |
| Catalog | Stable product/SKU/alias, category, typed attributes, dimensions, weight, base/purchase/sale units and conversions. | product create/version/retire; alias and UOM management; catalog query/export. | Identity; Audit. | No stock/cost/price posting; identity stable; conversions versioned and snapshotted. |
| Procurement | Suppliers, PO/lines, supplier shipment/lines, receipt intent and documents. | supplier/PO lifecycle; shipment notice; goods-receipt proposal/query. | Catalog; Identity; Audit. | Cannot post on-hand or finalized cost directly; expected is not received. |
| Acquisition Cost | Shipment cost components, allocation runs, lot cost versions/finalization and provenance. | cost preview/finalize/supersede/query. | Procurement; Catalog; Money/FX; Inventory lot. | Cannot invent tax policy or rewrite finalized history; totals and residue reconcile. |
| Inventory | Ledger events, lot/container balance, status, reservation and projections. | receive/return/adjust/reserve/release/dispatch; availability and reconciliation query. | Catalog/UOM; Procurement; Sales/Shipping actor references. | Only Inventory writes physical quantity; one physical event; conservation holds. |
| Warehouse | Receiving/putaway/move/count/pick/pack workflow, locations and configurable storage rules. | workflow commands and task/map/package queries via P; W calls these. | Inventory; Sales; Printing; Identity. | No direct stock-field write; internal moves do not alter global on-hand; count difference explicit. |
| Sales / Orders / Returns | Canonical order, immutable lines/economics/BOM, cancellation, refund and return intent/state. | accept/reserve/cancel/refund/return commands; order/detail/status queries. | Catalog; Pricing; Inventory; Finance; Shipping. | Cannot directly edit stock/cash; refund and physical return are independent; snapshots immutable. |
| Finance / Money | Currency, FX observations/snapshots, accounts, postings, expenses/income and reporting read models. | post/reverse/transfer; FX record; ledger and report queries. | Sales; Procurement/Cost; Identity. | No unlike-currency sum or live-FX history rewrite; postings balance and replay once. |
| Pricing | Effective price lists, formula/policy versions, approval and channel publication intent. | calculate/preview/approve/retire/publish; effective-price query. | Catalog; Cost; Money; Kit publication. | Cannot mutate historical sale/kit price; missing policy blocks approval. |
| Kit | K drafts, compatibility, cuts, authored versions; P published kit snapshot and sellable SKU. | K draft/version; core preview/approve/publish; relationship queries and deep link. | Catalog/UOM; Cost; Pricing; Identity. | K cannot write canonical catalog/cost/price/stock; published hash is immutable. |
| Auth / Identity / Session | Users, password hashes, roles/capabilities, session epoch, service principals/scopes. | login/logout/me/change/reset; user/capability/key administration and token validation. | Audit; secret storage. | Service identity cannot replace human authorization; revocation is live and global. |
| Printing | L templates/versions/rendering; P jobs/payload snapshots/attempts/delivery state. | template CAS/version/query; create/cancel/retry/resolve job; render exact version. | Identity; Warehouse/Shipping; local print agent. | Renderer cannot mutate business state; submission is not physical confirmation. |
| Marketplace / Channels | Connector config/secret reference, stage/prod separation, inbox/cursor/raw digest, mapping and outbox publish jobs. | webhook/poll ingest; quarantine/accept/reconcile; listing/status publish. | Sales; Catalog; Pricing; Finance settlement; Identity. | Payload cannot directly write sale/stock/cash; external identity/version unique. |
| Shipment / Carrier | Shipment/parcels/content snapshots, carrier job/label/tracking events and dispatch state. | create/pack/label/void/dispatch; carrier-event ingest; track/query. | Sales; Warehouse; Inventory; Printing; Marketplace. | Carrier state cannot silently post inventory; event history append-only; marketplace and carrier states distinct. |
| Backup / Restore | Recovery-set manifest, checksums, encrypted assets, restore runs and verification evidence. | create/verify/restore-to-staging/promote runbooks outside business API. | Every persistent store; PR01 release identity; secret-recovery procedure. | O never edits business rows; a file copy is not an accepted recovery point. |
| Audit / Reporting | Append-only security/business audit, reconciliation and disposable reporting projections. | audit/reconciliation/report query and export with authorization/redaction. | All domains; outbox/projection workers. | Reports cannot mutate source facts or auto-repair; secrets and unnecessary personal data excluded. |

## Module interaction rules

Inside P, modules may participate in one database transaction through an application command coordinator. That does not permit arbitrary table access:

- each table/repository has one owning module;
- cross-domain reads use declared query ports or immutable snapshots;
- cross-domain writes call the owner in the same transaction context;
- external consumers never receive a database handle;
- events emitted outside the transaction come from a committed outbox record;
- reporting may use read models/views but cannot mutate source tables.

## Human and service responsibility

| Action class | Required human capability | Service identity | Additional control |
| --- | --- | --- | --- |
| Catalog maintenance | `catalog:write` | optional client scope | validation + audit |
| Receipt/place/move/pick/pack | relevant warehouse capability | `warehouse:*` | user + service identities, operation key |
| Count adjustment | `inventory:count:approve` | `warehouse:write` | expected/observed diff + reason |
| Dispatch | `shipping:dispatch` | warehouse/carrier scope | owner-approved physical boundary |
| Refund/return | `sales:refund` / `returns:*` | channel scope | separate money/physical transitions |
| Cost/price/kit approval | named approval capability | client scope | exact snapshot hash and policy version |
| Connector/key management | `integrations:admin` | none as substitute | write-only secret + rotation audit |
| Repair | `data:repair:approve` | controlled repair principal | backup, preview, bounded manifest |
| Restore/deploy | operations capability outside app | O tooling identity | maintenance gate + rollback/evidence |

Capability names are architectural placeholders until the access-control contract is implemented; they must not be treated as existing permissions.

## Prohibited ownership patterns

- W holding or calculating authoritative stock independently.
- K becoming a second catalog, product-cost, sale-price or sellable-SKU authority.
- L product imports becoming catalog truth or L renderer changing business state.
- P and L both accepting editable template writes.
- marketplace/carrier callbacks directly editing stock, cash or order tables.
- O scripts directly editing production business data.
- reports, dashboards or repair jobs rewriting source facts.
- a service API key granting the human permissions missing from a request.
