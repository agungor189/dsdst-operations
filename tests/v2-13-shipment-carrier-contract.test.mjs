import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const warehouseRoot = path.resolve(process.env.WAREHOUSE_CONTEXT || path.join(root, "..", "Dsdst-Warehouse"));
const readPanel = (...segments) => fs.readFileSync(path.join(panelRoot, ...segments), "utf8");
const readWarehouse = (...segments) => fs.readFileSync(path.join(warehouseRoot, ...segments), "utf8");

test("Panel v83-v84 adds forward-only Geliver evidence and shipment outbound execution without rewriting accepted V82 history", () => {
  const migration = readPanel("server", "migrations", "runner.ts");
  const schema = readPanel("server", "db", "shipmentCarrierSchema.ts");
  const remediation = readPanel("server", "db", "geliverRemediationSchema.ts");
  const outbound = readPanel("server", "db", "channelShipmentOutboundSchema.ts");
  assert.match(migration, /version:\s*82[\s\S]*add_shipment_carrier_gateway/);
  assert.match(migration, /version:\s*83[\s\S]*geliver_verified_flow_remediation/);
  assert.match(migration, /version:\s*84[\s\S]*wire_shipment_channel_outbound_execution/);
  assert.match(migration, /CURRENT_SCHEMA_VERSION = 86/);
  for (const table of [
    "shipment_preparations", "shipment_packages", "shipment_carrier_selections", "shipment_booking_jobs",
    "shipment_booking_attempts", "shipment_provider_bookings", "shipment_labels", "shipment_state_events",
    "shipment_cancellations", "shipment_actual_charge_facts", "channel_shipment_outbound_jobs",
    "shipment_notification_policies",
  ]) assert.match(schema, new RegExp(`CREATE TABLE ${table}`));
  for (const state of ["PREPARING", "CARRIER_SELECTED", "BOOKED", "LABEL_READY", "HANDED_OFF", "DISPATCHED", "CANCELLED", "EXCEPTION"])
    assert.match(schema, new RegExp(`'${state}'`));
  assert.match(schema, /shipment history cannot be erased/);
  assert.match(schema, /invalid shipment state transition/);
  assert.match(schema, /shipment provider booking is immutable/);
  assert.match(schema, /shipment label provenance is immutable/);
  assert.match(schema, /shipment actual charge provenance is immutable/);
  for (const table of ["shipment_recipient_snapshots", "geliver_create_jobs", "geliver_create_attempts",
    "geliver_provider_shipments", "geliver_offer_observations", "geliver_offer_selections", "geliver_accept_jobs",
    "geliver_accept_attempts", "geliver_booking_facts", "geliver_label_observations", "geliver_tracking_observations",
    "geliver_cancellation_facts"]) assert.match(remediation, new RegExp(`CREATE TABLE ${table}`));
  assert.match(remediation, /RECONCILE_REQUIRED/);
  assert.match(remediation, /tracking_number\s+TEXT,/);
  assert.doesNotMatch(remediation, /width_mm|height_mm|dpi|printer_compatibility/);
  assert.match(outbound, /CREATE TABLE channel_shipment_outbound_attempts/);
  assert.match(outbound, /attempt_count/);
  assert.match(outbound, /lease_token/);
  assert.match(outbound, /channel shipment outbound attempt is immutable/);
});

