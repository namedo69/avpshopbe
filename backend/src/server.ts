import 'dotenv/config';
import { createServer } from 'node:http';
import { app } from './app.js';
import { assertConfig } from './lib/core.js';
import { initSocketIO } from './modules/ws.js';

assertConfig();
const port = Number(process.env.PORT ?? 3000);

// Create HTTP server so Socket.io can attach to the same port
const httpServer = createServer(app);

// Initialize Socket.io namespaces (/worker and /client)
initSocketIO(httpServer);

httpServer.listen(port, '0.0.0.0', () => {
  process.stdout.write(JSON.stringify({ level: 'info', message: 'listening (HTTP + WebSocket)', port }) + '\n');
  // Chạy background worker song song trong container backend
  import('./worker.js').catch(err => {
    process.stderr.write(JSON.stringify({ level: 'error', message: 'Failed to start background worker: ' + String(err) }) + '\n');
  });
});
