export type ProviderStatus = 'processing' | 'completed' | 'failed' | 'unknown';

export interface CreateProviderOrderInput {
  idempotencyKey: string;
  externalServiceId: string;
  quantity: number;
  customerInput: Record<string, unknown>;
}

export interface CreateProviderOrderResult {
  externalOrderId: string;
  status: ProviderStatus;
  response: unknown;
}

export interface ProviderAdapter {
  createOrder(input: CreateProviderOrderInput): Promise<CreateProviderOrderResult>;
  getOrderStatus(externalOrderId: string): Promise<ProviderStatus>;
  cancelOrder?(externalOrderId: string): Promise<void>;
}

export function mapProviderStatus(value: string): ProviderStatus {
  switch (value.trim().toLowerCase()) {
    case 'completed': case 'complete': case 'success': return 'completed';
    case 'failed': case 'canceled': case 'cancelled': return 'failed';
    case 'pending': case 'processing': case 'in progress': return 'processing';
    default: return 'unknown';
  }
}
