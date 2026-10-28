export interface ChungSucMeResponse {
  user: {
    id: number;
    email: string;
    site_id: number;
    balance: number;
  };
  permissions: {
    home: boolean;
  };
  prices: {
    home_per_request: number;
  };
  tickets_per_request: number;
  limits: {
    max_codes: number;
    max_quantity_per_code: number | null;
    max_total_quantity: number | null;
    max_code_length: number;
    max_customer_label_length: number;
    max_per_page: number;
  };
  purchases_open: boolean;
}

export interface ChungSucOrderResponseItem {
  id: number;
  order_ref: string;
  code: string;
  customer_label?: string;
  so_luong: number;
  tong_tien: number;
  status: 'queued' | 'processing' | 'completed' | 'cancelled' | 'needs_review' | string;
  completed_requests: number;
  remaining_requests: number;
  tickets_per_request: number;
  tickets_target: number;
  tickets_confirmed: number;
  refunded: number;
  created_at: string;
}

export interface ChungSucCreateOrderResponse {
  duplicate: boolean;
  orders: ChungSucOrderResponseItem[];
  total_quantity: number;
  total_price: number;
}

export interface ChungSucGetOrderResponse {
  order: ChungSucOrderResponseItem;
}

/**
 * Hàm lọc và chuẩn hóa mã sự kiện từ chuỗi nhập vào của người dùng.
 * Hỗ trợ các định dạng:
 * - Chuỗi game full: "Chung sức nhận quà: --A1b2C3d4E5-- ..."
 * - Mã có kèm gạch ngang: "--A1b2C3d4E5--"
 * - Mã trực tiếp: "A1b2C3d4E5"
 */
export function extractEventCode(rawInput: string | unknown): string {
  if (typeof rawInput !== 'string') return '';
  const text = rawInput.trim();
  if (!text) return '';

  // 1. Tìm chuỗi nằm giữa cặp dấu gạch ngang đôi: --MÃ--
  const doubleDashMatch = text.match(/--([A-Za-z0-9_\-]+)--/);
  if (doubleDashMatch && doubleDashMatch[1]) {
    return doubleDashMatch[1].trim();
  }

  // 2. Tìm pattern mã code thông thường (alphanumeric 6-35 ký tự)
  const codeMatch = text.match(/[A-Za-z0-9]{6,35}/);
  if (codeMatch && codeMatch[0]) {
    return codeMatch[0].trim();
  }

  return text;
}

export class ChungSucClient {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = (process.env.CHUNGSUC_BASE_URL || 'https://chungsuc.io.vn/api/member/v1').replace(/\/+$/, '');
    this.apiKey = (process.env.CHUNGSUC_API_KEY || '').replace(/^Bearer\s+/i, '');
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiKey.length > 10);
  }

  /**
   * Lấy thông tin tài khoản, số dư Xu và giá hiện tại
   */
  async getMe(): Promise<ChungSucMeResponse> {
    if (!this.isConfigured()) {
      throw new Error('ChungSuc API key is not configured');
    }

    const res = await fetch(`${this.baseUrl}/me`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`ChungSuc /me failed: ${res.status} ${errorText}`);
    }

    return await res.json() as ChungSucMeResponse;
  }

  /**
   * Tạo đơn Home sang ChungSuc
   */
  async createHomeOrder(params: {
    codes: string[];
    quantity: number;
    customerLabel?: string;
    idempotencyKey: string;
  }): Promise<ChungSucCreateOrderResponse> {
    if (!this.isConfigured()) {
      throw new Error('ChungSuc API key is not configured');
    }

    const payload = {
      codes: params.codes,
      quantity: params.quantity,
      customer_label: params.customerLabel ? params.customerLabel.slice(0, 80) : undefined,
    };

    const res = await fetch(`${this.baseUrl}/orders/home`, {
      method: 'POST',
      headers: {
        ...this.headers,
        'Idempotency-Key': params.idempotencyKey.slice(0, 100),
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await res.text();
    let data: any;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new Error(`ChungSuc response not JSON (${res.status}): ${bodyText.slice(0, 200)}`);
    }

    if (!res.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
      throw new Error(`ChungSuc create order failed: ${msg}`);
    }

    return data as ChungSucCreateOrderResponse;
  }

  /**
   * Lấy chi tiết và tiến độ đơn hàng theo ID số
   */
  async getOrder(orderId: number | string): Promise<ChungSucOrderResponseItem> {
    if (!this.isConfigured()) {
      throw new Error('ChungSuc API key is not configured');
    }

    const res = await fetch(`${this.baseUrl}/orders/${orderId}`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`ChungSuc /orders/${orderId} failed: ${res.status} ${errorText}`);
    }

    const data = await res.json() as ChungSucGetOrderResponse;
    return data.order;
  }
}

export const chungSucClient = new ChungSucClient();
