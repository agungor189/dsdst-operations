# V2-15 — Reconciliation and repair implementation

Status: Implemented in feature branches; not merged or deployed

Date: 2026-09-23

## Ownership and schedule

P owns `reconciliation_runs`, current deterministic findings, repair proposals, immutable history and exact SKU/order blocks. The local application scheduler runs daily at 03:00 in explicitly configured `Europe/Istanbul` business time by default. Panel exposes “Şimdi kontrol et”; W exposes only open Inventory/SKU findings and no repair mutation.

## Finding and block model

Finding identity is SHA-256 over domain, finding code, affected scope, affected identity and canonical source reference. A repeated mismatch updates one row and increments occurrences; same-scan drafts are coalesced before persistence, and a resolved mismatch reopens the same identity. Severity is `INFO`, `WARN` or `CRITICAL`.

Critical canonical contradictions create one block for the exact affected `SKU` or `ORDER`. A shared P guard gates affected stock reservation/receipt, shipping/Geliver progression, physical handoff, return receipt and refund progression without blocking unrelated scopes. Blocks clear only on a later clean complete scan or explicit admin verification of the exact finding with a mandatory reason. Reconciliation, approved repair and verification remain usable while blocked.

## Repair model

`products.central_stock` is the only V2-15 auto-repair registry entry. It is a disposable projection rebuilt from authoritative inventory lot totals. All other discrepancies are detection-only and, when critical, require a bounded proposal and admin approval. Approval records the authoritative command type/payload; reconciliation itself does not patch canonical facts. The initial explicit canonical repair registry supports only `inventory.release-reservation.v1`, executed through `InventoryService` in the same transaction that records immutable `APPLIED` before/after evidence. Unsupported approved commands remain `APPROVED`, execute no mutation and fail closed with `REPAIR_COMMAND_UNSUPPORTED`.

Run, finding, block, proposal and history changes carry operation identity and actor. Manual mutations use P's command foundation and outbox. History and evidence rows cannot be deleted; repair never removes evidence.

## Checks

- inventory lot, ledger, active location/package, reservation and `central_stock` totals, including V2-11 profile cut deliverable-versus-consumed kerf evidence;
- sale snapshot/line gross, discount, VAT, net and commission consistency, COGS finalization totals and known-expense FX conversion;
- sold published-kit frozen version/content hash;
- returned/refunded quantity and money bounds;
- accepted channel order canonical sale/reservation links plus latest stock, price and tracking payload/hash consistency, using V83 Geliver offer/booking/tracking authority with V82 fallback only when no V83 booking exists;
- dispatched shipment handoff, inventory dispatch and COGS chain;
- print template-version, payload, printable/artifact hash, event state and reprint linkage.

## Migration and rollback impact

P migration v87 is forward-only and creates control-plane tables, indexes and append-only guards. It performs no business-data scan or repair. Code rollback leaves v87 tables intact and unused. Data repair has its own proposal/approval/command/evidence lifecycle and is never coupled to migration, startup or deployment.

## Limitations

- V2-15 executes only explicitly registered canonical repair commands; all other approved command types remain fail-closed and unexecuted.
- Only `central_stock` is registered for automatic rebuild.
- Channel settlement/bank reconciliation remains blocked by the existing owner decision.
- No runtime, production data, deployment or V2-16 recovery claim is made.