test("PACKED creates one preparation while only confirmed physical handoff can dispatch inventory and FIFO COGS", () => {
  const service = readPanel("server", "modules", "shipping", "shipmentService.ts");
  const inventoryRoutes = readPanel("server", "routes", "inventoryV1Routes.ts");
  const warehouseRoutes = readPanel("server", "routes", "warehouseRoutes.ts");
  assert.match(service, /packAndPrepare[\s\S]*shipment_preparations WHERE reservation_id=/);
  assert.match(service, /this\.inventory\.markPacked/);
  assert.doesNotMatch(service.slice(service.indexOf("packAndPrepare"), service.indexOf("definePackages")), /dispatchReservation|finalizeDispatch/);
  assert.match(service, /confirmHandoff[\s\S]*state !== "LABEL_READY"/);
  assert.match(service, /HANDOFF_EVIDENCE_REQUIRED/);
  assert.match(service, /state='HANDED_OFF'[\s\S]*this\.inventory\.dispatchReservation[\s\S]*this\.finance\.finalizeDispatch[\s\S]*state='DISPATCHED'/);
  assert.match(inventoryRoutes, /PHYSICAL_HANDOFF_REQUIRED/);
  assert.match(warehouseRoutes, /PHYSICAL_HANDOFF_REQUIRED/);
  assert.doesNotMatch(inventoryRoutes, /dispatchReservation/);
  assert.doesNotMatch(warehouseRoutes, /dispatchReservation/);
});

test("operator choice, N packages and measurement precedence fail closed without COD or guessed data", () => {
  const service = readPanel("server", "modules", "shipping", "shipmentService.ts");
  assert.match(service, /CARRIER_SELECTION_REQUIRED/);
  assert.match(service, /explicitOperatorChoice:\s*true/);
  assert.match(service, /automaticCheapestSelection:\s*false/);
  assert.match(service, /COD_FORBIDDEN/);
  assert.match(service, /cashOnDelivery:\s*false/);
  assert.match(service, /measurementSource/);
  assert.match(service, /source:\s*"MEASURED"/);
  assert.match(service, /source:\s*"RECIPE_ESTIMATE"/);
  assert.match(service, /PACKAGE_MEASUREMENTS_REQUIRED/);
  assert.match(service, /Package contents must exactly conserve the reservation snapshot/);
  assert.match(service, /package numbers must be unique and consecutive/i);
});

