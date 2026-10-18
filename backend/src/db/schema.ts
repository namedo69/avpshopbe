import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

const uuidSql = sql`(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))))`;
const id = () => text('id').primaryKey().default(uuidSql);
const created = () => integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch()*1000)`);
const updated = () => integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch()*1000)`);
const money = (name: string) => integer(name).notNull();
const json = (name: string) => text(name, { mode: 'json' }).notNull().default(sql`'{}'`);

export const users = sqliteTable('users', {
  id: id(), email: text('email').notNull().unique(), passwordHash: text('password_hash').notNull(), name: text('name').notNull(),
  role: text('role').notNull().default('customer'), status: text('status').notNull().default('active'), createdAt: created(), updatedAt: updated(),
});
export const refreshSessions = sqliteTable('refresh_sessions', {
  id: id(), userId: text('user_id').notNull().references(() => users.id), tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(), revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  ip: text('ip'), userAgent: text('user_agent'), createdAt: created(),
});
export const categories = sqliteTable('categories', {
  id: id(), name: text('name').notNull(), slug: text('slug').notNull().unique(), description: text('description'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true), sortOrder: integer('sort_order').notNull().default(0),
});
export const products = sqliteTable('products', {
  id: id(), categoryId: text('category_id').references(() => categories.id), name: text('name').notNull(), slug: text('slug').notNull().unique(),
  description: text('description'), imageUrl: text('image_url'), priceAmount: money('price_amount'), salePriceAmount: integer('sale_price_amount'),
  inputSchema: json('input_schema'), minQuantity: integer('min_quantity').notNull().default(1), maxQuantity: integer('max_quantity').notNull().default(1),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true), sortOrder: integer('sort_order').notNull().default(0), createdAt: created(), updatedAt: updated(),
});
export const providers = sqliteTable('providers', {
  id: id(), code: text('code').notNull().unique(), name: text('name').notNull(), baseUrl: text('base_url').notNull(), isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
});
export const providerProducts = sqliteTable('provider_products', {
  id: id(), productId: text('product_id').notNull().references(() => products.id), providerId: text('provider_id').notNull().references(() => providers.id),
  externalServiceId: text('external_service_id').notNull(), costAmount: money('cost_amount'), providerPayloadTemplate: json('provider_payload_template'),
  priority: integer('priority').notNull().default(0), isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
}, t => [uniqueIndex('provider_product_unique').on(t.productId, t.providerId, t.externalServiceId)]);
export const wallets = sqliteTable('wallets', {
  userId: text('user_id').primaryKey().references(() => users.id), balanceAmount: money('balance_amount').default(0), version: integer('version').notNull().default(0),
});
export const walletTransactions = sqliteTable('wallet_transactions', {
  id: id(), userId: text('user_id').notNull().references(() => users.id), type: text('type').notNull(), amount: money('amount'),
  balanceBefore: money('balance_before'), balanceAfter: money('balance_after'), referenceType: text('reference_type').notNull(), referenceId: text('reference_id').notNull(),
  status: text('status').notNull().default('completed'), description: text('description'), metadata: json('metadata'), createdAt: created(),
}, t => [uniqueIndex('wallet_reference_unique').on(t.referenceType, t.referenceId), index('wallet_transactions_user_idx').on(t.userId, t.createdAt)]);
export const bankAccounts = sqliteTable('bank_accounts', {
  id: id(), bankCode: text('bank_code').notNull(), accountNumber: text('account_number').notNull().unique(), accountName: text('account_name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
});
export const deposits = sqliteTable('deposits', {
  id: id(), userId: text('user_id').notNull().references(() => users.id), amount: money('amount'), paymentCode: text('payment_code').notNull().unique(),
  bankAccountId: text('bank_account_id').notNull().references(() => bankAccounts.id), status: text('status').notNull().default('pending'),
  sepayTransactionId: text('sepay_transaction_id').unique(), expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }), createdAt: created(),
}, t => [index('deposits_user_idx').on(t.userId, t.createdAt)]);
export const paymentWebhookEvents = sqliteTable('payment_webhook_events', {
  id: id(), provider: text('provider').notNull(), eventId: text('event_id').notNull(), payload: json('payload'), status: text('status').notNull().default('received'),
  depositId: text('deposit_id').references(() => deposits.id), errorMessage: text('error_message'), createdAt: created(),
  processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
}, t => [uniqueIndex('payment_event_unique').on(t.provider, t.eventId)]);
export const vouchers = sqliteTable('vouchers', {
  id: id(), code: text('code').notNull().unique(), type: text('type').notNull(), valueAmount: integer('value_amount'), valuePercent: integer('value_percent'),
  maxDiscountAmount: integer('max_discount_amount'), minOrderAmount: money('min_order_amount').default(0), totalUsageLimit: integer('total_usage_limit'),
  perUserLimit: integer('per_user_limit'), usedCount: integer('used_count').notNull().default(0),
  startsAt: integer('starts_at', { mode: 'timestamp_ms' }), endsAt: integer('ends_at', { mode: 'timestamp_ms' }),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
});
export const voucherProducts = sqliteTable('voucher_products', {
  voucherId: text('voucher_id').notNull().references(() => vouchers.id), productId: text('product_id').notNull().references(() => products.id),
}, t => [uniqueIndex('voucher_product_unique').on(t.voucherId, t.productId)]);
export const orders = sqliteTable('orders', {
  id: id(), orderCode: text('order_code').notNull().unique(), userId: text('user_id').notNull().references(() => users.id),
  idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(), status: text('status').notNull().default('queued'),
  subtotalAmount: money('subtotal_amount'), discountAmount: money('discount_amount'), totalAmount: money('total_amount'),
  voucherId: text('voucher_id').references(() => vouchers.id), customerNote: text('customer_note'), providerStatus: text('provider_status'),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }), createdAt: created(), updatedAt: updated(),
}, t => [index('orders_user_idx').on(t.userId, t.createdAt), uniqueIndex('orders_user_idempotency_unique').on(t.userId, t.idempotencyKey)]);
export const orderItems = sqliteTable('order_items', {
  id: id(), orderId: text('order_id').notNull().references(() => orders.id), productId: text('product_id').notNull().references(() => products.id),
  productName: text('product_name').notNull(), unitPrice: money('unit_price'), quantity: integer('quantity').notNull(), totalAmount: money('total_amount'), customerInput: json('customer_input'),
});
export const voucherUsages = sqliteTable('voucher_usages', {
  id: id(), voucherId: text('voucher_id').notNull().references(() => vouchers.id), userId: text('user_id').notNull().references(() => users.id),
  orderId: text('order_id').notNull().unique().references(() => orders.id), discountAmount: money('discount_amount'), createdAt: created(),
});
export const orderStatusLogs = sqliteTable('order_status_logs', {
  id: id(), orderId: text('order_id').notNull().references(() => orders.id), fromStatus: text('from_status'), toStatus: text('to_status').notNull(),
  actorType: text('actor_type').notNull(), actorId: text('actor_id'), reason: text('reason'), metadata: json('metadata'), createdAt: created(),
});
export const providerOrders = sqliteTable('provider_orders', {
  id: id(), orderId: text('order_id').notNull().references(() => orders.id), providerId: text('provider_id').notNull().references(() => providers.id),
  externalOrderId: text('external_order_id'), idempotencyKey: text('idempotency_key').notNull().unique(), status: text('status').notNull(),
  requestPayload: text('request_payload', { mode: 'json' }), responsePayload: text('response_payload', { mode: 'json' }),
  attemptCount: integer('attempt_count').notNull().default(0), nextRetryAt: integer('next_retry_at', { mode: 'timestamp_ms' }), lastError: text('last_error'),
}, t => [uniqueIndex('provider_external_order_unique').on(t.providerId, t.externalOrderId)]);
export const outboxJobs = sqliteTable('outbox_jobs', {
  id: id(), type: text('type').notNull(), aggregateId: text('aggregate_id').notNull(), payload: json('payload'), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), availableAt: integer('available_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch()*1000)`),
  lockedAt: integer('locked_at', { mode: 'timestamp_ms' }), lockedBy: text('locked_by'), lastError: text('last_error'), createdAt: created(),
});
export const auditLogs = sqliteTable('audit_logs', {
  id: id(), actorId: text('actor_id').references(() => users.id), action: text('action').notNull(), targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(), metadata: json('metadata'), createdAt: created(),
});
