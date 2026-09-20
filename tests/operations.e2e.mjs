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

const request = async (base, path, { method = "GET", body, token, cookie, apiKey, expect = 200 } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Accept: "application/json, application/pdf",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(!["GET", "HEAD"].includes(method) ? { Origin: base } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
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
  height: 60,
  elements: [
    { id: "marker", type: "text", x: 4, y: 4, width: 92, height: 8, value: `${marker} {SKU}`, fontSize: 4, fontWeight: "bold" },
    { id: "barcode", type: "barcode", x: 4, y: 18, width: 65, height: 26, value: "{Package_code}", showBarcodeText: true },
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
  const supplierCode = `SUP-${Date.now()}`;
  const lot = `LOT-${Date.now()}`;
  const headers = ["SKU", "Tedarik NO", "İsim - TR", "TÜR", "Lot Adedi", "Kutu sayısı", "Kutu içi adet", "Kutu Ağırlığı", "Parti/Lot", "Parça Ağırlığı"];
  const row = {
    SKU: sku,
    "Tedarik NO": supplierCode,
    "İsim - TR": "Operations Dirsek",
    "TÜR": "simple",
    "Lot Adedi": "10",
    "Kutu sayısı": "2",
    "Kutu içi adet": "5",
    "Kutu Ağırlığı": "0.64",
    "Parti/Lot": lot,
    "Parça Ağırlığı": "127.3",
  };
  const imported = await request(panelUrl, "/api/products/import", {
    method: "POST",
    cookie: panelCookie,
    body: { headers, rows: [row], dry_run: false, source_name: "operations-e2e.csv" },
  });
  assert.equal(imported.payload.applied, true);

  const products = await request(panelUrl, "/api/products", { cookie: panelCookie });
  const product = products.payload.find((candidate) => candidate.sku === sku);
  assert.ok(product, "imported product must be discoverable through the Panel product API");
  assert.equal(Number(product.central_stock), 0, "lot import must not pre-receive physical stock");

  const createdLocation = await request(warehouseUrl, "/api/admin/locations", {
    method: "POST",
    cookie: warehouseCookie,
    body: { code: "Z9-K1-P1", package_capacity: 4, purpose: "PICK" },
    expect: 201,
  });
  assert.equal(createdLocation.payload.data.code, "Z9-K1-P1");

  await request(warehouseUrl, "/api/admin/layouts/import-legacy", {
    method: "POST",
    cookie: warehouseCookie,
    body: {
      warehouseConfig: { name: "Operations E2E", width: 6, length: 4, height: 3 },
      objects: [{ id: "rack-z9", type: "rack", name: "Z9", rackCode: "Z9", x: 0, z: 0, width: 2, depth: 1, height: 2, shelfCount: 1, binsPerShelf: 1 }],
    },
    expect: 201,
  });

  const csvText = `sku,pick_face_location,reserve_locations\n${sku},Z9-K1-P1,\n`;
  const layoutPreview = await request(warehouseUrl, "/api/admin/layouts/placement/preview", {
    method: "POST",
    cookie: warehouseCookie,
    body: { source_filename: "operations-e2e-layout.csv", csv_text: csvText },
  });
  assert.equal(layoutPreview.payload.data.valid, true);
  await request(warehouseUrl, "/api/admin/layouts/placement/apply", {
    method: "POST",
    cookie: warehouseCookie,
    body: {
      source_filename: "operations-e2e-layout.csv",
      csv_text: csvText,
      preview_hash: layoutPreview.payload.data.preview_hash,
      notes: "isolated operations e2e",
    },
    expect: 201,
  });

  const receiving = await request(warehouseUrl, "/api/admin/receiving/sessions", {
    method: "POST",
    cookie: warehouseCookie,
    body: { lot_number: lot, supplier_code: supplierCode, device_id: "operations-e2e" },
    expect: 201,
  });
  const receivingId = receiving.payload.data.id;
  const claimed = await request(warehouseUrl, "/api/admin/packages/claim-next", {
    method: "POST",
    cookie: warehouseCookie,
    body: { supplier_code: supplierCode, session_id: receivingId, device_id: "operations-e2e" },
  });
  const pkg = claimed.payload.data;
  assert.equal(pkg.package_number, 1);

  const currentState = await request(labelPrinterUrl, "/api/state", { cookie: labelCookie });
  const v1 = template("operations-goods-receipt-v1", "LIVE-V1");
  await request(labelPrinterUrl, "/api/state", {
    method: "PUT",
    cookie: labelCookie,
    body: { ...currentState.payload, template: v1, templates: [v1] },
  });
  const previewBody = { purpose: "goods_receipt", data: { SKU: sku, Package_code: pkg.package_code, Paket_no: "1 / 2", Malzeme: "Alüminyum" } };
  const previewV1 = await request(warehouseUrl, "/api/labels/preview", { method: "POST", cookie: warehouseCookie, body: previewBody });
  assert.equal(previewV1.response.headers.get("x-label-template-id"), v1.id);
  assert.equal(previewV1.payload.subarray(0, 4).toString(), "%PDF");

  const v2 = template("operations-goods-receipt-v2", "LIVE-V2");
  await request(labelPrinterUrl, "/api/state", {
    method: "PUT",
    cookie: labelCookie,
    body: { ...currentState.payload, template: v2, templates: [v1, v2] },
  });
  const previewV2 = await request(warehouseUrl, "/api/labels/preview", { method: "POST", cookie: warehouseCookie, body: previewBody });
  assert.equal(previewV2.response.headers.get("x-label-template-id"), v2.id);
  assert.notEqual(previewV2.response.headers.get("x-label-template-id"), previewV1.response.headers.get("x-label-template-id"));

  const queued = await request(warehouseUrl, `/api/admin/packages/${pkg.id}/print`, {
    method: "POST",
    cookie: warehouseCookie,
    body: { claim_token: pkg.claim_token, idempotency_key: `print-${pkg.id}`, device_id: "operations-e2e" },
  });
  const printJobId = queued.payload.data.job.id;
  await waitFor("dry-run print job", async () => {
    const jobs = await request(warehouseUrl, "/api/admin/print-jobs", { cookie: warehouseCookie });
    return jobs.payload.data.find((job) => job.id === printJobId && job.status === "PRINTED");
  });

  await request(warehouseUrl, "/api/admin/placements", {
    method: "POST",
    cookie: warehouseCookie,
    body: { package_code: pkg.package_code, location_code: "Z9-K1-P1", idempotency_key: `place-${pkg.id}`, device_id: "operations-e2e" },
  });
  const afterReceiptProducts = await request(panelUrl, "/api/products", { cookie: panelCookie });
  const stockAfterReceipt = Number(afterReceiptProducts.payload.find((candidate) => candidate.id === product.id).central_stock);
  assert.equal(stockAfterReceipt, 5, "placing one package must increase central stock by its package quantity");

  const accounts = await request(panelUrl, "/api/cash-accounts", { cookie: panelCookie });
  const cashAccount = accounts.payload.find((account) => account.is_active !== 0 && account.type === "cash") || accounts.payload[0];
  assert.ok(cashAccount);
  const sale = await request(panelUrl, "/api/sales", {
    method: "POST",
    cookie: panelCookie,
    body: {
      customer_name: "Operations E2E",
      total_quantity: 1,
      total_weight: 0.1273,
      total_amount: 100,
      platform: "Satış Sistemi",
      cash_account_id: cashAccount.id,
      items: [{ product_id: product.id, product_name: "Operations Dirsek", quantity: 1, price: 100, weight: 0.1273 }],
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
    { stockAfterReceipt, stockAfterSale, stockAfterPick },
    { stockAfterReceipt: 5, stockAfterSale: 5, stockAfterPick: 5 },
    "KNOWN BUSINESS RED: sale acceptance and internal pick must not post physical OUT before the owner-approved dispatch boundary",
  );
});
