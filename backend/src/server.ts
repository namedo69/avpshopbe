import 'dotenv/config';
import { app } from './app.js';
import { assertConfig } from './lib/core.js';

assertConfig();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ level: 'info', message: 'listening', port }) + '\n');
  // Chạy background worker song song trong container backend
  import('./worker.js').catch(err => {
    process.stderr.write(JSON.stringify({ level: 'error', message: 'Failed to start background worker: ' + String(err) }) + '\n');
  });
});
