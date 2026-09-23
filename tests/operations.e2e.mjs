import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const panelUrl = process.env.PANEL_URL || "http://dsdst-panel:3000";
const warehouseUrl = process.env.WAREHOUSE_URL || "http://dsdst-warehouse:3006";
const labelPrinterUrl = process.env.LABEL_PRINTER_URL || "http://label-printer:3000";
const kitStudioUrl = process.env.KIT_STUDIO_URL || "http://dsdst-kit-studio:3012";
const customerHubUrl = process.env.CUSTOMER_HUB_URL || "http://dsdst-customer-hub:3100";
const warehouseServiceKey = process.env.WAREHOUSE_SERVICE_KEY || "";
const includeCustomerHub = process.env.E2E_SKIP_AUXILIARY_HUB !== "1";

const request = async (base, path, { method = "GET", body, token, cookie, apiKey, headers = {}, expect = 200 } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Accept: "application/json, application/pdf",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(!["GET", "HEAD"].includes(method) ? { Origin: base } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, expect, `${method} ${path} -> ${response.status}: ${Buffer.isBuffer(payload) ? payload.toString("utf8", 0, 300) : JSON.stringify(payload)}`);
  return { response, payload };
};

const sessionCookie = (response) => {
  const raw = response.headers.get("set-cookie") || "";
  assert.ok(raw, "login response must set an HttpOnly session cookie");
  const cookie = raw.split(";", 1)[0];
  assert.ok(/HttpOnly/i.test(raw), "session cookie must be HttpOnly");
  return cookie;
};

const waitFor = async (description, fn, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.fail(`${description} timed out; last value: ${JSON.stringify(last)}`);
};

const template = (id, marker) => ({
  id,
  name: `Operations ${marker}`,
  purpose: "goods_receipt",
  isDefault: true,
  width: 100,
  height: 150,
  elements: [
    { id: "marker", type: "text", x: 4, y: 4, width: 92, height: 8, value: `${marker} {SKU}`, fontSize: 4, fontWeight: "bold" },
    { id: "barcode", type: "barcode", x: 4, y: 18, width: 65, height: 26, value: "{SKU}", showBarcodeText: true },
    { id: "qr", type: "qr", x: 73, y: 18, width: 23, height: 23, value: "{Package_code}" },
  ],
});

