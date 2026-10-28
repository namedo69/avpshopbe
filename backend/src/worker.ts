import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sqlClient } from './db/sql.js';
import { chungSucClient, extractEventCode } from './modules/chungsuc-adapter.js';

const workerId = randomUUID();

/**
 * Xử lý job gửi đơn sang đối tác ChungSuc
 */
async function processSendProviderOrder(jobId: string, orderId: string) {
  // 1. Kiểm tra trạng thái đơn hàng và lấy cấu hình số request của sản phẩm
  const orderRes = await sqlClient.query(`
    SELECT o.*, oi.customer_input, oi.quantity, p.name as product_name, p.input_schema
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE o.id = $1
    LIMIT 1
  `, [orderId]);
  const order = orderRes.rows[0];

  if (!order) {
    await sqlClient.query("UPDATE outbox_jobs SET status='completed', locked_at=NULL WHERE id=$1", [jobId]);
    return;
  }

  // 2. Kiểm tra xem provider 'chungsuc' có đang BẬT không
  const provRes = await sqlClient.query("SELECT * FROM providers WHERE code='chungsuc' AND is_active=true LIMIT 1");
  const provider = provRes.rows[0];

  if (!provider) {
    // Nếu provider đang TẮT, hoàn thành job mà không đẩy đơn (đơn giữ ở trạng thái queued cho admin xử lý tay)
    await sqlClient.query("UPDATE outbox_jobs SET status='completed', locked_at=NULL, last_error='ChungSuc provider is inactive' WHERE id=$1", [jobId]);
    return;
  }

  if (!chungSucClient.isConfigured()) {
    await sqlClient.query("UPDATE outbox_jobs SET status='failed', locked_at=NULL, last_error='ChungSuc API key missing' WHERE id=$1", [jobId]);
    return;
  }

  // 3. Trích xuất mã code và số lượng
  const input = order.customer_input || {};
  const rawCode = input.accountId || input.code || input.eventCode || '';
  const cleanCode = extractEventCode(rawCode);

  if (!cleanCode) {
    await sqlClient.query("UPDATE outbox_jobs SET status='failed', locked_at=NULL, last_error='No valid code found' WHERE id=$1", [jobId]);
    return;
  }

  // Lấy hệ số request cấu hình trong gói sản phẩm (mặc định = 1)
  let requestsPerItem = 1;
  const pSchema = order.input_schema;
  if (pSchema && typeof pSchema === 'object') {
    if (typeof pSchema.requestsPerItem === 'number' && pSchema.requestsPerItem > 0) {
      requestsPerItem = Math.floor(pSchema.requestsPerItem);
    } else if (typeof pSchema.providerQuantity === 'number' && pSchema.providerQuantity > 0) {
      requestsPerItem = Math.floor(pSchema.providerQuantity);
    }
  }

  // Tổng request gửi ChungSuc = Số lượng khách đặt * Số request cấu hình của gói (mặc định 1)
  const itemQty = Math.max(1, Number(order.quantity) || 1);
  const quantity = Math.max(1, itemQty * requestsPerItem);
  const idempotencyKey = `cs_${order.order_code || order.id}`;

  try {
    const csResponse = await chungSucClient.createHomeOrder({
      codes: [cleanCode],
      quantity,
      customerLabel: order.order_code,
      idempotencyKey,
    });

    const firstOrder = csResponse.orders?.[0];
    const externalOrderId = firstOrder ? String(firstOrder.id) : null;

    // Lưu thông tin đơn đối tác vào provider_orders
    await sqlClient.query(`
      INSERT INTO provider_orders(order_id, provider_id, external_order_id, idempotency_key, status, request_payload, response_payload)
      VALUES($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
      ON CONFLICT (idempotency_key) DO UPDATE
      SET external_order_id = EXCLUDED.external_order_id,
          status = EXCLUDED.status,
          response_payload = EXCLUDED.response_payload
    `, [
      order.id,
      provider.id,
      externalOrderId,
      idempotencyKey,
      'processing',
      JSON.stringify({ codes: [cleanCode], quantity, customerLabel: order.order_code }),
      JSON.stringify(csResponse),
    ]);

    // Cập nhật trạng thái đơn hàng sang 'processing'
    await sqlClient.query("UPDATE orders SET status='processing', updated_at=NOW() WHERE id=$1 AND status='queued'", [order.id]);
    await sqlClient.query("INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'queued', 'processing', 'system', 'ChungSuc accepted order')", [order.id]);

    await sqlClient.query("UPDATE outbox_jobs SET status='completed', locked_at=NULL WHERE id=$1", [jobId]);
  } catch (err: any) {
    const errorMsg = err.message || String(err);
    await sqlClient.query(
      "UPDATE outbox_jobs SET status='pending', attempts=attempts+1, locked_at=NULL, locked_by=NULL, last_error=$2 WHERE id=$1",
      [jobId, errorMsg]
    );
  }
}

