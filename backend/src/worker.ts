import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sqlClient } from './db/sql.js';

const workerId = randomUUID();
async function tick() {
  await sqlClient.query("UPDATE deposits SET status='expired' WHERE status='pending' AND expires_at < NOW()");
  await sqlClient.query("UPDATE outbox_jobs SET status='pending',locked_at=NULL,locked_by=NULL WHERE status='processing' AND locked_at < NOW() - INTERVAL '5 minutes'");
}
async function main() {
  process.stdout.write(JSON.stringify({ level: 'info', workerId, message: 'worker started; provider adapter pending configuration' }) + '\n');
  while (true) {
    try { await tick(); } catch (error) { process.stderr.write(JSON.stringify({ level: 'error', workerId, message: String(error) }) + '\n'); }
    await new Promise(resolve => setTimeout(resolve, 10_000));
  }
}
void main();
