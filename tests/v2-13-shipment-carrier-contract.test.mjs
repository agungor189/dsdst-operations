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

test("Panel v82 owns forward-only canonical shipment, package, provider, label, state, charge and channel evidence", () => {
  const migration = readPanel("server", "migrations", "runner.ts");
  const schema = readPanel("server", "db", "shipmentCarrierSchema.ts");
  assert.match(migration, /version:\s*82[\s\S]*add_shipment_carrier_gateway/);
  assert.match(migration, /CURRENT_SCHEMA_VERSION = 82/);
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

test("Geliver adapter contract is verified only to official capability level and live transport remains fail-closed", () => {
  const service = readPanel("server", "modules", "shipping", "shipmentService.ts");
  assert.match(service, /officialDocumentation:\s*"https:\/\/docs\.geliver\.io"/);
  assert.match(service, /officialSdk:\s*"https:\/\/github\.com\/GeliverApp\/geliver-js"/);
  assert.match(service, /enabled:\s*false/);
  assert.match(service, /provider-side idempotency/);
  assert.match(service, /serverIdempotencyVerified/);
  assert.match(service, /GELIVER_TRANSPORT_DISABLED/);
  assert.match(service, /requestIdentity = `dsdst:\$\{shipmentId\}:package:\$\{pack\.packageNumber\}`/);
  assert.match(service, /BLOCKED_UNCERTAIN/);
  assert.match(service, /provider_shipment_id/);
});

test("provider tracking and immutable 100x150 XP-470B label evidence never become generic print state", () => {
  const service = readPanel("server", "modules", "shipping", "shipmentService.ts");
  const schema = readPanel("server", "db", "shipmentCarrierSchema.ts");
  assert.match(service, /trackingNumber/);
  assert.match(service, /trackingUrl/);
  assert.match(service, /widthMm !== 100/);
  assert.match(service, /heightMm !== 150/);
  assert.match(service, /dpi !== 203/);
  assert.match(schema, /printer_compatibility[\s\S]*XPRINTER_XP_470B_203DPI/);
  assert.doesNotMatch(schema, /print_state|printed_at|print_job/);
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

test("Warehouse remains a whitelisted operator client with explicit package, carrier, booking, cancel and handoff commands", () => {
  const bff = readWarehouse("server", "app.ts");
  const client = readWarehouse("src", "lib", "api.ts");
  const page = readWarehouse("src", "pages", "ShipmentPage.tsx");
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/packages/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/carrier-selection/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/booking/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/cancel/);
  assert.match(bff, /\/api\/shipping\/v1\/shipments\/:id\/handoff/);
  assert.match(bff, /PHYSICAL_HANDOFF_REQUIRED/);
  assert.match(bff, /COD_FORBIDDEN/);
  assert.doesNotMatch(bff, /central_stock:\s*req\.body|role:\s*req\.body/);
  assert.match(client, /export const shipmentApi/);
  assert.match(client, /cashOnDelivery:\s*false/);
  assert.match(page, /En ucuz otomatik seçilmez/);
  assert.match(page, /Fiziksel teslimi doğrula/);
});
