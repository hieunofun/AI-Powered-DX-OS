import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const gateway = process.env.GATEWAY_BASE_URL || 'http://localhost:9080';
const keycloak = process.env.TEST_KEYCLOAK_URL || 'http://localhost:8080';
const password = process.env.TEST_DEMO_PASSWORD || 'DemoPassword123!';
const description = 'WEB E2E Reconciliation Fixture';
const sku = 'WEB-24-SKU';
let lastWindow = Date.now();

// Each financial scenario gets a fresh production gateway quota window. No retries.
test.beforeEach(async () => {
  test.setTimeout(180_000);
  const wait = Math.max(0, lastWindow + 61_000 - Date.now());
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastWindow = Date.now();
});
async function auth(request: APIRequestContext, role = 'admin') {
  const response = await request.post(`${keycloak}/realms/smartprocure/protocol/openid-connect/token`, {
    form: { grant_type: 'password', client_id: 'smartprocure-ci', username: `${role}.demo`, password },
  });
  expect(response.status()).toBe(200);
  return { Authorization: `Bearer ${(await response.json()).access_token}` };
}
async function call(request: APIRequestContext, headers: Record<string, string>, method: string, path: string, data?: unknown, status = 200) {
  const response = await request.fetch(`${gateway}/api/${path}`, { method, headers, ...(data === undefined ? {} : { data }) });
  expect(response.status()).toBe(status);
  return response.json();
}
async function fixture(request: APIRequestContext, received = 2) {
  const headers = await auth(request);
  const suppliers = await call(request, headers, 'GET', 'purchase-orders/suppliers?search=WEB-E2E&limit=20');
  const supplier = suppliers.data.find((row: { supplierCode: string }) => row.supplierCode === 'WEB-E2E-ACTIVE');
  expect(supplier).toBeTruthy();
  const po = await call(request, headers, 'POST', 'purchase-orders', {
    supplierId: supplier.id, currency: 'VND', orderDate: '2026-10-08',
    items: [{ sku, description, orderedQuantity: '2', unitPrice: '100', taxRate: '0.1' }],
  }, 201);
  await call(request, headers, 'POST', `purchase-orders/${po.id}/issue`, { expectedVersion: po.version });
  if (received) {
    const grn = await call(request, headers, 'POST', 'goods-receipts', {
      purchaseOrderId: po.id, receivedAt: '2026-10-08', referenceNote: 'WEB24 synthetic receipt',
      items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: String(received), acceptedQuantity: String(received), rejectedQuantity: '0' }],
    }, 201);
    await call(request, headers, 'POST', `goods-receipts/${grn.id}/receive`);
  }
  return { po, headers, number: `WEB24-${Date.now()}-${po.id.slice(0, 8)}` };
}
function xml(number: string, price = 100) {
  return `<?xml version="1.0" encoding="UTF-8"?><SmartProcureInvoice version="1"><NguoiBan><MST>WEB-E2E-TAX-ACTIVE</MST></NguoiBan><NguoiMua><MST>WEB24-SYNTHETIC-BUYER</MST></NguoiMua><ThongTinChung><SHDon>${number}</SHDon><NLap>2026-10-08</NLap><DVTTe>VND</DVTTe></ThongTinChung><DanhSachHangHoa><HangHoa><MHHDVu>${sku}</MHHDVu><THHDVu>${description}</THHDVu><SLuong>2</SLuong><DGia>${price}</DGia><TSuat>10</TSuat><ThTien>${price * 2}</ThTien><TienThue>${price / 5}</TienThue><TongTien>${price * 22 / 10}</TongTien></HangHoa></DanhSachHangHoa><TongTien><TgTCThue>${price * 2}</TgTCThue><TgTThue>${price / 5}</TgTThue><TgTTTBSo>${price * 22 / 10}</TgTTTBSo></TongTien></SmartProcureInvoice>`;
}
async function ready(request: APIRequestContext) {
  const data = await fixture(request);
  const response = await request.post(`${gateway}/api/invoices/ingest`, { headers: data.headers,
    multipart: { purchaseOrderId: data.po.id, xml: { name: 'web24.xml', mimeType: 'application/xml', buffer: Buffer.from(xml(data.number)) } } });
  expect(response.status()).toBe(201);
  const invoiceId = (await response.json()).invoiceId as string;
  await call(request, data.headers, 'POST', `invoices/${invoiceId}/match`);
  await call(request, data.headers, 'POST', `invoices/${invoiceId}/workflow/start`);
  return { ...data, invoiceId };
}
async function login(page: Page, role = 'accountant') {
  await page.goto('/'); await page.getByRole('button', { name: 'Đăng nhập để làm việc' }).click();
  await page.locator('#username').fill(`${role}.demo`); await page.locator('#password').fill(password); await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Đơn đặt hàng', exact: true })).toBeVisible();
}
async function upload(page: Page, poId: string, content: string, kind: 'xml' | 'pdf' = 'xml') {
  await page.goto(`/#/invoices/new?po=${poId}`);
  await expect(page.getByRole('heading', { name: 'Nhập hóa đơn', exact: true })).toBeVisible();
  await page.locator(`#invoice-${kind}`).setInputFiles({ name: `web24.${kind}`, mimeType: kind === 'xml' ? 'application/xml' : 'application/pdf', buffer: Buffer.from(content) });
  await expect(page.getByRole('button', { name: 'Tiếp nhận hóa đơn', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Tiếp nhận hóa đơn', exact: true }).click();
}
async function confirm(page: Page, action: string) {
  await page.getByRole('button', { name: action, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
}
async function decide(page: Page, action: string, reason: string) {
  await page.getByRole('button', { name: 'Ra quyết định', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Xác nhận quyết định' })).toBeDisabled();
  await dialog.getByLabel('Quyết định', { exact: true }).selectOption(action);
  await dialog.getByLabel('Lý do quyết định', { exact: true }).fill(reason);
  await dialog.getByRole('button', { name: 'Xác nhận quyết định' }).click();
  await expect(dialog).not.toBeVisible();
}

test('clean XML persists, matches, takes STP and exports native verified JSON/PDF', async ({ page, request }, info) => {
  const data = await fixture(request); await login(page); await upload(page, data.po.id, xml(data.number));
  await expect(page.getByRole('heading', { name: data.number, exact: true })).toBeVisible();
  const invoiceId = page.url().split('/').at(-1)!;
  await confirm(page, 'Đối soát 3 chiều');
  await expect(page.locator('.comparison-table')).toContainText('Chấp nhận: 2');
  await expect(page.locator('.comparison-table')).toContainText('SL: 2');
  await expect(page.getByText('Đạt chính sách', { exact: true })).toBeVisible();
  await confirm(page, 'Bắt đầu luồng xử lý');
  await expect(page.getByText('Luồng tự động STP', { exact: false })).toBeVisible();
  await page.reload(); await expect(page.getByText('Sẵn sàng thanh toán', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Kiểm chứng hồ sơ', exact: true }).click();
  await expect(page.getByText('Chưa chạy kiểm chứng trong lần xem này.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Kiểm chứng ngay', exact: true }).click();
  await expect(page.getByText('Kiểm chứng thành công', { exact: true })).toBeVisible();
  for (const kind of ['JSON', 'PDF'] as const) {
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: `Tải báo cáo ${kind}`, exact: true }).click();
    const download = await event; expect(download.suggestedFilename()).toBe(`audit-${invoiceId}.${kind.toLowerCase()}`);
    const bytes = await readFile((await download.path())!);
    if (kind === 'JSON') { const report = JSON.parse(bytes.toString()); expect(report.verificationStatus).toBe('VERIFIED'); expect(report.immudb.cryptographicProofValid).toBe(true); }
    else expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  }
  for (const width of [1440, 768, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width !== 768) await page.screenshot({ path: info.outputPath(`audit-${width}.png`), fullPage: true });
  }
});

test('price exception routes to buyer who claims and approves with a recorded explanation', async ({ page, request, browser }) => {
  const data = await fixture(request); await login(page); await upload(page, data.po.id, xml(data.number, 150));
  await expect(page.getByRole('heading', { name: data.number })).toBeVisible();
  const invoiceId = page.url().split('/').at(-1)!;
  await confirm(page, 'Đối soát 3 chiều'); await expect(page.locator('.comparison-table')).toContainText('PRICE_MISMATCH');
  await confirm(page, 'Bắt đầu luồng xử lý');
  const caseLink = page.getByRole('link', { name: 'Xem nhiệm vụ và quyết định' }); await expect(caseLink).toBeVisible();
  const caseRoute = (await caseLink.getAttribute('href'))!;
  const context = await browser.newContext(); const buyer = await context.newPage();
  try {
    await login(buyer, 'buyer'); await buyer.goto(`/${caseRoute}`);
    await expect(buyer.getByRole('button', { name: 'Nhận nhiệm vụ', exact: true })).toBeVisible();
    await expect(buyer.getByRole('button', { name: 'Ra quyết định', exact: true })).toHaveCount(0);
    await buyer.getByRole('button', { name: 'Nhận nhiệm vụ', exact: true }).click();
    await expect(buyer.getByText('Bạn đã nhận nhiệm vụ này')).toBeVisible();
    await decide(buyer, 'APPROVE_WITH_ADJUSTMENT', 'WEB24: Approved synthetic contractual price exception');
    await expect(buyer.getByText('Sẵn sàng thanh toán', { exact: false }).first()).toBeVisible();
    await buyer.reload(); await expect(buyer.locator('.decision-history')).toContainText('WEB24: Approved synthetic contractual price exception');
  } finally { await context.close(); }
  const invoice = await call(request, data.headers, 'GET', `invoices/${invoiceId}`);
  expect(invoice.totalAmount).toBe('330.00'); expect(invoice.status).toBe('READY_FOR_PAYMENT');
  await page.goto(`/#/audit/${invoiceId}`); await page.getByRole('button', { name: 'Kiểm chứng ngay' }).click();
  await expect(page.getByText('Kiểm chứng thành công', { exact: true })).toBeVisible();
});

test('missing GRN routes to warehouse and credit-note decision remains unpaid', async ({ page, request, browser }) => {
  const data = await fixture(request, 0); await login(page); await upload(page, data.po.id, xml(data.number));
  await expect(page.getByRole('heading', { name: data.number })).toBeVisible(); const invoiceId = page.url().split('/').at(-1)!;
  await confirm(page, 'Đối soát 3 chiều'); await expect(page.locator('.comparison-table')).toContainText('MISSING_GRN');
  await confirm(page, 'Bắt đầu luồng xử lý');
  const link = page.getByRole('link', { name: 'Xem nhiệm vụ và quyết định' }); await expect(link).toBeVisible(); const route = (await link.getAttribute('href'))!;
  const context = await browser.newContext(); const warehouse = await context.newPage();
  try {
    await login(warehouse, 'warehouse'); await warehouse.goto(`/${route}`);
    await expect(warehouse.locator('.comparison-table')).toContainText('MISSING_GRN');
    await expect(warehouse.getByRole('link', { name: 'Xem hóa đơn', exact: true })).toHaveCount(0);
    await warehouse.getByRole('button', { name: 'Nhận nhiệm vụ', exact: true }).click();
    await expect(warehouse.getByRole('button', { name: 'Ra quyết định', exact: true })).toBeVisible();
    await decide(warehouse, 'REQUEST_CREDIT_NOTE', 'WEB24: Receipt missing; request supplier correction');
    await expect(warehouse.getByText('Hệ thống chưa tự gửi yêu cầu', { exact: false })).toBeVisible();
  } finally { await context.close(); }
  const invoice = await call(request, data.headers, 'GET', `invoices/${invoiceId}`); expect(invoice.status).toBe('EXCEPTION');
  await page.goto(`/#/audit/${invoiceId}`); await page.getByRole('button', { name: 'Kiểm chứng ngay' }).click();
  await expect(page.getByText('Kiểm chứng thành công', { exact: true })).toBeVisible();
});

test('PDF remains OCR_REQUIRED; malformed and duplicate XML expose persisted failed ingestion', async ({ page, request }) => {
  const data = await fixture(request); await login(page);
  await page.goto(`/#/invoices/new?po=${data.po.id}`); await expect(page.getByRole('button', { name: 'Tiếp nhận hóa đơn' })).toBeEnabled();
  await page.getByRole('button', { name: 'Tiếp nhận hóa đơn' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Kiểm tra lại thông tin' })).toBeFocused();
  await upload(page, data.po.id, '%PDF-1.4\nWEB24 synthetic OCR placeholder\n%%EOF\n', 'pdf');
  await expect(page).toHaveURL(/#\/ingestions\/[a-f0-9-]+$/); await expect(page.getByText('Chờ OCR', { exact: true }).first()).toBeVisible();
  await page.reload(); await expect(page.getByText('Dịch vụ OCR chưa được cấu hình', { exact: false })).toBeVisible();
  await upload(page, data.po.id, '<SmartProcureInvoice version="1"><broken>');
  const failed = page.getByRole('link', { name: 'Xem trạng thái và mã lỗi trước khi gửi lại' }); await expect(failed).toBeVisible(); await failed.click();
  await expect(page.getByText('Thất bại', { exact: true }).first()).toBeVisible();
  await upload(page, data.po.id, xml(data.number)); await expect(page.getByRole('heading', { name: data.number })).toBeVisible();
  await upload(page, data.po.id, xml(data.number)); await expect(failed).toBeVisible(); await failed.click();
  await expect(page.getByText('DUPLICATE_INVOICE', { exact: false }).first()).toBeVisible();
  const invoices = await call(request, data.headers, 'GET', `invoices?purchaseOrderId=${data.po.id}`); expect(invoices.total).toBe(1);
});

test('real roles deny writes/audit; injected audit outages and contradictory replies never appear verified', async ({ page, request, browser }) => {
  const data = await ready(request); const buyerHeaders = await auth(request, 'buyer');
  expect((await request.get(`${gateway}/api/audit/invoices/${data.invoiceId}/verify`, { headers: buyerHeaders })).status()).toBe(403);
  expect((await request.post(`${gateway}/api/invoices/ingest`, { headers: buyerHeaders })).status()).toBe(403);
  expect((await request.get(`${gateway}/api/invoices/${data.invoiceId}`)).status()).toBe(401);
  const context = await browser.newContext(); const buyer = await context.newPage();
  try { await login(buyer, 'buyer'); await buyer.goto(`/#/invoices/${data.invoiceId}`); await expect(buyer.getByRole('heading', { name: data.number })).toBeVisible();
    await expect(buyer.getByRole('link', { name: 'Kiểm chứng hồ sơ', exact: true })).toHaveCount(0);
    await expect(buyer.getByRole('button', { name: 'Bắt đầu luồng xử lý', exact: true })).toHaveCount(0);
  } finally { await context.close(); }
  await login(page); await page.goto(`/#/audit/${data.invoiceId}`); await expect(page.getByRole('button', { name: 'Kiểm chứng ngay' })).toBeVisible();
  const verified = await call(request, data.headers, 'GET', `audit/invoices/${data.invoiceId}/verify`);
  const path = `**/api/audit/invoices/${data.invoiceId}/verify`;
  for (const status of ['UNAVAILABLE', 'LEDGER_MISMATCH'] as const) {
    await page.route(path, route => route.fulfill({ status: status === 'UNAVAILABLE' ? 503 : 200, contentType: 'application/json', body: JSON.stringify({ ...verified, verificationStatus: status, immudbEntryMatches: false, immudbCryptographicProofValid: false }) }));
    await page.getByRole('button', { name: 'Kiểm chứng ngay' }).click(); await expect(page.getByText(status, { exact: true })).toBeVisible();
    await expect(page.getByText('Kiểm chứng thành công', { exact: true })).toHaveCount(0); await page.unroute(path);
  }
  await page.route(path, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...verified, immudbCryptographicProofValid: false }) }));
  await page.getByRole('button', { name: 'Kiểm chứng ngay' }).click();
  await expect(page.getByText('Kết quả kiểm chứng không đầy đủ hoặc mâu thuẫn.', { exact: false })).toBeVisible();
  await expect(page.getByText('Kiểm chứng thành công', { exact: true })).toHaveCount(0); await page.unroute(path);
  const jsonPath = `**/api/audit/invoices/${data.invoiceId}/report.json`;
  await page.route(jsonPath, route => route.fulfill({ status: 503, contentType: 'application/json', headers: { 'X-Audit-Verification-Status': 'UNAVAILABLE' }, body: JSON.stringify({ invoiceId: data.invoiceId, verificationStatus: 'UNAVAILABLE' }) }));
  const warningDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'Tải báo cáo JSON' }).click(); await warningDownload;
  await expect(page.getByText('UNAVAILABLE', { exact: true })).toBeVisible(); await page.unroute(jsonPath);
  await page.route(`**/api/audit/invoices/${data.invoiceId}/report.json`, route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"Forbidden"}' }));
  await page.getByRole('button', { name: 'Tải báo cáo JSON' }).click(); await expect(page.getByText('Tài khoản không có quyền thực hiện thao tác này.', { exact: true })).toBeVisible();
});

test('real source metadata tampering and ledger receipt mismatch are displayed and restored', async ({ page, request }) => {
  if (process.env.NODE_ENV === 'production') throw new Error('Synthetic audit corruption checks require development/CI');
  const data = await ready(request); expect(data.number).toMatch(/^WEB24-/); await login(page); await page.goto(`/#/audit/${data.invoiceId}`);
  const pool = new Pool({ host: process.env.POSTGRES_HOST || 'localhost', port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || 'smartprocure_db', user: process.env.POSTGRES_USER || 'smartprocure_user', password: process.env.POSTGRES_PASSWORD || 'postgres_password' });
  const files = await call(request, data.headers, 'GET', `invoices/${data.invoiceId}/files`);
  const seal = (await pool.query('SELECT id,immudb_tx_hash FROM audit_seals WHERE invoice_id=$1', [data.invoiceId])).rows[0];
  try {
    await pool.query('UPDATE invoice_files SET sha256=$2 WHERE id=$1', [files[0].id, 'f'.repeat(64)]);
    await page.getByRole('button', { name: 'Kiểm chứng ngay' }).click(); await expect(page.getByText('TAMPERED', { exact: true })).toBeVisible();
    await expect(page.getByText('Kiểm chứng thành công', { exact: true })).toHaveCount(0);
    await pool.query('UPDATE invoice_files SET sha256=$2 WHERE id=$1', [files[0].id, files[0].sha256]);
    await pool.query('UPDATE audit_seals SET immudb_tx_hash=$2 WHERE id=$1', [seal.id, 'f'.repeat(64)]);
    await page.getByRole('button', { name: 'Kiểm chứng ngay' }).click(); await expect(page.getByText('LEDGER_MISMATCH', { exact: true })).toBeVisible();
  } finally {
    await pool.query('UPDATE invoice_files SET sha256=$2 WHERE id=$1', [files[0].id, files[0].sha256]);
    await pool.query('UPDATE audit_seals SET immudb_tx_hash=$2 WHERE id=$1', [seal.id, seal.immudb_tx_hash]); await pool.end();
  }
  await page.getByRole('button', { name: 'Kiểm chứng ngay' }).click(); await expect(page.getByText('Kiểm chứng thành công', { exact: true })).toBeVisible();
});
