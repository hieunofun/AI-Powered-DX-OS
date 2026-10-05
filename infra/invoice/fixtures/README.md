# Invoice XML fixture provenance

`valid-vn-einvoice.xml` and its existing variants are synthetic **SmartProcureInvoice v1** project fixtures. Their Vietnamese tag names do not establish TCT or provider compatibility.

`valid-vietnam-provider-einvoice.xml` is an independently authored, sanitized fixture for the **Matbao-invoice/MIFI published PBan 2.0.0 ordinary VAT invoice layout**. It contains fictional test names, addresses, tax-code placeholders, invoice number, goods and amounts; no company/person data, QR payload, certificate or signature from an actual invoice is redistributed.

References verified on 2026-10-05:

- Matbao-invoice, [Cấu trúc hóa đơn theo ND 123](https://matbao.in/articles/cau-truc-hoa-don-theo-nd-123), published 2022-03-17, ordinary-invoice example. Confirms the HDon/DLHDon envelope, PBan 2.0.0, header, parties, goods, discounts, grouped VAT and totals. The derived fixture preserves this tag layout, not the sample's business values.
- Matbao-invoice's [published Decision 1510 field tables](https://matbao.in/articles/quyet-dinh-so-1510-qd-tct-bo-sung-quyet-dinh-1450-2020), VAT-invoice section. Cross-checks buyer MST, repeated HHDVu/LTSuat, grouped TThue and optional DSCKS signature containers. The [linked tax-authority PDF](https://matbao.in/wp-content/uploads/2022/12/quyet-dinh-1510-qd-tct-tong-cuc-thue.pdf) is a reference, not a bundled artifact.

Only public format facts/documentation were referenced. No external implementation code, article prose, complete provider sample or PDF was copied. The provider page does not grant an OSS license; none is invented. Adapter code and synthetic test data were authored in this MIT-licensed project. This attribution does not claim legal certification, current regulatory compliance or universal provider compatibility.

The adapter supports a deliberately bounded subset: unnamespaced PBan 2.0.0, ordinary VAT goods/service lines, VND, required seller/buyer tax codes, zero discounts and the existing exact-decimal/half-up rules. Four/six-place monetary padding is accepted only when all digits beyond cents are zero; nonzero excess precision is rejected without rounding. Line tax/total are derived because this layout declares tax at VAT-group/header level; every group is reconciled. Other versions, adjustments, exempt/special VAT, foreign exchange, allowances, fees, custom fields and alternative rounding need explicit adapters/rules. Signature containers, when present, are archived and never used to authenticate the invoice or select business data. See the [module documentation](../../../docs/business/INVOICE_INGESTION_MODULE.md) for mappings and limitations.
