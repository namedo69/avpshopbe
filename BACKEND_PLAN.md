# Kế hoạch Backend — CSUC Shop

> Phiên bản: MVP 1.0  
> Cập nhật: 18/10/2026  
> Ưu tiên triển khai: Render.com  
> Thanh toán: SePay Webhook + VietQR
> Database cập nhật theo yêu cầu: Turso Cloud (libSQL)

## 1. Mục tiêu

Backend cung cấp API cho khách hàng và admin với phạm vi:

- Khách đăng ký, đăng nhập và quản lý phiên đăng nhập.
- Khách xem gói CSUC, nạp tiền, áp voucher và đặt đơn.
- Admin quản lý sản phẩm, voucher, đơn hàng và xem thống kê.
- Đơn được gửi tự động sang PMOD hoặc nhà cung cấp tương ứng.
- Mọi thay đổi số dư có sổ giao dịch và có thể đối soát.
- Hệ thống triển khai ổn định trên Render, không phụ thuộc filesystem cục bộ.

## 2. Công nghệ đề xuất

| Thành phần | Lựa chọn |
|---|---|
| Runtime | Node.js LTS, khóa phiên bản bằng `.node-version` |
| Ngôn ngữ | TypeScript strict mode |
| HTTP | Express |
| Validation | Zod |
| Database | Turso Cloud (libSQL/SQLite) |
| ORM/migration | Drizzle ORM + Drizzle Kit |
| Authentication | Access token ngắn hạn + refresh token trong HttpOnly cookie |
| Password | Argon2id hoặc bcrypt với cost phù hợp |
| Queue MVP | Transactional outbox lưu trong Turso |
| Worker | Render Background Worker khi chạy production |
| Test | Vitest/Supertest + database test riêng |
| Log | Structured JSON log, gắn `requestId` |

Production dùng Turso Cloud từ xa, không dùng SQLite file hoặc lưu ảnh trực tiếp vào ổ đĩa của Web Service. Filesystem của instance không phải nơi lưu dữ liệu nghiệp vụ lâu dài; ảnh sản phẩm dùng object storage/CDN và database chỉ lưu URL.

## 3. Kiến trúc triển khai

```text
Browser
   │
   ├── HTTPS ──> Render Static Site (Frontend)
   │
   └── HTTPS ──> Render Web Service (API)
                      │
                      ├── Turso Cloud (libSQL)
                      ├── SePay webhook/API
                      └── Outbox jobs
                              │
                              └── Render Background Worker
                                      └── PMOD / nhà cung cấp khác
```

Môi trường nên có `staging` và `production` riêng. Không dùng chung database, SePay secret hoặc khóa nhà cung cấp giữa hai môi trường.

## 4. Cấu trúc source

```text
backend/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/
│   ├── db/
│   │   ├── schema/
│   │   ├── turso_migrations/
│   │   └── index.ts
│   ├── middleware/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── products/
│   │   ├── vouchers/
│   │   ├── wallet/
│   │   ├── deposits/
│   │   ├── orders/
│   │   ├── providers/
│   │   └── reports/
│   ├── jobs/
│   ├── lib/
│   └── types/
├── tests/
├── drizzle.config.ts
├── package.json
├── render.yaml
└── .node-version
```

Route chỉ nhận request, gọi service và trả response. Quy tắc tiền, voucher, đơn hàng và provider nằm trong service; truy vấn database nằm trong repository hoặc module tương ứng.

## 5. Mô hình dữ liệu

### 5.1. Tài khoản

`users`

- `id`
- `email` unique
- `password_hash`
- `name`
- `role`: `customer | admin`
- `status`: `active | blocked`
- `created_at`, `updated_at`

`refresh_sessions`

- Lưu hash refresh token, không lưu token thô.
- Có `expires_at`, `revoked_at`, IP và user agent.

### 5.2. Product/gói CSUC

`categories`

- `id`, `name`, `slug`, `description`, `is_active`, `sort_order`

`products`

- `id`, `category_id`
- `name`, `slug`, `description`, `image_url`
- `price_amount`: `INTEGER` 64 bit, đơn vị VNĐ
- `sale_price_amount`: nullable
- `input_schema`: JSON lưu dạng text mô tả trường khách phải nhập
- `min_quantity`, `max_quantity`
- `is_active`, `sort_order`
- `created_at`, `updated_at`

