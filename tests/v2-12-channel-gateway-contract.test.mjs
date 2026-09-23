import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const read = (...segments) => fs.readFileSync(path.join(panelRoot, ...segments), "utf8");

test("Panel v79-v80 owns the generic channel inbox, mapping, policy, cursor, outbox and exception contracts", () => {
  const migration = read("server", "migrations", "runner.ts");
  const schema = read("server", "db", "channelGatewaySchema.ts");
  const remediation = read("server", "db", "channelGatewayRemediationSchema.ts");
  assert.match(migration, /version:\s*79[\s\S]*add_channel_gateway/);
  assert.match(migration, /version:\s*80[\s\S]*remediate_channel_gateway_execution/);
  assert.match(migration, /CURRENT_SCHEMA_VERSION = 80/);
  for (const table of [
    "channel_accounts", "channel_product_mappings", "channel_commission_terms", "channel_stock_buffers",
    "channel_inbound_events", "channel_orders", "channel_order_lines", "channel_price_variances",
    "channel_poll_cursors", "channel_outbound_jobs", "channel_outbound_attempts", "channel_exceptions",
  ]) assert.match(schema, new RegExp(`CREATE TABLE ${table}`));
  assert.match(schema, /UNIQUE\(account_id,external_event_id,external_event_version\)/);
  assert.match(schema, /UNIQUE\(account_id,external_order_id\)/);
  assert.match(schema, /channel inbound raw event is immutable/);
  assert.match(schema, /channel order line is immutable/);
  assert.match(schema, /channel commission terms are immutable/);
  assert.match(remediation, /lease_token/);
  assert.match(remediation, /idx_channel_jobs_claim_ready/);
});

test("gateway accepts marketplace orders only through canonical sales, inventory, finance and returns services", () => {
  const gateway = read("server", "modules", "channels", "channelGateway.ts");
  const sales = read("server", "modules", "sales", "marketplaceSaleAcceptanceService.ts");
  assert.match(gateway, /CommandExecutor/);
  assert.match(gateway, /MarketplaceSaleAcceptanceService/);
  assert.match(gateway, /CHANNEL_MAPPING_EXCEPTION/);
  assert.match(gateway, /STOCK_EXCEPTION/);
  assert.match(gateway, /COMMISSION_EXCEPTION/);
  assert.match(gateway, /PRICE_VARIANCE/);
  assert.match(gateway, /calculateInverseCommissionPrice/);
  assert.match(gateway, /BigInt\(target\) \* BigInt\(denominator\)/);
  assert.match(gateway, /Math\.max\(0, availability\.availableBaseInt - buffer\)/);
  assert.match(gateway, /redactProviderPayload/);
  assert.match(gateway, /PLAINTEXT_SECRET_FORBIDDEN/);
  assert.match(sales, /SalesFinancialService/);
  assert.match(sales, /InventoryService/);
  assert.match(sales, /ReturnsService/);
  assert.match(sales, /sale_kit_version_snapshots/);
  assert.match(sales, /MARKETPLACE_SETTLEMENT_PENDING/);
  assert.doesNotMatch(gateway, /UPDATE products SET|UPDATE inventory_lots SET|INSERT INTO sales|INSERT INTO sale_items/);
});

test("Trendyol, Hepsiburada, N11 and Shopify expose explicit fail-closed adapter contracts", () => {
  const gateway = read("server", "modules", "channels", "channelGateway.ts");
  for (const channel of ["TRENDYOL", "HEPSIBURADA", "N11", "SHOPIFY"]) assert.match(gateway, new RegExp(`${channel}: \\{ contract:`));
  assert.match(gateway, /TRENDYOL:[\s\S]*enabledTransport: true/);
  assert.match(gateway, /HEPSIBURADA:[\s\S]*enabledTransport: false/);
  assert.match(gateway, /N11:[\s\S]*enabledTransport: false/);
  assert.match(gateway, /SHOPIFY:[\s\S]*enabledTransport: false/);
  assert.match(gateway, /mayMutateCanonicalAuthority: false/g);
  assert.match(gateway, /supportsPollingReconciliation: true/g);
});

test("Panel exposes authenticated channel APIs and a practical operator dashboard", () => {
  const server = read("server.ts");
  const ui = read("src", "components", "integrations", "ChannelsIntegration.tsx");
  const keys = read("src", "components", "integrations", "PanelApiKeys.tsx");
  assert.match(server, /\/api\/channels\/v1\/events/);
  assert.match(server, /publicApiAuth\("channels:ingest"\)/);
  assert.match(server, /publicApiAuth\("channels:poll"\)/);
  assert.match(server, /publicApiAuth\("channels:publish"\)/);
  assert.match(server, /\/api\/channels\/v1\/outbound-jobs\/claim/);
  assert.match(server, /\/api\/channels\/v1\/outbound-jobs\/:id\/process/);
  assert.match(server, /\/api\/integrations\/channels\/orders\/:id\/resolve-reprocess/);
  assert.match(server, /\/api\/integrations\/channels\/dashboard/);
  for (const phrase of ["Kanal Geçidi", "Açık istisnalar", "Senkron işleri", "Yayınlanabilir"]) assert.match(ui, new RegExp(phrase));
  for (const scope of ["channels:ingest", "channels:poll", "channels:publish"]) assert.match(keys, new RegExp(scope));
});

test("verified Trendyol polling and stock-price publication run through the gateway without legacy order authority", () => {
  const transport = read("server", "modules", "channels", "trendyolGatewayTransport.ts");
  const server = read("server.ts");
  assert.match(transport, /\/orders\/stream/);
  assert.match(transport, /gateway\.ingest/);
  assert.match(transport, /gateway\.updatePollingCursor/);
  assert.match(transport, /\/products\/price-and-inventory/);
  assert.match(transport, /quantityBaseInt/);
  assert.match(transport, /channelPriceMinor/);
  assert.doesNotMatch(transport, /marketplace_orders|marketplace_order_lines/);
  assert.match(server, /new TrendyolGatewayTransport\(channelGateway, trendyolFetchJson\)/);
  assert.match(server, /transport\.poll/);
  assert.match(server, /transport\.publish/);
});

test("canonical projections enqueue durable jobs and exception reprocessing preserves one sale", () => {
  const gateway = read("server", "modules", "channels", "channelGateway.ts");
  const projection = read("server", "modules", "channels", "channelOutboundProjection.ts");
  const inventory = read("server", "modules", "inventory", "inventoryService.ts");
  assert.match(projection, /INSERT INTO channel_outbound_jobs/);
  assert.match(projection, /ON CONFLICT\(account_id,product_id,job_kind,source_version\) DO NOTHING/);
  assert.match(inventory, /enqueueCanonicalChannelChanges/);
  assert.match(gateway, /claimReadyOutboundJobs/);
  assert.match(gateway, /processClaimedOutboundJob/);
  assert.match(gateway, /ADAPTER_TRANSPORT_DISABLED/);
  assert.match(gateway, /resolveAndReprocessOrder/);
  assert.match(gateway, /channels\.exception\.resolve-reprocess\.v1/);
  assert.match(gateway, /state='RESOLVED',resolved_at=/);
  assert.match(gateway, /WHERE id=\? AND sale_id IS NULL/);
});