test("verified official SDK flow disables side-effect retries and reconciles uncertain create/accept outcomes", () => {
  const service = readPanel("server", "modules", "shipping", "geliverFlowService.ts");
  const packageJson = JSON.parse(readPanel("package.json"));
  assert.equal(packageJson.dependencies["@geliver/sdk"], "1.3.0");
  assert.match(service, /officialDocumentation:\s*"https:\/\/docs\.geliver\.io"/);
  assert.match(service, /officialSdk:\s*"https:\/\/github\.com\/GeliverApp\/geliver-js"/);
  assert.match(service, /new GeliverClient\([\s\S]*maxRetries:\s*0/);
  assert.match(service, /shipments\.create/);
  assert.match(service, /shipments\.list\(\{ orderNumber/);
  assert.match(service, /shipments\.get/);
  assert.match(service, /transactions\.acceptOffer/);
  assert.match(service, /shipments\.cancel/);
  assert.match(service, /GELIVER_CREATE_RECONCILIATION_PENDING/);
  assert.match(service, /GELIVER_ACCEPT_RECONCILIATION_PENDING/);
  assert.match(service, /create will not be retried automatically/);
  assert.match(service, /acceptOffer will not be retried automatically/);
  assert.match(service, /productPaymentOnDelivery:\s*false/);
});

test("tracking is nullable and refreshable while provider-native labels carry no invented print-media metadata", () => {
  const service = readPanel("server", "modules", "shipping", "geliverFlowService.ts");
  const schema = readPanel("server", "db", "geliverRemediationSchema.ts");
  assert.match(service, /trackingMayArriveLater:\s*true/);
  assert.match(service, /trackingNumber/);
  assert.match(service, /trackingUrl/);
  assert.match(service, /labelURL/);
  assert.match(service, /responsiveLabelURL/);
  assert.match(service, /labelFileType/);
  assert.match(schema, /artifact_sha256/);
  assert.doesNotMatch(schema, /width_mm|height_mm|dpi|printer_compatibility|print_state|printed_at|print_job/);
});

test("handoff routes marketplace tracking through V2-12, records V2-09 actual charge and emits shipped notification once", () => {
  const service = readPanel("server", "modules", "shipping", "shipmentService.ts");
  assert.match(service, /enqueueV212Tracking/);
  assert.match(service, /channel_shipment_outbound_jobs/);
  assert.match(service, /channels\.shipment\.tracking-status\.requested\.v1/);
  assert.match(service, /customer\.order\.shipped\.v1/);
  for (const field of ["order_no", "carrier", "tracking", "package_count"]) assert.match(service, new RegExp(`${field}:`));
  assert.match(service, /setNotificationPolicy/);
  assert.match(service, /recordExpenseFact\(\{ saleId: shipment\.orderId, category: "shipping", state: "KNOWN"/);
  assert.match(service, /quote_amount_minor/);
  assert.doesNotMatch(service.slice(service.indexOf("selectCarrier"), service.indexOf("requestBooking")), /recordExpenseFact|finalizeDispatch/);
  assert.match(service, /RETURN_FLOW_REQUIRED/);
});

test("V2-12 durably claims and processes shipment tracking/status only through verified Trendyol transport", () => {
  const service = readPanel("server", "modules", "shipping", "shipmentService.ts");
  const gateway = readPanel("server", "modules", "channels", "channelGateway.ts");
  const transport = readPanel("server", "modules", "channels", "trendyolGatewayTransport.ts");
  const server = readPanel("server.ts");
  assert.match(service, /sourceVersion = `shipment:v3:\$\{payloadHash\}`/);
  assert.match(gateway, /channel_shipment_outbound_jobs/);
  assert.match(gateway, /outboundType:\s*"SHIPMENT"/);
  assert.match(gateway, /processClaimedShipmentOutboundJob/);
  assert.match(gateway, /channel_shipment_outbound_attempts/);
  assert.match(gateway, /CHANNEL_TRACKING_PENDING/);
  assert.match(gateway, /CHANNEL_SHIPMENT_MAPPING_UNVERIFIED/);
  assert.match(gateway, /providerMutationId = `trendyol:alternative-delivery:/);
  assert.match(gateway, /HEPSIBURADA:[\s\S]*enabledTransport: false/);
  assert.match(gateway, /N11:[\s\S]*enabledTransport: false/);
  assert.match(gateway, /SHOPIFY:[\s\S]*enabledTransport: false/);
  assert.match(transport, /TRACKING_STATUS/);
  assert.match(transport, /alternative-delivery/);
  assert.match(transport, /isPhoneNumber:\s*false/);
  assert.match(server, /channel_shipment_outbound_jobs/);
  assert.match(server, /transport\.publish/);
});

test("Warehouse is a whitelisted live-offer operator client with structured packages, refresh, cancel and handoff", () => {
  const bff = readWarehouse("server", "app.ts");
  const client = readWarehouse("src", "lib", "api.ts");
  const page = readWarehouse("src", "pages", "ShipmentPage.tsx");
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/packages/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/geliver\/offers/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/geliver\/refresh/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/geliver\/offers\/:offerId\/accept/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/cancel/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/handoff/);
  assert.match(bff, /PHYSICAL_HANDOFF_REQUIRED/);
  assert.match(bff, /COD_FORBIDDEN/);
  assert.doesNotMatch(bff, /central_stock:\s*req\.body|role:\s*req\.body/);
  assert.match(client, /export const shipmentApi/);
  assert.match(client, /loadGeliverOffers/);
  assert.match(client, /acceptGeliverOffer/);
  assert.match(page, /Canlı Geliver teklifleri/);
  assert.match(page, /En ucuz teklif otomatik seçilmez/);
  assert.match(page, /İptal et/);
  assert.match(page, /Fiziksel teslimi doğrula/);
  assert.doesNotMatch(page, /packagesJson|carrierCode|serviceCode|quoteId|providerShipmentId/);
});