`provider_products`

- `product_id`, `provider_id`
- `external_service_id`
- `cost_amount`
- `provider_payload_template`: JSON lưu dạng text
- `priority`, `is_active`

Giá bán luôn được đọc lại từ backend khi checkout. Frontend không được quyền quyết định giá.

### 5.3. Ví và sổ giao dịch

`wallets`

- `user_id` unique
- `balance_amount INTEGER NOT NULL DEFAULT 0` (64 bit)
- `version` dùng cho optimistic locking nếu cần

`wallet_transactions`

- `id`, `user_id`
- `type`: `deposit | purchase | refund | adjustment`
- `amount`: số dương khi cộng, số âm khi trừ
- `balance_before`, `balance_after`
- `reference_type`, `reference_id`
- `status`: `pending | completed | failed`
- `description`, `metadata`, `created_at`

Tiền lưu bằng số nguyên VNĐ. Không dùng `float`, `real` hoặc phép toán tiền trên frontend.

### 5.4. Nạp tiền

`deposits`

- `id`, `user_id`
- `amount INTEGER` (64 bit)
- `payment_code` unique, ví dụ `NAP8F3K2M7Q`
- `bank_account_id`
- `status`: `pending | completed | expired | failed`
- `sepay_transaction_id` nullable unique
- `expires_at`, `completed_at`, `created_at`

`payment_webhook_events`

- `provider`: `sepay`
- `event_id`: ID giao dịch do SePay gửi
- `payload`: JSON lưu dạng text
- `status`: `received | processed | ignored | failed`
- `deposit_id`, `error_message`, `created_at`, `processed_at`
- Unique index `(provider, event_id)`

`bank_accounts`

- Thông tin tài khoản nhận tiền, trạng thái hoạt động và dữ liệu cần tạo VietQR.
- Secret xác thực không trả về frontend và ưu tiên lưu trong Render Secret/Environment.

### 5.5. Voucher

`vouchers`

- `code` unique, chuẩn hóa uppercase
- `type`: `percent | fixed`
- `value_amount` hoặc `value_percent`
- `max_discount_amount`, `min_order_amount`
- `total_usage_limit`, `per_user_limit`, `used_count`
- `starts_at`, `ends_at`, `is_active`

`voucher_products` để giới hạn gói áp dụng.

`voucher_usages`

- `voucher_id`, `user_id`, `order_id`, `discount_amount`, `created_at`
- Dùng để kiểm tra giới hạn từng khách và phục vụ đối soát.

### 5.6. Đơn hàng

`orders`

- `id`, `order_code` unique, `user_id`
- `status`
- `subtotal_amount`, `discount_amount`, `total_amount`
- `voucher_id`, `customer_note`
- `provider_status`, `completed_at`, `created_at`, `updated_at`

`order_items`

- Snapshot `product_id`, `product_name`, `unit_price`, `quantity`, `total_amount`
- `customer_input`: JSON lưu dạng text

`order_status_logs`

- `order_id`, `from_status`, `to_status`
- `actor_type`: `customer | admin | system | provider`
- `actor_id`, `reason`, `metadata`, `created_at`

State machine đề xuất:

```text
queued → sending → processing → completed
   │         │           │
   └─────────┴───────────> failed
                │
                └────────> refunded
```

`cancelled` chỉ được dùng trước khi đơn đã được nhà cung cấp tiếp nhận. Không cho admin nhập tùy ý một chuỗi trạng thái.

### 5.7. Nhà cung cấp và jobs

`providers`

- `code`, `name`, `base_url`, `is_active`
- Credential lấy từ environment; database chỉ lưu tên khóa cấu hình nếu cần.

`provider_orders`

- `order_id`, `provider_id`
- `external_order_id`, `idempotency_key`
- `status`, `request_payload`, `response_payload`
- `attempt_count`, `next_retry_at`, `last_error`
- Unique index theo `idempotency_key` và theo cặp provider/external order ID.

`outbox_jobs`

- `type`, `aggregate_id`, `payload`
- `status`: `pending | processing | completed | failed | dead`
- `attempts`, `available_at`, `locked_at`, `locked_by`, `last_error`

