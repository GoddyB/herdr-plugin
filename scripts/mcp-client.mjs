// Minimal MCP stdio client used by the demo/proof scripts. Spawns the server, speaks newline JSON-RPC.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'herdr-mcp.mjs');

export async function connect(env = process.env, { log = false } = {}) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map(); let buf = ''; let next = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (log) console.log('<-', line.length > 400 ? line.slice(0, 400) + ' …' : line);
      const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = next++; waiting.set(id, resolve);
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (log) console.log('->', msg);
    child.stdin.write(msg + '\n');
  });
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'herdr-plugin-script', version: '0.1.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = async (name, args = {}) => {
    const r = await request('tools/call', { name, arguments: args });
    return { isError: r.result?.isError, data: r.result?.structuredContent, raw: r };
  };
  return { init, request, call, close: () => { child.stdin.end(); return new Promise((r) => child.on('close', r)); } };
}
