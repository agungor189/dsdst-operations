# ADR-0007 — L owns templates; core owns print jobs

Status: Accepted

Date: 2026-09-20

## Context

L edits and renders templates while P also has template-related storage and owns print jobs. L JSON state can lose concurrent writes. A successful renderer/CUPS call does not prove physical output.

## Decision

L is the sole editable template source with immutable versions/content hashes and CAS-safe writes. P owns print intent, payload/template snapshot, attempts and business state. The renderer is deterministic and read-only. The local worker records separate rendered, submitted, acknowledged, confirmed, failed and delivery-unknown states.

## Consequences

- P's competing editable template authority is retired after migration.
- A queued job is stable despite later template edits.
- Uncertain final attempts require operator resolution and are not blindly retried.
- L product imports remain editor aids, not catalog facts.