`audit_logs`

- Ghi thao tác quan trọng của admin: sửa product, voucher, số dư và trạng thái đơn.

## 6. API dự kiến

Prefix: `/api/v1`

### Auth và tài khoản

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /me`

### Khách hàng

- `GET /products`
- `GET /products/:slug`
- `GET /wallet`
- `GET /wallet/transactions`
- `POST /deposits`
- `GET /deposits`
- `GET /deposits/:paymentCode`
- `POST /vouchers/validate`
- `POST /orders`
- `GET /orders`
- `GET /orders/:orderCode`

### Webhook

- `POST /webhooks/sepay`
- `POST /webhooks/providers/:providerCode` nếu provider hỗ trợ callback

### Admin

- CRUD `/admin/products`
- CRUD `/admin/vouchers`
- `GET /admin/orders`
- `GET /admin/orders/:id`
- `PATCH /admin/orders/:id/status`
- `POST /admin/orders/:id/retry`
- `POST /admin/orders/:id/refund`
- `GET /admin/deposits`
- `POST /admin/deposits/:id/approve`
- `GET /admin/reports/orders`
- `GET /admin/reports/cashflow`

Response lỗi dùng một cấu trúc thống nhất:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Số dư không đủ",
    "requestId": "req_...",
    "fields": {}
  }
}
```

## 7. Luồng nạp tiền SePay

### 7.1. Tạo yêu cầu nạp

1. Khách gửi số tiền nguyên VNĐ.
2. Backend kiểm tra min/max và rate limit.
3. Sinh `payment_code` ngẫu nhiên, không dựa riêng vào timestamp hoặc user ID.
4. Tạo deposit `pending` và thời hạn thanh toán.
5. Trả thông tin tài khoản, nội dung chuyển khoản và URL/payload VietQR.
6. Frontend hiển thị QR và polling trạng thái.

### 7.2. Cấu hình SePay

- URL production: `https://<api-domain>/api/v1/webhooks/sepay`.
- Chỉ nhận sự kiện tiền vào.
- Lọc theo tiền tố mã thanh toán, ví dụ `NAP`.
- Bật bỏ qua giao dịch không có mã nếu phù hợp vận hành.
- Dùng `application/json`.
- Ưu tiên HMAC-SHA256; API Key chỉ là phương án đơn giản hơn.
- Bật retry và cảnh báo webhook lỗi.
- Test bằng SePay Test Mode trước, sau đó thử một giao dịch thật giá trị nhỏ.

### 7.3. Xử lý webhook

1. Đọc payload và xác thực chữ ký/Authorization trước khi xử lý nghiệp vụ.
2. Kiểm tra `transferType === "in"`, số tiền nguyên dương và tài khoản nhận hợp lệ.
3. Dùng SePay `id` làm khóa chống trùng ở database.
4. Tìm deposit bằng `code` hoặc payment code được trích từ `content`.
5. Kiểm tra đúng số tiền, đúng tài khoản và trạng thái cho phép.
6. Trong một database transaction:
   - Claim deposit bằng update có điều kiện.
   - Ghi webhook event.
   - Khóa/cập nhật wallet.
   - Thêm `wallet_transaction`.
7. Webhook trùng phải trả thành công nhưng không cộng tiền lại.
8. Phản hồi `200` hoặc `201` với đúng JSON `{"success":true}` trong giới hạn thời gian của SePay.

Không gửi Telegram, email hoặc gọi PMOD bên trong transaction webhook. Các việc phụ được ghi vào outbox để xử lý sau.

### 7.4. Đối soát

- Job định kỳ tìm webhook lỗi, deposit pending lâu và giao dịch không khớp.
- Trang admin cho phép xem payload đã che dữ liệu nhạy cảm.
- Duyệt thủ công phải dùng cùng service cộng tiền và cùng transaction như webhook.
- Không xóa deposit đã hoàn thành hoặc webhook event đã ghi nhận.

## 8. Luồng đặt đơn và gửi PMOD

### 8.1. Checkout

Trong một database transaction:

1. Validate input và gộp các item trùng.
2. Đọc lại product/provider mapping đang hoạt động.
3. Tính subtotal và voucher ở backend.
4. Kiểm tra hạn mức voucher và số dư.
5. Tạo `order`, `order_items`, `voucher_usage`.
6. Trừ ví bằng update có điều kiện `balance >= total`.
7. Ghi `wallet_transaction`.
8. Ghi `order_status_log` và outbox job `SEND_PROVIDER_ORDER`.

API trả đơn ở trạng thái `queued`; không chờ PMOD phản hồi mới trả kết quả checkout.

### 8.2. Provider adapter

```ts
interface ProviderAdapter {
  createOrder(input: CreateProviderOrderInput): Promise<CreateProviderOrderResult>;
  getOrderStatus(externalOrderId: string): Promise<ProviderOrderStatus>;
  cancelOrder?(externalOrderId: string): Promise<void>;
  verifyWebhook?(request: ProviderWebhookRequest): Promise<boolean>;
}
```

Triển khai `PmodProvider` riêng. Tuyệt đối không rải logic PMOD trực tiếp trong order controller.

### 8.3. Retry

- Timeout từng request provider.
- Retry exponential backoff có jitter.
- Dùng cùng `idempotency_key` cho mọi lần retry.
- Lỗi `4xx` nghiệp vụ chuyển sang `failed`, không retry vô hạn.
- Lỗi mạng/`5xx` retry tới giới hạn rồi chuyển `dead` và cảnh báo admin.
- Worker claim job bằng write transaction và update có điều kiện để nhiều instance không gửi trùng.
- Có polling trạng thái cho provider không hỗ trợ webhook.

### 8.4. Hoàn tiền

- Chỉ hoàn tiền qua một service riêng.
- Dùng unique reference `refund:order:<id>` để chống hoàn hai lần.
- Tạo ledger, cập nhật order và status log trong cùng transaction.
- Không tự hoàn khi trạng thái provider chưa rõ; đưa vào hàng chờ đối soát.

## 9. Bảo mật và vận hành

- CORS chỉ cho phép domain frontend đã cấu hình, không dùng wildcard với credentials.
- Cookie `HttpOnly`, `Secure`; cấu hình `SameSite` theo domain thực tế.
- Có CSRF protection cho request dựa vào cookie.
- Rate limit riêng cho auth, tạo deposit, checkout và webhook.
- Mask password, token, API key, cookie và dữ liệu khách trong log.
- Header bảo mật qua Helmet.
- Validate mọi body/query/params bằng Zod.
- Admin route bắt buộc cả authentication và role check.
- Mọi thao tác tiền đều có idempotency và audit trail.
- Backup database và kiểm tra quy trình restore định kỳ.

## 10. Deploy lên Render

### 10.1. Web Service