/**
 * Thăm dò và đồng bộ tiến độ các đơn hàng đang xử lý
 */
async function syncProcessingOrders() {
  if (!chungSucClient.isConfigured()) return;

  const activeOrdersRes = await sqlClient.query(`
    SELECT po.id as po_id, po.external_order_id, o.id as order_id, o.order_code
    FROM provider_orders po
    JOIN orders o ON o.id = po.order_id
    JOIN providers p ON p.id = po.provider_id
    WHERE p.code = 'chungsuc'
      AND o.status IN ('queued', 'sending', 'processing')
      AND po.external_order_id IS NOT NULL
    LIMIT 20
  `);

  for (const row of activeOrdersRes.rows) {
    try {
      const live = await chungSucClient.getOrder(row.external_order_id);
      let mappedStatus = 'processing';
      if (live.status === 'completed') mappedStatus = 'completed';
      else if (live.status === 'cancelled') mappedStatus = 'cancelled';
      else if (live.status === 'needs_review') mappedStatus = 'processing';

      await sqlClient.query(`
        UPDATE provider_orders
        SET status = $1, response_payload = $2::jsonb
        WHERE id = $3
      `, [mappedStatus, JSON.stringify(live), row.po_id]);

      if (mappedStatus === 'completed') {
        await sqlClient.query("UPDATE orders SET status='completed', updated_at=NOW(), completed_at=NOW() WHERE id=$1", [row.order_id]);
        await sqlClient.query("INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'processing', 'completed', 'system', 'ChungSuc completed tickets')", [row.order_id]);
      } else if (mappedStatus === 'cancelled') {
        await sqlClient.query("UPDATE orders SET status='cancelled', updated_at=NOW() WHERE id=$1", [row.order_id]);
        await sqlClient.query("INSERT INTO order_status_logs(order_id, from_status, to_status, actor_type, reason) VALUES($1, 'processing', 'cancelled', 'system', 'ChungSuc cancelled order')", [row.order_id]);
      }
    } catch {
      // Bỏ qua lỗi tạm thời khi thăm dò
    }
  }
}

async function tick() {
  // 1. Quét nạp tiền hết hạn
  await sqlClient.query("UPDATE deposits SET status='expired' WHERE status='pending' AND expires_at < NOW()");

  // 2. Mở khóa các outbox job bị treo
  await sqlClient.query("UPDATE outbox_jobs SET status='pending', locked_at=NULL, locked_by=NULL WHERE status='processing' AND locked_at < NOW() - INTERVAL '5 minutes'");

  // 3. Khóa và lấy các job gửi đơn nhà cung cấp đang chờ
  const pendingJobsRes = await sqlClient.query(`
    UPDATE outbox_jobs
    SET status = 'processing', locked_at = NOW(), locked_by = $1
    WHERE id IN (
      SELECT id FROM outbox_jobs
      WHERE status = 'pending' AND type = 'SEND_PROVIDER_ORDER' AND available_at <= NOW() AND attempts < 5
      ORDER BY created_at ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, aggregate_id
  `, [workerId]);

  for (const job of pendingJobsRes.rows) {
    await processSendProviderOrder(job.id, job.aggregate_id);
  }

  // 4. Đồng bộ tiến độ các đơn hàng đang chạy
  await syncProcessingOrders();
}

async function main() {
  process.stdout.write(JSON.stringify({ level: 'info', workerId, message: 'worker started with ChungSuc integration enabled' }) + '\n');
  while (true) {
    try {
      await tick();
    } catch (error) {
      process.stderr.write(JSON.stringify({ level: 'error', workerId, message: String(error) }) + '\n');
    }
    await new Promise(resolve => setTimeout(resolve, 8_000));
  }
}

void main();