test("DSDST Operations receiving, live template and picking workflow", async () => {
  await request(panelUrl, "/api/public/health");
  await request(warehouseUrl, "/health");
  await request(labelPrinterUrl, "/api/health");
  await request(kitStudioUrl, "/api/health");
  if (includeCustomerHub) {
    const customerHubHealth = await request(customerHubUrl, "/api/health");
    assert.equal(customerHubHealth.payload.database, "ok");
    assert.equal(customerHubHealth.payload.worker, "ok");
  }

  const initialLogin = await request(panelUrl, "/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: "admin" },
  });
  const initialPanelCookie = sessionCookie(initialLogin.response);
  assert.equal(initialLogin.payload.token, undefined, "Panel login must not expose a browser-readable token");
  if (initialLogin.payload.user.must_change_password) {
    await request(panelUrl, "/api/auth/change-password", {
      method: "POST",
      cookie: initialPanelCookie,
      body: { current_password: "admin", new_password: "Operations-E2E-2026!" },
    });
    await request(panelUrl, "/api/auth/me", { cookie: initialPanelCookie, expect: 401 });
  }
  const panelLogin = await request(panelUrl, "/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: "Operations-E2E-2026!" },
  });
  const panelCookie = sessionCookie(panelLogin.response);
  assert.equal(panelLogin.payload.token, undefined);

  if (includeCustomerHub) {
    const customerHubLogin = await request(customerHubUrl, "/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: "Operations-E2E-2026!" },
  });
  const customerHubCookie = sessionCookie(customerHubLogin.response);
  assert.equal(customerHubLogin.payload.user.id, panelLogin.payload.user.id, "Customer Hub session must use the Panel user");

  const hubMarker = `hub-${Date.now()}`;
  const inbound = {
    event_id: `${hubMarker}-event`,
    external_account_id: "website",
    external_conversation_id: `${hubMarker}-conversation`,
    external_message_id: `${hubMarker}-message`,
    external_user_id: `${hubMarker}-visitor`,
    display_name: "Operations Hub Customer",
    body: `Operations inbound ${hubMarker}`,
    message_type: "TEXT",
    metadata: { source: "operations-e2e" },
  };
  const acceptedInbound = await request(customerHubUrl, "/api/dev/mock/inbound", {
    method: "POST",
    cookie: customerHubCookie,
    body: inbound,
    expect: 202,
  });
  assert.equal(acceptedInbound.payload.duplicate, false);
  const duplicateInbound = await request(customerHubUrl, "/api/dev/mock/inbound", {
    method: "POST",
    cookie: customerHubCookie,
    body: inbound,
    expect: 202,
  });
  assert.equal(duplicateInbound.payload.duplicate, true, "duplicate webhook event must be idempotent");

  const hubInbox = await request(customerHubUrl, `/api/conversations?q=${encodeURIComponent(hubMarker)}`, { cookie: customerHubCookie });
  assert.equal(hubInbox.payload.items.length, 1);
  const hubConversation = hubInbox.payload.items[0];
  assert.equal(hubConversation.last_message, inbound.body);

  await request(customerHubUrl, `/api/conversations/${hubConversation.id}/assignment`, {
    method: "PUT",
    cookie: customerHubCookie,
    body: { assigned_user_id: customerHubLogin.payload.user.id },
  });
  const hubTags = await request(customerHubUrl, "/api/tags", { cookie: customerHubCookie });
  assert.ok(hubTags.payload.items.length > 0);
  await request(customerHubUrl, `/api/conversations/${hubConversation.id}/tags/${hubTags.payload.items[0].id}`, {
    method: "PUT",
    cookie: customerHubCookie,
  });
  await request(customerHubUrl, `/api/conversations/${hubConversation.id}/notes`, {
    method: "POST",
    cookie: customerHubCookie,
    body: { text: `Internal note ${hubMarker}` },
    expect: 201,
  });
  const queuedReply = await request(customerHubUrl, `/api/conversations/${hubConversation.id}/replies`, {
    method: "POST",
    cookie: customerHubCookie,
    body: { body: `Outbound reply ${hubMarker}`, client_message_id: randomUUID() },
    expect: 202,
  });
  assert.equal(queuedReply.payload.status, "QUEUED");
  const sentReply = await waitFor("Customer Hub outbound outbox", async () => {
    const detail = await request(customerHubUrl, `/api/conversations/${hubConversation.id}`, { cookie: customerHubCookie });
    return detail.payload.messages.find((message) => message.id === queuedReply.payload.id && message.status === "SENT") ? detail.payload : null;
  });
  assert.equal(sentReply.assigned_user_id, customerHubLogin.payload.user.id);
  assert.ok(sentReply.tags.some((tag) => tag.id === hubTags.payload.items[0].id));
  assert.ok(sentReply.notes.some((note) => note.text === `Internal note ${hubMarker}`));
  await request(customerHubUrl, "/api/auth/logout", { method: "POST", cookie: customerHubCookie, expect: 204 });
  await request(customerHubUrl, "/api/auth/me", { cookie: customerHubCookie, expect: 401 });
  }

  const labelLogin = await request(labelPrinterUrl, "/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: "Operations-E2E-2026!" },
  });
  const labelCookie = sessionCookie(labelLogin.response);
  const warehouseLogin = await request(warehouseUrl, "/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: "Operations-E2E-2026!" },
  });
  const warehouseCookie = sessionCookie(warehouseLogin.response);
  assert.ok(warehouseServiceKey, "Warehouse service key must be available only to the E2E runner");
  await request(panelUrl, "/api/warehouse/v1/orders", { apiKey: warehouseServiceKey, expect: 401 });
  const revokedWarehouseLogin = await request(warehouseUrl, "/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: "Operations-E2E-2026!" },
  });
  const revokedWarehouseCookie = sessionCookie(revokedWarehouseLogin.response);
  await request(warehouseUrl, "/api/auth/logout", { method: "POST", cookie: revokedWarehouseCookie });
  await request(warehouseUrl, "/api/orders", { cookie: revokedWarehouseCookie, expect: 401 });

  const sku = `OPS-${Date.now()}`;
  const lot = `LOT-${Date.now()}`;
  const productId = `product-${Date.now()}`;
  const createdProduct = await request(panelUrl, "/api/catalog-admin/v1/products", {
    method: "POST",
    cookie: panelCookie,
    headers: { "x-operation-id": `catalog-create-${productId}` },
    body: { id: productId, sku, title: "Operations Dirsek", catalog_type: "product", base_uom_code: "piece", mass_grams: 127 },
    expect: 201,
  });
  assert.equal(createdProduct.payload.data.catalog_version_ref, `catalog-product:${productId}:v1`);

  const products = await request(panelUrl, "/api/products", { cookie: panelCookie });
  const product = products.payload.find((candidate) => candidate.sku === sku);
  assert.ok(product, "versioned product must be discoverable through the Panel product API");
  assert.equal(Number(product.central_stock), 0, "catalog creation must not create physical stock");

  const locationCode = "Z9-K1-P1-F";
  await request(warehouseUrl, "/api/execution/topology", {
    method: "POST", cookie: warehouseCookie,
    body: {
      idempotency_key: `topology-${productId}`,
      topology: {
        id: `topology-${productId}`, name: "Operations E2E", codeTemplate: "{rack}-K{level}-P{position}-{depth}",
        racks: [{ code: "Z9", levelCount: 1, positionCount: 6,
          depths: [{ code: "F", isFront: true, priority: 0 }], role: "PICKING",
          allowMixedSku: false, allowMixedLot: false, placementPriority: 0 }],
      },
    },
  });

  const supplierId = `supplier-${Date.now()}`;
  const purchaseId = `purchase-${Date.now()}`;
  await request(panelUrl, "/api/procurement/v1/suppliers", {
    method: "POST", cookie: panelCookie, headers: { "x-operation-id": `register-${supplierId}` },
    body: { id: supplierId, name: "Operations Supplier", defaultCurrency: "TRY" }, expect: 201,
  });
  await request(panelUrl, "/api/procurement/v1/purchases", {
    method: "POST", cookie: panelCookie, headers: { "x-operation-id": `create-${purchaseId}` },
    body: {
      id: purchaseId, supplierId, acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
      invoiceNumber: `INV-${purchaseId}`, invoiceDate: new Date().toISOString().slice(0, 10),
      lines: [{ id: `${purchaseId}-line`, productId: product.id, quantity: "5", quoteBasis: "piece",
        supplierUnitPriceMinor: 1_000, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
    },
    expect: 201,
  });
  const finalizedCosts = await request(panelUrl, `/api/procurement/v1/purchases/${purchaseId}/finalize-costs`, {
    method: "POST", cookie: panelCookie, headers: { "x-operation-id": `finalize-${purchaseId}` }, body: { allocations: [] },
  });
  const costSnapshot = finalizedCosts.payload.data.lots[0];
  assert.equal(costSnapshot.state, "COSTED_PENDING_RECEIPT");
  const receiptId = `receipt-${purchaseId}`;
  const packageId = `package-${purchaseId}`;
  const receipt = await request(warehouseUrl, "/api/execution/receipts", {
    method: "POST", cookie: warehouseCookie,
    body: {
      idempotency_key: `receive-${purchaseId}`, receiptId, receiptSeriesId: `series-${purchaseId}`,
      stageIndex: 1, isFinal: true, costSnapshotId: costSnapshot.id, supplierLotCode: lot,
      acceptedQuantityBaseInt: 5, damagedQuantityBaseInt: 0, receivedAt: new Date().toISOString(),
      packages: [{ id: packageId, code: `PKG-${Date.now()}`, quantityBaseInt: 5,
        targetQuantityBaseInt: 5, weightGrams: 635, disposition: "ACCEPTED" }],
    },
  });
  const pkg = receipt.payload.data.packages[0];
  assert.equal(pkg.initialQuantityBaseInt, 5);
  const afterReceiptProducts = await request(panelUrl, "/api/products", { cookie: panelCookie });
  const stockAfterReceipt = Number(afterReceiptProducts.payload.find((candidate) => candidate.id === product.id).central_stock);
  assert.equal(stockAfterReceipt, 5, "only the approved Warehouse receipt boundary may create physical stock");

  const currentState = await request(labelPrinterUrl, "/api/state", { cookie: labelCookie });
  const v1 = template("operations-goods-receipt-v1", "LIVE-V1");
  const stateV1 = await request(labelPrinterUrl, "/api/state", {
    method: "PUT",
    cookie: labelCookie,
    headers: { "If-Match": String(currentState.payload.revision) },
    body: { ...currentState.payload, template: v1, templates: [v1] },
  });
  const previewBody = { purpose: "goods_receipt", data: { SKU: sku, Package_code: pkg.code, Paket_no: "1 / 2", Malzeme: "Alüminyum" } };
  const previewV1 = await request(warehouseUrl, "/api/labels/preview", { method: "POST", cookie: warehouseCookie, body: previewBody });
  assert.equal(previewV1.response.headers.get("x-label-template-id"), v1.id);
  assert.equal(previewV1.payload.subarray(0, 4).toString(), "%PDF");

  const v2 = template("operations-goods-receipt-v2", "LIVE-V2");
  await request(labelPrinterUrl, "/api/state", {
    method: "PUT",
    cookie: labelCookie,
    headers: { "If-Match": String(stateV1.payload.revision) },
    body: { ...stateV1.payload, template: v2, templates: [v1, v2] },
  });
  const previewV2 = await request(warehouseUrl, "/api/labels/preview", { method: "POST", cookie: warehouseCookie, body: previewBody });
  assert.equal(previewV2.response.headers.get("x-label-template-id"), v2.id);
  assert.notEqual(previewV2.response.headers.get("x-label-template-id"), previewV1.response.headers.get("x-label-template-id"));

  const queued = await request(warehouseUrl, `/api/admin/packages/${pkg.id}/print`, {
    method: "POST",
    cookie: warehouseCookie,
    body: { claim_token: pkg.claim_token, idempotency_key: `print-${pkg.id}`, device_id: "operations-e2e" },
    expect: 201,
  });
  const printJobId = queued.payload.data.id;
  await waitFor("dry-run print job", async () => {
    const jobs = await request(warehouseUrl, "/api/admin/print-jobs", { cookie: warehouseCookie });
    return jobs.payload.data.find((job) => job.id === printJobId && job.status === "RENDERED");
  });

  await request(warehouseUrl, `/api/execution/packages/${pkg.id}/identity`, {
    method: "POST",
    cookie: warehouseCookie,
    body: { labelIdentity: pkg.code, idempotency_key: `identify-${pkg.id}` },
  });
  const suggestion = await request(warehouseUrl, `/api/execution/packages/${pkg.id}/suggestion`, { cookie: warehouseCookie });
  assert.equal(suggestion.payload.data.code, locationCode);
  await request(warehouseUrl, `/api/execution/packages/${pkg.id}/place`, {
    method: "POST",
    cookie: warehouseCookie,
    body: { destinationCode: locationCode, scannedDestinationCode: locationCode, idempotency_key: `place-${pkg.id}` },
  });
  const placedPackage = await request(warehouseUrl, `/api/execution/packages/${pkg.id}`, { cookie: warehouseCookie });
  assert.equal(placedPackage.payload.data.currentLocationCode, locationCode);
  const afterPlacementProducts = await request(panelUrl, "/api/products", { cookie: panelCookie });
  const stockAfterPlacement = Number(afterPlacementProducts.payload.find((candidate) => candidate.id === product.id).central_stock);
  assert.equal(stockAfterPlacement, stockAfterReceipt, "package placement must not post a second canonical stock movement");

  const accounts = await request(panelUrl, "/api/cash-accounts", { cookie: panelCookie });
  const cashAccount = accounts.payload.find((account) => account.is_active !== 0 && account.type === "cash") || accounts.payload[0];
  assert.ok(cashAccount);
  const sale = await request(panelUrl, "/api/sales", {
    method: "POST",
    cookie: panelCookie,
    headers: { "x-operation-id": `sale-${productId}` },
    body: {
      customer_name: "Operations E2E",
      total_quantity: 1,
      total_weight: 0.1273,
      total_amount: 100,
      platform: "Satış Sistemi",
      cash_account_id: cashAccount.id,
      currency: "TRY",
      discount_minor: 0,
      commission_rate: 10,
      commission_calculation_basis: "GROSS_BEFORE_DISCOUNT",
      commission_terms: { source: "operations-e2e", version: 1 },
      expenses: Object.fromEntries(["shipping", "packaging", "other"].map((category) => [
        category,
        { state: "UNKNOWN", provenance: { source: "operations-e2e", category } },
      ])),
      items: [{
        product_id: product.id,
        product_name: "Operations Dirsek",
        quantity: 1,
        price: 100,
        weight: 0.1273,
        unit_gross_minor: 10_000,
        vat_rate_bps: 2_000,
      }],
    },
  });
  assert.ok(sale.payload.id);
  const afterSaleProducts = await request(panelUrl, "/api/products", { cookie: panelCookie });
  const stockAfterSale = Number(afterSaleProducts.payload.find((candidate) => candidate.id === product.id).central_stock);

  const orders = await request(warehouseUrl, "/api/orders", { cookie: warehouseCookie });
  const order = orders.payload.data.find((candidate) => candidate.id === sale.payload.id);
  assert.ok(order, "new sale must appear in the Warehouse picking queue");
  await request(warehouseUrl, `/api/orders/${order.id}/start`, { method: "POST", cookie: warehouseCookie, body: {} });
  const plan = await request(warehouseUrl, `/api/orders/${order.id}/pick-plan`, { cookie: warehouseCookie });
  const pickItem = plan.payload.data.items.find((candidate) => candidate.product_id === product.id);
  assert.ok(pickItem);
  await request(warehouseUrl, `/api/orders/${order.id}/verify-pick`, {
    method: "POST",
    cookie: warehouseCookie,
    body: { product_id: product.id, code: sku },
  });
  await request(warehouseUrl, `/api/orders/${order.id}/pick-items/${product.id}/complete`, {
    method: "POST",
    cookie: warehouseCookie,
    body: { picked_quantity: 1 },
  });
  await request(warehouseUrl, `/api/orders/${order.id}/complete`, { method: "POST", cookie: warehouseCookie, body: { note: "operations e2e" } });

  const afterPickProducts = await request(panelUrl, "/api/products", { cookie: panelCookie });
  const stockAfterPick = Number(afterPickProducts.payload.find((candidate) => candidate.id === product.id).central_stock);
  assert.deepEqual(
    { stockAfterReceipt, stockAfterPlacement, stockAfterSale, stockAfterPick },
    { stockAfterReceipt: 5, stockAfterPlacement: 5, stockAfterSale: 5, stockAfterPick: 5 },
    "KNOWN BUSINESS RED: sale acceptance and internal pick must not post physical OUT before the owner-approved dispatch boundary",
  );
});
