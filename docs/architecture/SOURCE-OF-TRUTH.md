# Source of truth contract

## Meaning

A source of truth is the authoritative record plus the only accepted command path for a fact. A cache, calculated field, UI state, exported CSV, rendered label, marketplace copy, report or backup is not a second source of truth.

## Target fact map

| Fact | Authoritative record | Identity/version | Derived or cached copies | Conflict rule |
| --- | --- | --- | --- | --- |
| Product/SKU | P Catalog aggregate | stable product ID + version | K catalog cache, UI/search indexes, marketplace listing | core version wins; incompatible external change quarantined |
| Base UOM/conversions | P Catalog UOM record | conversion version/effective time | sale/kit/receipt snapshots | historical snapshot wins for history |
| Supplier | P Procurement supplier | supplier ID/version | K design reference, finance projection | core supplier version wins |
| Purchase order/lines | P Procurement purchase order | PO/line ID + approval version | supplier export, receipt plan | approved commercial intent immutable/superseded |
| Supplier shipment/lines | P Procurement supplier shipment | shipment/line ID + external reference | receipt plan, cost allocation | expected movement is not physical stock |
| Receipt/lot | P Inventory/Procurement | receipt event + lot ID | W screens, labels | event is immutable; correction compensates |
| Physical stock | P inventory ledger and container state | event/operation IDs | product on-hand/available projections | reconciliation flags; no auto overwrite |
| Reservation | P reservation aggregate | reservation ID/version | order/W views | command CAS; expiry/release explicit |
| Package/location | P Warehouse/Inventory aggregate | package and location IDs + state versions | W map/task views, labels | moves are versioned internal transitions; no independent W copy |
| Sale/order line | P Sales snapshot | canonical order + line version | W pick view, marketplace mapping, reports | accepted snapshot immutable |
| Return/refund | P Returns state machines | return/refund IDs and versions | channel/cash/inventory views | states remain separate and reconciled |
| Cash/finance posting | P Finance ledger | document/entry/operation IDs | dashboards, exports | ledger wins; corrections reverse |
| Expense document | P Finance expense aggregate | expense/version + posting reference | attachments, dashboard/report projection | edit after posting reverses/supersedes; never silent cash rewrite |
| FX observation | P FX registry | provider/time/pair/version | current display cache | transaction snapshot wins for history |
| Lot acquisition cost | P Acquisition Cost snapshot | lot + approved cost version | product current-cost projection, reports | approved snapshot immutable |
| Effective price | P Pricing price-list entry | price list/version/effective interval | marketplace/listing copies, K preview | core approval wins; publish is async |
| Kit draft/authored version | K workspace | kit/version/content hash | UI exports | K version immutable after submission |
| Published kit | P Published Kits snapshot | publication ID + K hash + core policy hash | K publication reference, sales catalog | core publication immutable |
| Marketplace inbound | P connector inbox | channel/order/version/digest | support views | duplicate replay returns prior result |
| Shipment/tracking | P Shipping aggregate | shipment/parcels/version | marketplace/customer projections | carrier event validated then domain transition |
| Label template | L template store | template/version/content hash | core print-job snapshot | CAS conflict; no silent overwrite |
| Print intent/attempt | P Printing aggregate | job/attempt/operation IDs | W/P status UI | unknown delivery remains unknown |
| User/session/service principal | P Identity & Access | user/session epoch/key ID | cookies, request context | live authority wins; stale session rejected |
| Runtime release | O generated release evidence | service + image digest + OCI revision + container | documentation, UI version strings | missing/contradictory evidence is NOT VERIFIED |
| Recovery point | O backup manifest plus checksummed assets | recovery-set ID | off-site replicas | only complete, restore-tested set accepted |

## Projection rules

1. A projection declares its source version or update cursor and staleness.
2. A projection can be deleted and rebuilt without losing authoritative history.
3. Projection writes never call back into their source table as reconciliation.
4. UI-computed totals are display aids unless returned by an authoritative query contract.
5. K `panel_connector_cache`, W browser state, L `products`, marketplace listing state, reports and CSV exports are non-authoritative.
6. `products.central_stock`, current purchase cost and current sale price become controlled projections only after the new ledgers/policies are accepted; migration must preserve old values for reconciliation.
7. Under ADR-0009, only an explicitly registered disposable projection may be rebuilt automatically from its canonical source with before/after audit evidence. Canonical records are never auto-repaired.

## Historical truth

Historical documents carry the semantic values used when accepted:

- product/SKU/name and UOM conversion;
- quantity and BOM/component/cut/waste;
- native price, discount, tax and fee scope;
- acquisition cost and lot/consumption provenance;
- exchange rate and rounding;
- template/version for printed output;
- actor, policy/formula/schema version and operation identity.

Current master data may answer “what would it cost now?” but cannot answer “what was accepted then?” unless the historical snapshot says so.

## Import, migration and repair

| Mechanism | May do | Must not do |
| --- | --- | --- |
| Catalog CSV | propose validated master changes | set physical stock/cash/history |
| Opening inventory batch | create one approved dated opening ledger batch | masquerade as receipt or overwrite balance |
| Receipt import | create procurement/receipt intent | post on-hand before physical acceptance |
| Schema migration | create/transform schema deterministically | silently invent business policy or repair unknown data |
| Data repair | apply an approved bounded manifest with evidence | run automatically with deploy or hide differences |
| Backup restore | restore an entire compatible recovery set in a gated process | merge arbitrary restored rows into live production |

## Unresolved source-of-truth decisions

The following remain `DECISION REQUIRED` and block dependent authority:

- accounting/reporting currency and tax/rounding policy;
- dispatch physical boundary;
- inventory consumption/cost-flow method;
- acquisition-cost allocation and tax treatment;
- partial fulfillment/refund/return policies;
- settlement and bank reconciliation ownership;
- supported UOM precision and material cut/waste rules;
- authoritative Customer Hub integration facts;
- RPO/RTO, retention, recovery owner and off-site provider.

Existing defaults, database columns or UI labels do not resolve these decisions.