| Thiết lập | Giá trị đề xuất |
|---|---|
| Service type | Web Service |
| Runtime | Node |
| Root Directory | `backend` nếu dùng monorepo |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm run start` |
| Health Check Path | `/health/ready` |
| Auto Deploy | Bật cho branch production |

Server phải bind `0.0.0.0` và dùng `process.env.PORT`.

Endpoint sức khỏe:

- `/health/live`: process đang sống, không truy vấn dịch vụ ngoài.
- `/health/ready`: kiểm tra database nhanh và trả trong vài giây.

### 10.2. Database và migration

- Tạo Turso Cloud database riêng cho staging và production.
- Dùng `TURSO_DATABASE_URL` và `TURSO_AUTH_TOKEN` cho các service trên Render.
- Chạy migration bằng Pre-Deploy Command nếu gói dịch vụ hỗ trợ.
- Nếu chưa dùng Pre-Deploy Command, migration là một bước release thủ công có kiểm soát; không chạy migration phá hủy tự động trong startup.
- Migration phải tương thích ngược trước khi deploy code sử dụng schema mới.

### 10.3. Background Worker

- Command: `npm run worker`.
- Dùng chung codebase và database với API.
- Worker chỉ xử lý outbox/provider jobs, không mở HTTP port.
- Production nên dùng instance luôn hoạt động. Free Web Service có thể sleep khi không có traffic, không phù hợp cho cam kết xử lý job liên tục.

### 10.4. Environment variables

```dotenv
NODE_ENV=production
NODE_VERSION=<pinned-lts-version>
TURSO_DATABASE_URL=<libsql-url>
TURSO_AUTH_TOKEN=<secret>
APP_BASE_URL=https://api.example.com
FRONTEND_ORIGIN=https://app.example.com
JWT_ACCESS_SECRET=<secret>
JWT_REFRESH_SECRET=<secret>
COOKIE_SECRET=<secret>
SEPAY_WEBHOOK_AUTH_MODE=hmac
SEPAY_WEBHOOK_SECRET=<secret>
SEPAY_PAYMENT_PREFIX=NAP
SEPAY_BANK_ACCOUNT_NUMBER=<account>
SEPAY_BANK_CODE=<bank-code>
PMOD_BASE_URL=<provider-url>
PMOD_API_KEY=<secret>
LOG_LEVEL=info
```

Secret chỉ nhập trong Render Environment hoặc Environment Group, không commit `.env`.

### 10.5. `render.yaml`

Blueprint nên khai báo Web Service, Worker, health check, build/start command và biến môi trường kết nối Turso. Turso database được tạo ngoài Render. Giá trị secret đặt `sync: false` hoặc nhập qua Dashboard.

## 11. Kiểm thử bắt buộc

### Unit test

- Tính voucher fixed/percent và max discount.
- Tính tổng đơn.
- Mapping trạng thái PMOD.
- Parse mã thanh toán SePay.

### Integration test

- Hai checkout đồng thời không làm số dư âm.
- Hai webhook cùng SePay ID chỉ cộng tiền một lần.
- Hai request refund chỉ hoàn một lần.
- Voucher không vượt giới hạn tổng hoặc giới hạn mỗi user.
- Retry provider không tạo đơn PMOD trùng.
- Admin không thể chuyển trạng thái trái state machine.

### E2E staging

- Đăng ký → đăng nhập → tạo deposit → webhook sandbox → tăng số dư.
- Chọn gói → áp voucher → đặt đơn → worker gửi provider → cập nhật hoàn thành.
- Provider lỗi → retry → dead job → admin xử lý.

## 12. Lộ trình thực hiện

### Sprint 1 — Foundation, auth, deploy skeleton

- Khởi tạo backend, Turso Cloud, migration và error format.
- Auth, role, health check, logging.
- Render staging Web Service + database.

### Sprint 2 — Product và admin product

- Schema category/product/provider mapping.
- API public product và CRUD admin.
- Audit log cơ bản.

### Sprint 3 — Wallet và SePay

- Wallet ledger, deposit, VietQR.
- Webhook idempotent, xác thực và lịch sử nạp.
- SePay Test Mode và đối soát admin.

### Sprint 4 — Voucher và checkout

- Voucher rules/usages.
- Checkout transaction, order items và status logs.
- Danh sách/chi tiết đơn khách hàng.

### Sprint 5 — PMOD và worker

- Provider adapter, outbox worker, retry.
- Webhook/polling trạng thái provider.
- Admin retry/refund.

### Sprint 6 — Reports và production hardening

- Thống kê đơn và dòng tiền.
- Test concurrency, backup/restore, alert.
- Production Render + custom domain + SePay live webhook.

## 13. Điều kiện hoàn thành MVP

- Callback SePay lặp lại không thể cộng tiền hai lần.
- Checkout đồng thời không thể làm số dư âm.
- Đơn PMOD có idempotency, retry và lịch sử request.
- Admin thấy được toàn bộ vòng đời đơn nhưng không được sửa trạng thái tùy ý.
- Doanh thu và dòng tiền lấy từ ledger, không suy ra từ số dư hiện tại.
- Deploy mới vượt health check trước khi nhận traffic.
- Không có secret trong repository, frontend bundle hoặc log.

## 14. Tài liệu tham chiếu

- Render Web Services: https://render.com/docs/web-services
- Render Node/Express: https://render.com/docs/deploy-node-express-app
- Render environment variables: https://render.com/docs/configure-environment-variables
- Render deploys: https://render.com/docs/deploys
- SePay Developer: https://developer.sepay.vn/vi
- SePay tạo webhook: https://developer.sepay.vn/vi/sepay-webhooks/tao-webhook
- SePay tích hợp webhook: https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook


