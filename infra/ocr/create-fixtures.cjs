/* SPDX-License-Identifier: MIT */
'use strict';
// Fictional code-rendered Vietnamese documents; no existing user images or production records.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('@playwright/test');
const PDFDocument = require('pdfkit');
const root = path.resolve(__dirname, '../..');
const destination = path.join(__dirname, 'fixtures', 'vn-reviewed-v1');
const font = path.join(root, 'infra/audit/fonts/NotoSans.ttf');
const date = new Date('2026-10-15T00:00:00Z');
const cases = [
  { id: 'dev-digital', split: 'dev', kind: 'text-pdf', invoice: 'OCR-DEV-001', date: '2026-10-01', currency: 'VND',
    po: '00000000-0000-4000-8000-000000000126', seller: 'SYNTH-MST-001', buyer: 'SYNTH-MST-101',
    lines: [{ description: 'Hộp mực mẫu', sku: 'CE285A', quantity: '2', price: '500000.00', rate: '0.10', subtotal: '1000000.00', tax: '100000.00', total: '1100000.00' }], subtotal: '1000000.00', tax: '100000.00', total: '1100000.00' },
  { id: 'dev-png', split: 'dev', kind: 'png', invoice: 'OCR-DEV-002', date: '2026-10-02', currency: 'USD',
    po: '00000000-0000-4000-8000-000000000226', seller: 'SYNTH-MST-002', buyer: 'SYNTH-MST-102',
    lines: [{ description: 'Bút mẫu', sku: 'PEN-SYN', quantity: '4', price: '12.50', rate: '0', subtotal: '50.00', tax: '0.00', total: '50.00' }], subtotal: '50.00', tax: '0.00', total: '50.00' },
  { id: 'held-scanned', split: 'held-out', kind: 'scanned-pdf', invoice: 'OCR-HOLD-101', date: '2026-10-03', currency: 'VND',
    po: '00000000-0000-4000-8000-000000000326', seller: 'SYNTH-MST-003', buyer: 'SYNTH-MST-103',
    lines: [{ description: 'Giấy mẫu', sku: 'PAPER-SYN', quantity: '1.2500', price: '80000.0000', rate: '0.08', subtotal: '100000.00', tax: '8000.00', total: '108000.00' },
      { description: 'Hộp mực mẫu', sku: 'CE285A', quantity: '2', price: '70000.00', rate: '0.10', subtotal: '140000.00', tax: '14000.00', total: '154000.00' }], subtotal: '240000.00', tax: '22000.00', total: '262000.00' },
  { id: 'held-jpeg', split: 'held-out', kind: 'jpeg', invoice: 'OCR-HOLD-102', date: '2026-10-04', currency: 'VND',
    po: '00000000-0000-4000-8000-000000000426', seller: 'SYNTH-MST-004', buyer: 'SYNTH-MST-104',
    lines: [{ description: 'Thiết bị mẫu', quantity: '1', price: '125000.00', rate: '0.08', subtotal: '125000.00', tax: '10000.00', total: '135000.00' }], subtotal: '125000.00', tax: '10000.00', total: '135000.00' },
];
function lines(item) {
  return ['CHỨNG TỪ HƯ CẤU — KHÔNG DÙNG THANH TOÁN', 'Công ty Mẫu Sông Lam / Nhà cung cấp giả lập',
    'Mã PO (UUID): ' + item.po, 'Mã số thuế bên bán: ' + item.seller, 'Mã số thuế bên mua: ' + item.buyer,
    'Số chứng từ: ' + item.invoice, 'Ngày: ' + item.date, 'Tiền tệ: ' + item.currency,
    ...item.lines.flatMap((line, index) => ['Dòng ' + (index + 1) + ': ' + line.description,
      ...(line.sku ? ['Mã hàng: ' + line.sku] : []), 'Số lượng: ' + line.quantity + '; Đơn giá: ' + line.price + '; VAT (phân số): ' + line.rate,
      'Thành tiền chưa thuế: ' + line.subtotal + '; Thuế: ' + line.tax + '; Tổng dòng: ' + line.total]),
    'Cộng chưa thuế: ' + item.subtotal, 'Tổng VAT: ' + item.tax, 'Tổng thanh toán: ' + item.total];
}
function gold(item) {
  const values = { '/purchase_order_id': item.po, '/seller_tax_code': item.seller, '/buyer_tax_code': item.buyer,
    '/invoice_number': item.invoice, '/invoice_date': item.date, '/currency': item.currency, '/subtotal': item.subtotal, '/tax_amount': item.tax, '/total_amount': item.total };
  item.lines.forEach((line, index) => { for (const [key, value] of Object.entries({ description: line.description, sku: line.sku, quantity: line.quantity,
    unit_price: line.price, tax_rate: line.rate, line_subtotal: line.subtotal, tax_amount: line.tax, line_total: line.total })) {
    values['/lines/' + index + '/' + key] = value ?? null;
  } }); return values;
}
async function pdf(file, textLines, image) {
  const document = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'Fictional OCR fixture', CreationDate: date, ModDate: date } });
  const output = fs.createWriteStream(file); const done = new Promise((resolve, reject) => { output.once('finish', resolve); output.once('error', reject); document.once('error', reject); });
  document.pipe(output);
  if (image) document.image(image, 0, 0, { width: 595.28, height: 841.89 });
  else document.font(font).fontSize(11).text(textLines.join('\n'), { lineGap: 7 });
  document.end(); await done;
}
async function main() {
  fs.mkdirSync(path.join(destination, 'sources'), { recursive: true }); fs.mkdirSync(path.join(destination, 'labels'), { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1556 }, deviceScaleFactor: 1 });
  const embedded = fs.readFileSync(font).toString('base64');
  const manifest = { version: 'vn-reviewed-v1', synthetic: true, license: 'MIT', sources: 'Team-authored fictional fixtures; PDFKit and Chromium rendering, Noto Sans OFL; no production data.',
    renderer: { playwright: require('@playwright/test/package.json').version, browser: browser.version(), channel: process.env.PLAYWRIGHT_CHANNEL || 'pinned-chromium' }, cases: [] };
  try {
    for (const item of cases) {
      const text = lines(item), extension = item.kind.endsWith('pdf') ? 'pdf' : item.kind === 'png' ? 'png' : 'jpg';
      const file = path.join(destination, 'sources', item.id + '.' + extension);
      if (item.kind === 'text-pdf') await pdf(file, text);
      else {
        const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        await page.setContent('<style>@font-face{font-family:Noto;src:url(data:font/ttf;base64,' + embedded + ')}*{box-sizing:border-box}body{font-family:Noto;background:white;margin:0;padding:70px;color:#111;font-size:22px;line-height:1.8}p{margin:8px 0;border-bottom:1px solid #ddd}</style>' +
          text.map(value => '<p>' + escape(value) + '</p>').join(''));
        await page.evaluate(() => document.fonts.ready);
        const image = await page.screenshot({ type: item.kind === 'jpeg' ? 'jpeg' : 'png', ...(item.kind === 'jpeg' ? { quality: 80 } : {}), fullPage: false });
        if (item.kind === 'scanned-pdf') await pdf(file, undefined, image); else fs.writeFileSync(file, image);
      }
      const bytes = fs.readFileSync(file), values = gold(item);
      fs.writeFileSync(path.join(destination, 'labels', item.id + '.json'), JSON.stringify({ values }, null, 2) + '\n');
      manifest.cases.push({ id: item.id, split: item.split, kind: item.kind, source: 'sources/' + item.id + '.' + extension,
        label: 'labels/' + item.id + '.json', sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length,
        media_type: extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png' : 'image/jpeg' });
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Created 4 fictional Vietnamese documents: 2 dev / 2 held-out; digital PDF, image-only scanned PDF, PNG, JPEG.');
}
main().catch(error => { console.error('Fixture generation failed: ' + error.message.slice(0, 500)); process.exitCode = 1; });
