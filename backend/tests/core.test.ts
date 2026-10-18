import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { calcDiscount, env, verifySepay } from '../src/lib/core.js';
import { paymentCode } from '../src/modules/deposits.js';
import { mapProviderStatus } from '../src/modules/provider-adapter.js';

describe('money and webhook helpers', () => {
  it('caps fixed and percent discounts', () => {
    expect(calcDiscount({ type: 'fixed', valueAmount: 200_000, valuePercent: null, maxDiscountAmount: null }, 100_000)).toBe(100_000);
    expect(calcDiscount({ type: 'percent', valueAmount: null, valuePercent: 50, maxDiscountAmount: 20_000 }, 100_000)).toBe(20_000);
  });
  it('extracts a deposit code from SePay content', () => {
    expect(paymentCode({ content: 'chuyen tien napabcdef0123456789' })).toBe('NAPABCDEF0123456789');
  });
  it('checks the signed raw payload and timestamp', () => {
    const original = env.sepaySecret;
    env.sepaySecret = 'test-secret-with-enough-length';
    try {
      const body = Buffer.from('{ "id": 42 }');
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = 'sha256=' + createHmac('sha256', env.sepaySecret).update(timestamp).update('.').update(body).digest('hex');
      expect(verifySepay(body, signature, timestamp)).toBe(true);
      expect(verifySepay(Buffer.from('{"id":42}'), signature, timestamp)).toBe(false);
      expect(verifySepay(body, signature, '1')).toBe(false);
    } finally { env.sepaySecret = original; }
  });
  it('does not guess unknown provider statuses', () => {
    expect(mapProviderStatus('Completed')).toBe('completed');
    expect(mapProviderStatus('surprise')).toBe('unknown');
  });
});
