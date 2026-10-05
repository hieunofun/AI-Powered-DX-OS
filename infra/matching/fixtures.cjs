// Synthetic PostgreSQL setup only. Actual matching always runs through APISIX.
const { randomUUID } = require('node:crypto');
const Decimal = require('decimal.js');
const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
module.exports = function fixtures(db, supplierId, taxCode, runId) {
  async function po({ count = 1, ordered = '100', price = '100', tax = '0.1000',
    receipts = [{ status: 'RECEIVED', accepted: '100', rejected: '0' }], duplicateSku = false } = {}) {
    const accepted = receipts.filter(r => r.status === 'RECEIVED').reduce((sum, r) => sum.plus(r.accepted), new D(0));
    const status = accepted.isZero() ? 'ISSUED' : accepted.gte(ordered) ? 'FULLY_RECEIVED' : 'PARTIALLY_RECEIVED';
    const subtotal = new D(ordered).times(price).toDecimalPlaces(2).times(count);
    const taxAmount = new D(ordered).times(price).toDecimalPlaces(2).times(tax).toDecimalPlaces(2).times(count);
    const id = (await db.query(`INSERT INTO purchase_orders(po_number,supplier_id,currency,status,order_date,subtotal,tax_amount,total_amount)
      VALUES($1,$2,'VND',$3,CURRENT_DATE,$4,$5,$6) RETURNING id`,
    ['MATCH-' + runId.slice(0, 8) + '-' + randomUUID().slice(0, 8), supplierId, status, subtotal.toFixed(2), taxAmount.toFixed(2),
      subtotal.plus(taxAmount).toFixed(2)])).rows[0].id;
    const data = Array.from({ length: count }, (_, index) => ({ n: index + 1,
      sku: duplicateSku ? 'SKU-1' : 'SKU-' + (index + 1), description: 'Matching goods ' + (index + 1) }));
    const items = (await db.query(`INSERT INTO purchase_order_items(purchase_order_id,line_number,sku,description,
      ordered_quantity,unit_price,tax_rate,line_subtotal,tax_amount,line_total)
      SELECT $1,r.n,r.sku,r.description,$3,$4,$5,round($3::numeric*$4::numeric,2),
        round(round($3::numeric*$4::numeric,2)*$5::numeric,2),
        round($3::numeric*$4::numeric,2)+round(round($3::numeric*$4::numeric,2)*$5::numeric,2)
      FROM jsonb_to_recordset($2::jsonb) r(n int,sku text,description text)
      RETURNING id,line_number AS "lineNumber",sku,description`, [id, JSON.stringify(data), ordered, price, tax])).rows;
    items.sort((a, b) => a.lineNumber - b.lineNumber);
    for (const receipt of receipts) {
      const grn = (await db.query(`INSERT INTO goods_receipts(grn_number,purchase_order_id,status,cancelled_at,cancelled_reason)
        VALUES($1,$2,$3,CASE WHEN $3='CANCELLED' THEN now() END,CASE WHEN $3='CANCELLED' THEN 'Synthetic cancelled receipt' END)
        RETURNING id`, ['MATCH-GRN-' + randomUUID(), id, receipt.status])).rows[0].id;
      const gross = D.max(1, new D(receipt.accepted).plus(receipt.rejected)).toFixed(4);
      await db.query(`INSERT INTO goods_receipt_items(goods_receipt_id,purchase_order_item_id,line_number,
        received_quantity,accepted_quantity,rejected_quantity)
        SELECT $1,r.id,r."lineNumber",$3,$4,$5 FROM jsonb_to_recordset($2::jsonb) r(id uuid,"lineNumber" int)`,
      [grn, JSON.stringify(items), gross, receipt.accepted, receipt.rejected]);
    }
    return { id, items, price, tax };
  }
  async function invoice(order, { quantity = '100', price = order.price, tax = order.tax, lines,
    headerDelta = '0', supplier = supplierId, sellerTaxCode = taxCode, currency = 'VND', status = 'PARSED' } = {}) {
    const data = (lines ?? order.items.map(item => ({ item, quantity, price, tax }))).map((row, index) => {
      const item = row.item ?? order.items[0];
      const q = row.quantity ?? quantity, p = row.price ?? price, t = row.tax ?? tax;
      const subtotal = new D(q).times(p).toDecimalPlaces(2), taxAmount = subtotal.times(t).toDecimalPlaces(2);
      return { n: index + 1, sku: row.sku === undefined ? item.sku : row.sku, description: row.description ?? item.description,
        poItemId: row.poItemId ?? null, quantity: q, unitPrice: p, taxRate: t,
        lineSubtotal: subtotal.toFixed(2), taxAmount: taxAmount.toFixed(2), lineTotal: subtotal.plus(taxAmount).toFixed(2) };
    });
    const subtotal = data.reduce((sum, row) => sum.plus(row.lineSubtotal), new D(0));
    const taxAmount = data.reduce((sum, row) => sum.plus(row.taxAmount), new D(0));
    const total = subtotal.plus(taxAmount).plus(headerDelta);
    const id = (await db.query(`INSERT INTO invoices(invoice_number,supplier_id,purchase_order_id,invoice_date,
      currency,status,subtotal,tax_amount,total_amount,seller_tax_code,source_type)
      VALUES($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,$9,'MATCHING_TEST_FIXTURE') RETURNING id`,
    ['MATCH-INV-' + randomUUID(), supplier, order.id, currency, status, subtotal.toFixed(2), taxAmount.toFixed(2),
      total.toFixed(2), sellerTaxCode])).rows[0].id;
    await db.query(`INSERT INTO invoice_items(invoice_id,line_number,po_item_id,sku,description,quantity,unit_price,
      tax_rate,line_subtotal,tax_amount,line_total)
      SELECT $1,r.n,r."poItemId",r.sku,r.description,r.quantity,r."unitPrice",r."taxRate",r."lineSubtotal",r."taxAmount",r."lineTotal"
      FROM jsonb_to_recordset($2::jsonb) r(n int,"poItemId" uuid,sku text,description text,quantity numeric,
        "unitPrice" numeric,"taxRate" numeric,"lineSubtotal" numeric,"taxAmount" numeric,"lineTotal" numeric)`, [id, JSON.stringify(data)]);
    return id;
  }
  return { po, invoice };
};
