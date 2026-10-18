import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sqlClient } from './db/sql.js';

const workerId = randomUUID();
async function tick() {
  // PMOD's request/response contract is not supplied. Keep queued orders durable
  // until an adapter with confirmed idempotency semantics is configured.
  await sqlClient.query("UPDATE deposits SET status='expired' WHERE status='pending' AND expires_at<(unixepoch()*1000)");
  await sqlClient.query("UPDATE outbox_jobs SET status='pending',locked_at=NULL,locked_by=NULL WHERE status='processing' AND locked_at<(unixepoch()*1000)-300000");
}
async function main() {
  process.stdout.write(JSON.stringify({ level: 'info', workerId, message: 'worker started; provider adapter pending configuration' }) + '\n');
  while (true) {
    try { await tick(); } catch (error) { process.stderr.write(JSON.stringify({ level: 'error', workerId, message: String(error) }) + '\n'); }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}
void main();
