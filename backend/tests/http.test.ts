import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';

describe('HTTP basics', () => {
  it('answers liveness and formats unknown routes', async () => {
    const live = await request(app).get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ ok: true });
    const missing = await request(app).get('/missing');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect(missing.body.error.requestId).toBeTruthy();
  });
});
