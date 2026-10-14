# Quy trình triển khai PR4

Issue → branch → commit → draft PR → review thực → CI đúng SHA → merge theo quyền maintainer → kiểm acceptance → Done. Main/develop giữ review gate; không tự merge/phê duyệt thay người khác hoặc sửa protection/quyền. Không quota issue/commit, không lịch sử giả.

## Owner và reviewer

| Role | Owner | Phạm vi | Reviewer đề xuất |
| --- | --- | --- | --- |
| A | hieunofun | Core/backend, tenant/workflow/policy/decision/replay/ops; tích hợp shared files | B contracts/tests/recovery; C docs/UX |
| B | huybitvvt (Huyday) | AI/OCR/data/evidence/connectors/onboarding backend/system tests | A authZ/data/tool execution; C review UX |
| C | lehoangnam206 (Lê Hoàng Nam) | Frontend tiếng Việt/docs/demo/release | A hoặc B logic/security |

Người viết không làm reviewer của chính mình. Agent hiện dùng tài khoản hieunofun được người dùng cho phép; việc tạo tài liệu cho P4-01 owner C không phải evidence C đã thực hiện code hoặc review. Security/ledger cần reviewer hiểu proof/tenant/security.

Shared files (`AppModule`, lockfile/CI/Compose/contracts/migration registry) integration owner A; thay đổi hẹp qua PR, migration lấy số từ develop lúc merge. Một người tối đa một implementation đang làm + một PR chờ review.

## Naming và linkage

Branch từ develop mới nhất, số GitHub thật: `feat/<number>-<slug>`, `docs/...`, `chore/...`, `fix/...`. `P4-xx` là mã kế hoạch. Nhánh `feature/...` PR3 được giữ nguyên. Conventional commits mô tả diff thực, body `Refs #<number>`. Draft nền tảng dùng `Refs` để không tự đóng issue chỉ vì có docs; dùng Closes chỉ khi acceptance đầy đủ và closure phù hợp review.

P4-01/P4-02 được đóng gói cùng một draft PR để review governance trước contract; branch snapshot `chore/36-baseline-governance` ghi governance, branch `feat/37-platform-contracts` chứa governance+contract. Cùng gốc develop@32d8594, không tạo 36 implementation branches.

## Trạng thái

| Label | Điều kiện |
| --- | --- |
| Needs specification | Chưa chốt provider/source/rules/lifecycle/operation semantics chi tiết |
| Blocked | Chờ dependency hoặc PR contract merge; lý do ghi trong issue |
| Ready | Contract đủ, dependency đã merge/đạt gate, owner hiểu acceptance |
| In progress | Có implementation thực đang làm |
| In review | PR mở, chờ review/CI; chưa Done |
| Done | Merged + acceptance + docs/evidence đầy đủ |

Estimate = ngày công 6 giờ; kế hoạch 75.5 ngày + 25% dự phòng ≈94.4 ngày cho nhóm, cần hiệu chuẩn sau 5 ngày thực tế. Milestone M0..M6 theo tài liệu; NEXT giữ #27/#28; không xem deadline BTC là đã xác nhận.

## Definition of Done

- Acceptance quan sát được qua runtime/config thật cho feature; fixtures/mock chỉ phục vụ contract/UI development.
- Dependency integrated; review thật bởi người khác; build/lint/test phù hợp và CI URL/SHA.
- Không regression PR3, cross-tenant/IDOR, sai decimal, double allocation, tự duyệt hoặc mất lịch sử.
- Failure/timeout/retry/ambiguous outcome/recovery được thử; backend keys và ACL không xuống frontend.
- Docs/API/changelog/migration/runbooks đồng bộ; dependency exact version/upstream/license/notices và contribution rõ.
- Không đóng issue vì screenshot, docs-only hoặc CI không chạy phần được công bố.

## Nguồn mở và tích hợp

Kế thừa Keycloak, APISIX, PostgreSQL, MinIO, Flowable; không nhận phần upstream là code nhóm. `OPEN_SOURCE_COMPONENTS.md` ghi source/version/license/role và `OUR_CONTRIBUTIONS.md` ghi phần tự viết. Ledger BUSL xử lý riêng #22; API AI là dependency dịch vụ được công khai, provider/model chưa chọn ở nền tảng. Không thêm runtime package/framework khi chưa cần.

Sau review+merge contract: A `feat/22-ledger-license` rồi `feat/40-headless-core`; B `feat/38-ai-provider-contract`; C `feat/39-vietnamese-shell`. Fetch develop lại, tạo branch đúng HEAD lúc đó, cập nhật issue gate. Hiện các branch này chưa được tạo.
