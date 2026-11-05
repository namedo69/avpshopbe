# Sản phẩm Mở rương nhóm

## 1. Migration

Chạy migration `src/db/turso_migrations/0002_group_chest.sql` trên database.
Migration tạo:

- `worker_agents`
- `group_chest_jobs`
- `group_chest_job_items`
- sản phẩm mặc định `mo-ruong-nhom`

## 2. FE

Trang khách hàng:

```text
/group-chest
```

Mỗi dòng nhập có dạng:

```text
taikhoan | matkhau  (hoặc taikhoan:matkhau)
```

Tài khoản và mật khẩu được mã hóa gửi lên backend, lưu vào `group_chest_job_items` và dispatch tới Tool PC/Worker qua WebSocket `/worker`.

## 3. PC Tool / Worker

Tool PC GUI (`AutoRuongThanLongBachVe_Khach`):
- Kết nối tới backend qua WebSocket namespace `/worker` với `WORKER_SOCKET_TOKEN`.
- Nhận event `job:dispatch` chứa danh sách tài khoản cần mở rương.
- Tự động chạy và stream kết quả rương (`job:group-result`, `job:progress`, `job:completed`) về Web theo thời gian thực.
- Khách hàng trên Web theo dõi tiến độ chi tiết từng tài khoản trong đơn tại `/orders/:orderCode`.

Ngoài ra, có thể chạy headless agent:

```powershell
cd F:\avpshopbe\pc-agent
npm install
copy .env.example .env
npm run dev
```

Agent mặc định chạy:

```text
AGENT_MODE=dry_run
```

Chế độ này kiểm tra queue và trạng thái đơn mà không thực hiện thao tác ngoài.

## Adapter tầng dưới

Luồng nhận job đã tách khỏi logic xử lý bằng `JobExecutor`. Có thể cấu hình
adapter local được cấp quyền:

```env
AGENT_MODE=command
AUTHORIZED_ADAPTER_COMMAND=node path/to/authorized-adapter.mjs
ADAPTER_TIMEOUT_MS=120000
```

Adapter nhận một JSON request qua stdin và trả một JSON result qua stdout.
Mỗi request được gửi động từ job web; không cần import file combo tĩnh. Adapter
chịu trách nhiệm tự lấy credential từ vault bằng `credentialRef`.

## 4. Luồng xử lý

```text
FE tạo order
  -> orders + order_items
  -> group_chest_jobs + group_chest_job_items
  -> outbox_jobs
  -> backend worker
  -> Socket.IO /worker job:dispatch
  -> PC agent job:group-result
  -> group_chest_job_items
  -> group_chest_jobs
  -> Socket.IO /client order:progress
```

## 5. Chạy adapter thật

Chỉ nối adapter thực thi khi có API chính thức hoặc môi trường test được ủy
quyền. Adapter phải nhận `credentialRef`, tự lấy credential ngắn hạn từ vault,
không log credential, và trả về một kết quả chuẩn hóa cho agent.
