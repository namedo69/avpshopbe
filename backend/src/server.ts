import 'dotenv/config';
import { app } from './app.js';
import { assertConfig } from './lib/core.js';

assertConfig();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, '0.0.0.0', () => process.stdout.write(JSON.stringify({ level: 'info', message: 'listening', port }) + '\n'));
