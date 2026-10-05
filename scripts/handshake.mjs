// Pipe initialize + tools/list + one tools/call into the server and print the raw exchange.
// Usage: node scripts/handshake.mjs            (uses env HERDR_TRANSPORT/HERDR_HOST)
import { connect } from './mcp-client.mjs';
const c = await connect(process.env, { log: true });
await c.request('tools/list');
await c.call('herdr_snapshot');
await c.close();
