import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const gateway = process.env.GATEWAY_BASE_URL || 'http://localhost:9080';
const keycloak = process.env.TEST_KEYCLOAK_URL || 'http://localhost:8080';
const password = process.env.TEST_DEMO_PASSWORD || 'DemoPassword123!';

test.beforeAll(async ({ request }) => {
  await expect.poll(async () => {
    try { return (await request.get(`${gateway}/api/health`)).status(); } catch { return 0; }
  }, { timeout: 90_000, intervals: [1000, 2000] }).toBe(200);
});

async function login(page: Page, role = 'buyer') {
  await page.goto('/');
  await page.getByRole('button', { name: 'Đăng nhập để làm việc' }).click();
  await page.locator('#username').fill(`${role}.demo`);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Đơn đặt hàng', exact: true })).toBeVisible();
}

async function authorized(request: APIRequestContext, role = 'buyer') {
  const response = await request.post(`${keycloak}/realms/smartprocure/protocol/openid-connect/token`, {
    form: { grant_type: 'password', client_id: 'smartprocure-ci', username: `${role}.demo`, password },
  });
  expect(response.status()).toBe(200);
  const token = (await response.json()).access_token as string;
  return { Authorization: `Bearer ${token}` };
}

async function createInUi(page: Page, label: string, price = '1000000.0001') {
  await page.getByRole('link', { name: '+ Tạo đơn đặt hàng' }).click();
  await page.locator('#supplier-search').fill('WEB-E2E');
  await page.getByRole('button', { name: 'Tra cứu', exact: true }).click();
  const picker = page.locator('#supplier');
  await expect(picker.locator('option', { hasText: 'WEB E2E Synthetic Office Supplier' })).toHaveCount(1);
  await expect(picker.locator('option', { hasText: 'Blocked' })).toBeDisabled();
  await picker.selectOption({ label: 'WEB E2E Synthetic Office Supplier · MST WEB-E2E-TAX-ACTIVE' });
  await page.locator('#order-date').fill('2026-10-07');
  await page.locator('#description-0').fill(label);
  await page.locator('#sku-0').fill('HP-CE285A');
  await page.locator('#orderedQuantity-0').fill('10');
  await page.locator('#unitPrice-0').fill(price);
  await page.locator('#taxRate-0').fill('0.1');
  const sent = page.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/purchase-orders'));
  await page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  const payload = (await sent).postDataJSON();
  expect(payload.items[0].orderedQuantity).toBe('10');
  expect(payload.items[0].unitPrice).toBe(price);
  await expect(page).toHaveURL(/#\/orders\/[a-f0-9-]+$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^PO-/);
  return { id: page.url().split('/').at(-1)!, number: await page.getByRole('heading', { level: 1 }).innerText() };
}

async function confirm(page: Page, name: string, reason?: string) {
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  if (reason) await dialog.getByLabel('Lý do hủy', { exact: true }).fill(reason);
  await dialog.getByRole('button', { name: 'Xác nhận', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('buyer creates, edits, reloads, issues and cancels a PO through real SSO and gateway', async ({ page, request }) => {
  await login(page);
  const label = `WEB UI Precision ${Date.now()}`;
  const po = await createInUi(page, label);
  // The API rounds financial totals to two places; the original unit price retains four.
  await expect(page.locator('.grand-total')).toContainText('11.000.000 VND');
  await expect(page.getByRole('table').first().locator('tbody tr td').nth(2)).toHaveText('1.000.000,0001');
  await page.reload();
  await expect(page.getByRole('heading', { name: po.number })).toBeVisible();
  await expect(page.getByText(label, { exact: true })).toHaveCount(2);
  await page.getByRole('link', { name: 'Sửa bản nháp' }).click();
  await page.locator('#description-0').fill(`${label} edited`);
  await page.locator('#delivery-date').fill('2026-10-20');
  await page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(page.locator('.metadata')).toContainText('20/10/2026');
  await page.getByRole('link', { name: 'Sửa bản nháp' }).click();
  await page.locator('#delivery-date').fill('');
  await page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(page.getByRole('heading', { name: po.number })).toBeVisible();
  const headers = await authorized(request);
  const saved = await request.get(`${gateway}/api/purchase-orders/${po.id}`, { headers });
  expect((await saved.json()).expectedDeliveryDate).toBeNull();
  await page.getByRole('button', { name: 'Phát hành PO' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Phát hành PO' })).toBeFocused();
  await confirm(page, 'Phát hành PO');
  await expect(page.locator('.page-heading .status')).toHaveText('Đã phát hành');
  await expect(page.getByRole('link', { name: 'Sửa bản nháp' })).toHaveCount(0);
  await confirm(page, 'Hủy PO', 'WEB E2E: cancel issued test order');
  await expect(page.locator('.page-heading .status')).toHaveText('Đã hủy');
  await page.reload();
  await expect(page.getByText('Lý do hủy: WEB E2E: cancel issued test order')).toBeVisible();
});

test('warehouse classifies partial receipts, blocks over-delivery, reaches full receipt and reverses a cancellation', async ({ page, browser, request }) => {
  await login(page);
  const po = await createInUi(page, `WEB UI Receiving ${Date.now()}`);
  await confirm(page, 'Phát hành PO');
  const warehouseContext = await browser.newContext();
  const warehousePage = await warehouseContext.newPage();
  try {
    await login(warehousePage, 'warehouse');
    await warehousePage.goto(`/#/orders/${po.id}`);
    await expect(warehousePage.getByRole('button', { name: 'Phát hành PO' })).toHaveCount(0);
    await warehousePage.getByRole('link', { name: '+ Lập phiếu nhận hàng' }).click();
    await warehousePage.locator('#receivedQuantity-0').fill('5');
    await warehousePage.locator('#acceptedQuantity-0').fill('4');
    await warehousePage.locator('#rejectedQuantity-0').fill('1');
    await warehousePage.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
    await expect(warehousePage.getByRole('alert')).toContainText('ghi lý do từ chối');
    await expect(warehousePage.getByRole('alert')).toBeFocused();
    await warehousePage.locator('#damageNote-0').fill('WEB E2E: packaging damaged');
    await warehousePage.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
    await expect(warehousePage).toHaveURL(/#\/receipts\/[a-f0-9-]+$/);
    const firstId = warehousePage.url().split('/').at(-1)!;
    await confirm(warehousePage, 'Xác nhận nhận hàng');
    await expect(warehousePage.locator('.page-heading .status')).toHaveText('Đã xác nhận');
    await warehousePage.goto(`/#/orders/${po.id}`);
    await expect(warehousePage.locator('.page-heading .status')).toHaveText('Nhận một phần');
    const progress = warehousePage.getByRole('table').nth(1).locator('tbody tr').first();
    await expect(progress).toContainText('4');
    await expect(progress.locator('td').nth(3)).toHaveText('1');
    await expect(progress.locator('td').nth(4)).toHaveText('6');
    await warehousePage.getByRole('link', { name: '+ Lập phiếu nhận hàng' }).click();
    await warehousePage.locator('#receivedQuantity-0').fill('7');
    await warehousePage.locator('#acceptedQuantity-0').fill('7');
    await warehousePage.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
    await expect(warehousePage).toHaveURL(/#\/receipts\/[a-f0-9-]+$/);
    await warehousePage.getByRole('button', { name: 'Xác nhận nhận hàng' }).click();
    await warehousePage.getByRole('dialog').getByRole('button', { name: 'Xác nhận', exact: true }).click();
    await expect(warehousePage.getByRole('dialog').getByRole('alert')).toBeVisible();
    await warehousePage.getByRole('dialog').getByRole('button', { name: 'Quay lại' }).click();
    await warehousePage.getByRole('link', { name: 'Sửa bản nháp' }).click();
    await warehousePage.locator('#receivedQuantity-0').fill('6');
    await warehousePage.locator('#acceptedQuantity-0').fill('6');
    await warehousePage.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
    await expect(warehousePage).toHaveURL(/#\/receipts\/[a-f0-9-]+$/);
    await confirm(warehousePage, 'Xác nhận nhận hàng');
    await warehousePage.goto(`/#/orders/${po.id}`);
    await expect(warehousePage.locator('.page-heading .status')).toHaveText('Đã nhận đủ');
    await warehousePage.goto(`/#/receipts/${firstId}`);
    await confirm(warehousePage, 'Hủy phiếu', 'WEB E2E: reverse first receipt');
    await warehousePage.goto(`/#/orders/${po.id}`);
    await expect(warehousePage.locator('.page-heading .status')).toHaveText('Nhận một phần');
    await expect(warehousePage.getByRole('table').nth(1).locator('tbody tr td').nth(2)).toHaveText('6');
    await expect(warehousePage.getByRole('table').nth(1).locator('tbody tr td').nth(3)).toHaveText('0');
    const headers = await authorized(request);
    const snapshot = await request.get(`${gateway}/api/purchase-orders/${po.id}/fulfillment`, { headers });
    expect((await snapshot.json())[0].acceptedQuantity).toBe('6.0000');
  } finally { await warehouseContext.close(); }
});

test('a real concurrent PO edit returns 409 and preserves the pending draft', async ({ page, request }) => {
  await login(page);
  const po = await createInUi(page, `WEB UI Conflict ${Date.now()}`);
  await page.getByRole('link', { name: 'Sửa bản nháp' }).click();
  await page.locator('#description-0').fill('Unsaved user change');
  const headers = await authorized(request);
  const snapshot = await request.get(`${gateway}/api/purchase-orders/${po.id}`, { headers });
  const newer = await request.patch(`${gateway}/api/purchase-orders/${po.id}`, { headers, data: { expectedVersion: (await snapshot.json()).version, currency: 'USD' } });
  expect(newer.status()).toBe(200);
  await page.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Hồ sơ đã thay đổi');
  await expect(page.locator('#description-0')).toHaveValue('Unsaved user change');
  await expect(page.locator('#currency')).toHaveValue('VND');
});

test('accountant is read-only and backend rejects unauthorized writes and missing tokens', async ({ page, request }) => {
  await login(page, 'accountant');
  await expect(page.getByRole('link', { name: '+ Tạo đơn đặt hàng' })).toHaveCount(0);
  await page.goto('/#/orders/new');
  await expect(page.getByText('Chỉ nhân viên mua hàng và quản trị viên được sửa PO.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lưu bản nháp' })).toHaveCount(0);
  const headers = await authorized(request, 'accountant');
  const forbidden = await request.post(`${gateway}/api/purchase-orders`, { headers, data: {} });
  expect(forbidden.status()).toBe(403);
  expect((await request.get(`${gateway}/api/purchase-orders`)).status()).toBe(401);
  expect((await request.get(`${gateway}/api/purchase-orders/suppliers`, { headers })).status()).toBe(200);
  expect((await request.get(`${gateway}/api/purchase-orders/suppliers?limit=101`, { headers })).status()).toBe(400);
});

test('loading failures, empty results and narrow layouts are usable', async ({ page }, info) => {
  await login(page);
  for (const status of [401, 403]) {
    // Error presentation only is fault-injected. All lifecycle tests above use real services.
    await page.route('**/api/purchase-orders?*', route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message: 'WEB E2E injected read failure' }) }));
    await page.getByRole('button', { name: 'Làm mới', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(status === 401 ? 'Phiên đăng nhập' : 'không có quyền');
    await page.unroute('**/api/purchase-orders?*');
    await page.getByRole('button', { name: 'Thử lại' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await page.locator('#po-search').fill('WEB-NONEXISTENT-ORDER');
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chưa có đơn đặt hàng phù hợp' })).toBeVisible();
  await page.locator('#po-search').fill('');
  await page.getByRole('button', { name: 'Tìm kiếm', exact: true }).click();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`orders-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 812, height: 375 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 375, height: 900 });
  await page.getByRole('link', { name: '+ Tạo đơn đặt hàng' }).click();
  await expect(page.locator('#description-0')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('order-form-375.png'), fullPage: true });
});
