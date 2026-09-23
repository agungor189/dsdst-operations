# V2-14 — Label / Print State Implementation Evidence

Status: implementation complete on feature branches; not merged or deployed.

This closure implements ADR-0007 without superseding it. L remains the sole editable template/version/content-hash authority. P owns print intent, immutable selected-template and payload snapshots, attempts, reprints, audit events and canonical business state. W is the operator UI. The renderer is deterministic and cannot mutate canonical print state.

## Locked contracts

- `GOODS_RECEIPT_PACKAGE`: 100×150 mm, exactly one Code128 barcode containing `SKU`, using the existing package-label fields.
- `LOCATION`: 100×50 mm, exactly one Code128 barcode containing the canonical location code.
- `SHIPPING`: the original Geliver provider artifact, reference and SHA-256 are persisted and submitted unchanged. L does not redesign it.
- There is no `KIT` or separate product-package print purpose.
- Canonical printer target metadata is Xprinter XP-470B at 203 dpi.

The canonical lifecycle is `QUEUED → RENDERED → SUBMITTED → ACKNOWLEDGED → DELIVERY_UNKNOWN`, with explicit operator resolution to `PRINTED_CONFIRMED`; `FAILED` and `CANCELLED` are terminal alternatives. Renderer success and spool acceptance never imply physical confirmation.

## Forward-only migration

P migration v85 creates `printing_jobs`, `printing_attempts`, `printing_reprints` and `printing_events`, immutable-history triggers and the worker indexes. It does not rewrite accepted historical migration files or repair historical business data.

The migration fails closed while either legacy print queue contains an active job. Before applying v85, operations must drain or explicitly cancel those jobs through the accepted pre-v85 application. Failed, printed or cancelled legacy history remains untouched for audit. No automatic conversion or deletion is performed.

L upgrades its local template-state envelope to v3 on the next authorized CAS write. Existing supported v1/v2 state is read and normalized; each changed template receives a new immutable version/content hash, and prior entries remain in `templateVersions`. A stale writer receives an exact revision conflict.

Rollback is application rollback before migration. After v85 is applied, database rollback is restore-from-approved-backup only; there is no down migration. This task does not authorize a restore, migration run, deploy or production data operation.

## Request path and operator boundary

For package and location labels, W first reads P-owned preview payload data, asks L to render previews, and on explicit `Yazdır` fetches L's current exact template snapshot before submitting the V2-04 idempotent command to P. P's worker asks L to render that immutable version/hash. Shipping print commands download and hash-check the previously observed provider-native Geliver artifact and never send it to L.

Reprints require `warehouse:print_labels` and one of `DAMAGED_OUTPUT`, `LOST`, `PRINTER_ERROR` or `OTHER`; `OTHER` requires an explanation. A reprint creates a new job linked to the original and an immutable reason record. W exposes preview, explicit print, canonical status/history, physical confirmation and reasoned reprint without a JSON editor.

## Runtime and release status

No runtime claim is made. Deployment, physical-printer verification, migration execution and release provenance remain `NOT VERIFIED` until the PR01 evidence contract is performed on an explicitly approved release. V2-15 is outside this change.

