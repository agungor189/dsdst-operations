# ADR-0004 — Currency-safe money and immutable economic snapshots

Status: Accepted structure; business policy decisions pending

Date: 2026-09-20

## Context

Current code mixes native currency, TRY projections, live FX fallbacks, product current cost and different tax/fee scopes. Historical results can change when current master inputs change.

## Decision

Represent money in integer minor units with currency. Store complete FX provenance for every conversion. Approve landed acquisition cost per lot and snapshot all economic inputs on sales and published kits. Historical snapshots are immutable; corrections reverse or supersede.

The owner must decide accounting currency, FX sources/fallback/staleness, acquisition allocation, inventory cost flow, VAT inclusion/rounding, discounts, commissions/fees, shipping and profit scope. Existing defaults do not decide policy.

## Consequences

- Missing required inputs block authority rather than become zero/rate 1.
- Reports group native currency or use the transaction's historical conversion.
- Current-cost simulations remain separate from accepted historical results.
- No historical backfill occurs without reconciliation and repair approval.
