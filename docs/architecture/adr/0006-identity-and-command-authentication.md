# ADR-0006 — Human identity, service principals and idempotent commands

Status: Accepted

Date: 2026-09-20

## Context

P authenticates humans; W/K/L proxy sessions and use service keys. Some current read paths can rely on service identity where a human actor is required, and JWT logout/password changes do not by themselves guarantee revocation.

## Decision

P is the human identity authority. Protected actions validate live account state, session epoch and backend capability. Service principals are scoped, rotated and distinct. A user-initiated cross-service command carries both identities. Every mutation uses a canonical payload hash and idempotency key with an immutable result.

## Consequences

- Logout, password change, disablement and material role change revoke prior sessions.
- A service key cannot grant missing human permission.
- Retries and webhooks cannot duplicate effects.
- Capability mapping and audit-retention policy require owner decisions before rollout.
