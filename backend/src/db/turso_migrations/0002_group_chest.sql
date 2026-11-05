CREATE TABLE IF NOT EXISTS worker_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_code text NOT NULL UNIQUE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'offline',
  last_seen_at timestamptz,
  capabilities jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_chest_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id),
  product_id uuid NOT NULL REFERENCES products(id),
  item_count integer NOT NULL,
  completed_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued',
  result_summary jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_chest_job_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES group_chest_jobs(id),
  external_account_id text NOT NULL,
  credential_ref text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  result jsonb NOT NULL DEFAULT '{}',
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS group_chest_job_items_job_idx ON group_chest_job_items(job_id, created_at);

INSERT INTO products (
  id, name, slug, description, price_amount, sale_price_amount,
  input_schema, min_quantity, max_quantity, is_active, sort_order
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Mở rương nhóm',
  'mo-ruong-nhom',
  'Sản phẩm xử lý danh sách tài khoản qua PC agent được cấp quyền.',
  0, 0,
  '{"productType":"group_chest_open","required":["accounts"],"maxAccounts":100}',
  1, 100, true, 900
)
ON CONFLICT (slug) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  input_schema=EXCLUDED.input_schema,
  min_quantity=EXCLUDED.min_quantity,
  max_quantity=EXCLUDED.max_quantity,
  is_active=true,
  sort_order=EXCLUDED.sort_order,
  updated_at=NOW();
