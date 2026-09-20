# ADR-0002 — One transactional authority independent of deployment venue

Status: Accepted

Date: 2026-09-20

## Context

Current Compose source is local-host oriented. Warehouse/printing have local physical concerns, but no production runtime or owner decision proves whether the authoritative application should run locally or in cloud infrastructure.

## Decision

Use the P core database as the single operational transaction authority `NOW`, independent of venue. Do not create local/cloud bidirectional write replication or a second business database. Use authenticated TLS/private ingress and encrypted off-site backup. Printing remains a scoped local agent/device boundary.

SQLite is retained until concurrency, availability, data size or recovery measurements fail accepted targets. Its use requires one writer architecture, WAL/busy handling, transactional migrations, consistent online backup and isolated restore tests.

The actual local-versus-cloud production venue is `DECISION REQUIRED`. Selection must compare power/UPS/restart/LAN/Internet behavior, printer connectivity, secure ingress, provider outage, data location, cost, RPO/RTO and operator responsibility.

## Consequences

- Both deployment options obey the same domain and recovery contracts.
- Local selection requires power/host controls; cloud selection requires office-outage and local-print-agent controls.
- A venue change or database replacement is evidence-driven and requires a new ADR.
- Production topology is `NOT VERIFIED` until PR01 runtime evidence passes.
