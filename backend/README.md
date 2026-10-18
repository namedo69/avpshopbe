# langxang.shop backend

Express + TypeScript + Turso Cloud (libSQL) + Drizzle. Money is stored as integer VND. The API prefix is `/api/v1`.

## Local setup

1. Install Node 24.12.0 and create a Turso Cloud database.
2. Copy `.env.example` to `.env` and fill `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `JWT_ACCESS_SECRET`, `SEPAY_WEBHOOK_SECRET`, and the bank account fields. For local development, `TURSO_DATABASE_URL=file:local.db` works without a token.
3. Run `npm ci`, then `npm run db:migrate`.
4. Set `SETUP_ADMIN_EMAIL` and `SETUP_ADMIN_PASSWORD` (12+ characters), then run `npm run build && npm run setup` once. This creates an admin, wallet, bank account, and optional PMOD provider record. The command refuses to elevate an existing account.
5. Run `npm run dev`. The API uses `PORT` (default 3000).

`GET /health/live` checks the process. `GET /health/ready` checks Turso.

## Main flow

- Register or log in at `/auth/register` or `/auth/login`. Send the returned access token with `Authorization: Bearer ...`. Refresh token stays in an HttpOnly SameSite cookie.
- Admin creates products at `/admin/products`, then attaches a provider mapping at `/admin/products/:id/provider`.
- Customer creates a deposit at `/deposits`; transfer exactly the amount to the returned bank account using the `paymentCode` or scan `qrUrl`. SePay webhook endpoint is `/webhooks/sepay` and must use JSON and HMAC-SHA256.
- Customer checks out at `/orders` with `Idempotency-Key: <stable random key>` and `items: [{ productId, quantity, customerInput }]`. The order, wallet debit, voucher use, status log, and outbox job commit together.
- Admin can approve a deposit manually with a reason and can refund an order after marking it failed.

SePay webhook verification uses `X-SePay-Timestamp` and `X-SePay-Signature` over the original request bytes. Repeated SePay IDs are recognized by a unique database key. [SePay's webhook documentation](https://developer.sepay.vn/vi/sepay-webhooks/tich-hop-webhook) describes the payload and `{"success":true}` response. [SePay's authentication documentation](https://developer.sepay.vn/vi/sepay-webhooks/xac-thuc) describes the HMAC format. QR URLs follow [their VietQR example](https://developer.sepay.vn/vi/sepay-webhooks/tao-qr-va-form-thanh-toan).

## Provider integration status

The PMOD API contract was not included in the plan, and public search did not identify an authoritative PMOD API document. `SEND_PROVIDER_ORDER` jobs remain in the Turso outbox; the worker currently does not dispatch them. Confirm PMOD's endpoint, credentials, request/response fields, status codes, callback format, and idempotency behavior before enabling dispatch. This prevents duplicate external orders after network timeouts.

## Deploy

The repository root contains `render.yaml` for a Singapore API service and worker that connect to Turso Cloud. The API predeploy command runs Drizzle migrations. Set the Turso URL/token and other secrets in Render, then run the one-time setup command against the target environment. Use separate staging and production Turso databases/tokens. The current worker only keeps jobs durable until PMOD details are supplied; do not treat order fulfillment as live yet.

No live Render, SePay, or PMOD services are configured by this repository alone.

Run `npm test` for unit, HTTP, and libSQL money concurrency checks. Tests use a temporary libSQL file by default. To test against a separate Turso Cloud database, set `TEST_TURSO_DATABASE_URL` and `TEST_TURSO_AUTH_TOKEN`; the integration suite applies migrations and writes records there.
