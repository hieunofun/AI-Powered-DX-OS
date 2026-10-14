# Project 3 code baseline

Kiểm tra ngày 14/10/2026 (Asia/Saigon): repository canonical [hieunofun/AI-Powered-DX-OS](https://github.com/hieunofun/AI-Powered-DX-OS), default `develop`, HEAD `32d8594102e649d8f3dc2196325c6827911bbd82`. `main` là `aa7916be486a66ca9a2ec41e1db3748a89d27b77` (snapshot khởi tạo). Baseline commit tồn tại và là ancestor (hiện trùng HEAD develop).

Annotated tag [project3-baseline-2026-10-14](https://github.com/hieunofun/AI-Powered-DX-OS/tree/project3-baseline-2026-10-14) đã tạo/push trên đúng baseline. Đây là mốc lưu code, không phải release đủ điều kiện dự thi. Trước tạo không có tag/release, không có PR mở. Không reset develop về lịch sử nếu HEAD tiến lên.

Workspace ban đầu sạch, nhánh develop local `42dd7a3`, remote tên cũ `SmartProcure-Pay`; không đổi remote/branch của workspace đó. Fetch URL canonical vào `refs/remotes/pr4/*`, dùng worktree riêng từ develop mới nhất. Không có AGENTS.md trong ancestor workspace hoặc tree develop; đã đọc CONTRIBUTING.md, README, CI và domain/security/license docs.

[CI baseline #37820304419](https://github.com/hieunofun/AI-Powered-DX-OS/actions/runs/37820304419) `success` trên SHA baseline: đã kiểm tra steps build/lint/unit/E2E/Compose, PostgreSQL/Keycloak/APISIX/MinIO/matching/Flowable/audit/quantity reservations/browser. Đây là bằng chứng CI lịch sử của PR3, không phải bằng chứng đã chạy lại runtime PR4.

## Hiện trạng code đã đọc

| Code PR3 | Quan sát | Đích PR4 |
| --- | --- | --- |
| `apps/api/src/auth/auth.service.ts` / principal interface | Verify issuer/audience/JWKS; realm roles; chưa tenant | Tenant/principal/action/resource grants |
| `apps/api/src/invoices/invoices.service.ts` | XML deterministic; PDF archive trả OCR_REQUIRED; structured OCR result bị từ chối | Generic evidence intake + reviewed domain draft |
| `apps/api/src/storage/minio-storage.service.ts` | Private bucket, checksum, key không tenant | Tenant-scoped storage port và quarantine |
| `apps/api/src/workflow/workflow.service.ts` | Flowable durable operation, uncertain outcome recovery, invoice roles | Generic runtime port; invoice rules ở pack |
| `goods-receipts/domain/fulfillment-calculator.ts` | Decimal; received = accepted + rejected khi finalize | BRS counted/QC/held/billable migration |
| matching/workflow repositories và `QUANTITY_RESERVATIONS.md` | Effective reservations + PO lock | Giữ atomic capacity khi tách pack |
| audit/native verifier + license docs | Proof/export/trust state; BUSL gate còn mở | Generic audit port; lựa chọn ledger ở #22 |

## Mapping lịch sử

| Issue PR3 mở | P4 | Xử lý |
| --- | --- | --- |
| #22 | P4-05 | Ledger licensing/migration; giữ thảo luận và evidence cũ |
| #25 | P4-16 | Dated scope update cho disclosed AI API; giữ review/evaluation/deterministic fallback |
| #26 | P4-10 | Dated scope update cho API AI; persistence/correction/confirm và image contract |
| #29 | P4-35 | Demo PR4 với real API fixture/replay/reuse |
| #30 | P4-36 | Reproducible reviewed contest release |
| #27 | P4-37, NEXT | Giữ XML trust mở, chưa branch |
| #28 | P4-38, NEXT | Giữ tax source mở, chưa branch |

Issue PR3 đã đóng (#1..10/#21/#23/#24/#34) là evidence kế thừa; không mở lại hoặc nhận như PR4 đã hoàn thành. P4-39..42 chưa tạo trong đợt dự thi.

## Tài liệu nguồn

Đã đọc đủ Master Blueprint v1.0 (919 paragraphs) và kế hoạch 42 work items. Backlog chỉ khởi tạo P4-01..36 theo yêu cầu hiện tại. Lệnh mẫu, handoff prompts và hướng dẫn 'chưa thao tác' trong tài liệu là nội dung lịch sử; yêu cầu trực tiếp của người dùng cho phép thao tác lần này và chốt tag ngày 14/10.

- `OpenDX_PR4_Ke_hoach_Issue_Branch.md` — SHA-256 `ade56d33f6905122e41f2884a9e7f1cc77e640c18cfcf1162f3384f3aab14c39`.
- `OpenDX_Fabric_Project4_Master_Blueprint_2026.docx` — SHA-256 `33f594b96060da84bac267304a2fab74fd4a6822c83402648a48f1484c7f926c`.

File nguồn được giữ tại máy của nhóm; không công bố nguyên bản Word trong PR. Dates milestone là mục tiêu kế hoạch, chưa xác nhận thông báo BTC mới nhất. AI API được cho phép theo thông tin nhóm cung cấp; không suy diễn license ledger đã được BTC chấp nhận.
