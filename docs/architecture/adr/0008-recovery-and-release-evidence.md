# ADR-0008 — Recovery point and release are verified sets

Status: Accepted

Date: 2026-09-20

## Context

The system spans multiple state stores and images. A Panel DB copy alone cannot restore the full service, and a Git HEAD cannot prove the running code. PR01 already enforces service-specific container/image/OCI provenance and redacted config evidence.

## Decision

Define a recovery point as checksummed, compatible snapshots of core DB, K DB/uploads, L templates, Panel/Hub attachments, schema versions, redacted configuration fingerprints and service-specific immutable runtime provenance. Accept it only after isolated restore and invariant/smoke verification on the exact release set.

Schema migration, historical repair, release deploy and restore are separate approved operations.

## Consequences

- Missing or contradictory runtime evidence remains `NOT VERIFIED`.
- Backup presence is not recoverability proof.
- RPO/RTO, retention, provider, encryption/key-recovery and ownership are `DECISION REQUIRED`.
- PR01 is preserved and extended compatibly; its validation cannot be weakened.
