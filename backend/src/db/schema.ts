import { sql } from 'drizzle-orm';
import { pgTable, text, integer, bigint, boolean, uniqueIndex, index, jsonb, uuid, timestamp } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const created = () => timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { mode: 'date', withTimezone: true }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: 'number' }).notNull();
const json = (name: string) => jsonb(name).notNull().default('{}');

export const userTiers = pgTable('user_tiers', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  discountPercent: integer('discount_percent').notNull().default(0),
  description: text('description'),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: created(),
  updatedAt: updated(),
});

export const users = pgTable('users', {
  id: id(), email: text('email').notNull().unique(), passwordHash: text('password_hash').notNull(), name: text('name').notNull(),
  role: text('role').notNull().default('customer'), tierId: text('tier_id').references(() => userTiers.id), status: text('status').notNull().default('active'), createdAt: created(), updatedAt: updated(),
});
export const refreshSessions = pgTable('refresh_sessions', {
  id: id(), userId: uuid('user_id').notNull().references(() => users.id), tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(), revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  ip: text('ip'), userAgent: text('user_agent'), createdAt: created(),
});
export const categories = pgTable('categories', {
  id: id(), name: text('name').notNull(), slug: text('slug').notNull().unique(), description: text('description'),
  isActive: boolean('is_active').notNull().default(true), sortOrder: integer('sort_order').notNull().default(0),
});
export const products = pgTable('products', {
  id: id(), categoryId: uuid('category_id').references(() => categories.id), name: text('name').notNull(), slug: text('slug').notNull().unique(),
  description: text('description'), imageUrl: text('image_url'), priceAmount: money('price_amount'), salePriceAmount: bigint('sale_price_amount', { mode: 'number' }),
  inputSchema: json('input_schema'), minQuantity: integer('min_quantity').notNull().default(1), maxQuantity: integer('max_quantity').notNull().default(1),
  isActive: boolean('is_active').notNull().default(true), sortOrder: integer('sort_order').notNull().default(0), createdAt: created(), updatedAt: updated(),
});
export const providers = pgTable('providers', {
  id: id(), code: text('code').notNull().unique(), name: text('name').notNull(), baseUrl: text('base_url').notNull(), isActive: boolean('is_active').notNull().default(true),
});
export const providerProducts = pgTable('provider_products', {
  id: id(), productId: uuid('product_id').notNull().references(() => products.id), providerId: uuid('provider_id').notNull().references(() => providers.id),
  externalServiceId: text('external_service_id').notNull(), costAmount: money('cost_amount'), providerPayloadTemplate: json('provider_payload_template'),
  priority: integer('priority').notNull().default(0), isActive: boolean('is_active').notNull().default(true),
}, t => [uniqueIndex('provider_product_unique').on(t.productId, t.providerId, t.externalServiceId)]);
export const wallets = pgTable('wallets', {
  userId: uuid('user_id').primaryKey().references(() => users.id), balanceAmount: money('balance_amount').default(0), version: integer('version').notNull().default(0),
});
export const walletTransactions = pgTable('wallet_transactions', {
  id: id(), userId: uuid('user_id').notNull().references(() => users.id), type: text('type').notNull(), amount: money('amount'),
  balanceBefore: money('balance_before'), balanceAfter: money('balance_after'), referenceType: text('reference_type').notNull(), referenceId: text('reference_id').notNull(),
  status: text('status').notNull().default('completed'), description: text('description'), metadata: json('metadata'), createdAt: created(),
}, t => [uniqueIndex('wallet_reference_unique').on(t.referenceType, t.referenceId), index('wallet_transactions_user_idx').on(t.userId, t.createdAt)]);
export const bankAccounts = pgTable('bank_accounts', {
  id: id(), bankCode: text('bank_code').notNull(), accountNumber: text('account_number').notNull().unique(), accountName: text('account_name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});
export const deposits = pgTable('deposits', {
  id: id(), userId: uuid('user_id').notNull().references(() => users.id), amount: money('amount'), paymentCode: text('payment_code').notNull().unique(),
  bankAccountId: uuid('bank_account_id').notNull().references(() => bankAccounts.id), status: text('status').notNull().default('pending'),
  sepayTransactionId: text('sepay_transaction_id').unique(), expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }), createdAt: created(),
}, t => [index('deposits_user_idx').on(t.userId, t.createdAt)]);
export const paymentWebhookEvents = pgTable('payment_webhook_events', {
  id: id(), provider: text('provider').notNull(), eventId: text('event_id').notNull(), payload: json('payload'), status: text('status').notNull().default('received'),
  depositId: uuid('deposit_id').references(() => deposits.id), errorMessage: text('error_message'), createdAt: created(),
  processedAt: timestamp('processed_at', { mode: 'date', withTimezone: true }),
}, t => [uniqueIndex('payment_event_unique').on(t.provider, t.eventId)]);
export const vouchers = pgTable('vouchers', {
  id: id(), code: text('code').notNull().unique(), type: text('type').notNull(), valueAmount: bigint('value_amount', { mode: 'number' }), valuePercent: integer('value_percent'),
  maxDiscountAmount: bigint('max_discount_amount', { mode: 'number' }), minOrderAmount: money('min_order_amount').default(0), totalUsageLimit: integer('total_usage_limit'),
  perUserLimit: integer('per_user_limit'), usedCount: integer('used_count').notNull().default(0),
  startsAt: timestamp('starts_at', { mode: 'date', withTimezone: true }), endsAt: timestamp('ends_at', { mode: 'date', withTimezone: true }),
  isActive: boolean('is_active').notNull().default(true),
});
export const voucherProducts = pgTable('voucher_products', {
  voucherId: uuid('voucher_id').notNull().references(() => vouchers.id), productId: uuid('product_id').notNull().references(() => products.id),
}, t => [uniqueIndex('voucher_product_unique').on(t.voucherId, t.productId)]);
export const orders = pgTable('orders', {
  id: id(), orderCode: text('order_code').notNull().unique(), userId: uuid('user_id').notNull().references(() => users.id),
  idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(), status: text('status').notNull().default('queued'),
  subtotalAmount: money('subtotal_amount'), discountAmount: money('discount_amount'), totalAmount: money('total_amount'),
  voucherId: uuid('voucher_id').references(() => vouchers.id), customerNote: text('customer_note'), providerStatus: text('provider_status'),
  completedAt: timestamp('completed_at', { mode: 'date', withTimezone: true }), createdAt: created(), updatedAt: updated(),
}, t => [index('orders_user_idx').on(t.userId, t.createdAt), uniqueIndex('orders_user_idempotency_unique').on(t.userId, t.idempotencyKey)]);
export const orderItems = pgTable('order_items', {
  id: id(), orderId: uuid('order_id').notNull().references(() => orders.id), productId: uuid('product_id').notNull().references(() => products.id),
  productName: text('product_name').notNull(), unitPrice: money('unit_price'), quantity: integer('quantity').notNull(), totalAmount: money('total_amount'), customerInput: json('customer_input'),
});
export const voucherUsages = pgTable('voucher_usages', {
  id: id(), voucherId: uuid('voucher_id').notNull().references(() => vouchers.id), userId: uuid('user_id').notNull().references(() => users.id),
  orderId: uuid('order_id').notNull().unique().references(() => orders.id), discountAmount: money('discount_amount'), createdAt: created(),
});
export const orderStatusLogs = pgTable('order_status_logs', {
  id: id(), orderId: uuid('order_id').notNull().references(() => orders.id), fromStatus: text('from_status'), toStatus: text('to_status').notNull(),
  actorType: text('actor_type').notNull(), actorId: text('actor_id'), reason: text('reason'), metadata: json('metadata'), createdAt: created(),
});
export const providerOrders = pgTable('provider_orders', {
  id: id(), orderId: uuid('order_id').notNull().references(() => orders.id), providerId: uuid('provider_id').notNull().references(() => providers.id),
  externalOrderId: text('external_order_id'), idempotencyKey: text('idempotency_key').notNull().unique(), status: text('status').notNull(),
  requestPayload: jsonb('request_payload'), responsePayload: jsonb('response_payload'),
  attemptCount: integer('attempt_count').notNull().default(0), nextRetryAt: timestamp('next_retry_at', { mode: 'date', withTimezone: true }), lastError: text('last_error'),
}, t => [uniqueIndex('provider_external_order_unique').on(t.providerId, t.externalOrderId)]);
export const outboxJobs = pgTable('outbox_jobs', {
  id: id(), type: text('type').notNull(), aggregateId: text('aggregate_id').notNull(), payload: json('payload'), status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0), availableAt: timestamp('available_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { mode: 'date', withTimezone: true }), lockedBy: text('locked_by'), lastError: text('last_error'), createdAt: created(),
});
export const tierProductPrices = pgTable('tier_product_prices', {
  id: id(),
  tierId: text('tier_id').notNull().references(() => userTiers.id),
  productId: uuid('product_id').notNull().references(() => products.id),
  customPriceAmount: money('custom_price_amount'),
  createdAt: created(),
  updatedAt: updated(),
}, t => [uniqueIndex('tier_product_unique').on(t.tierId, t.productId)]);

export const auditLogs = pgTable('audit_logs', {
  id: id(), actorId: uuid('actor_id').references(() => users.id), action: text('action').notNull(), targetType: text('target_type').notNull(),
  targetId: text('target_id').notNull(), metadata: json('metadata'), createdAt: created(),
});
