// Behaviour tests: the real server code spawns a fake `herdr` (test/bin/herdr) via HERDR_TRANSPORT=local.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, makeHerdr, makeTools, makeHandler, Ownership, ToolError, shQuote, buildInvocation } from '../server/herdr-mcp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(here, 'bin', 'herdr');
const SERVER = path.join(here, '..', 'server', 'herdr-mcp.mjs');

function baseState() {
  const tabs = [];
  const panes = [];
  for (let i = 1; i <= 7; i++) { tabs.push({ tab_id: `w8:t${i}`, workspace_id: 'w8', label: `T${i}`, number: i, pane_count: 1, agent_status: 'idle', focused: false }); }
  panes.push({ pane_id: 'w8:p1', tab_id: 'w8:t1', workspace_id: 'w8', agent: 'grok', agent_status: 'idle', terminal_title_stripped: 'PICKUP - grok', screen: 'hello' });
  panes.push({ pane_id: 'w8:p2', tab_id: 'w8:t2', workspace_id: 'w8', agent: 'claude', name: 'reviewer', agent_status: 'working', screen: 'thinking' });
  panes.push({ pane_id: 'w8:p3', tab_id: 'w8:t3', workspace_id: 'w8', agent: 'codex', agent_status: 'blocked', screen: 'Allow rm -rf? [y/n]' });
  panes.push({ pane_id: 'w8:p4', tab_id: 'w8:t4', workspace_id: 'w8', agent_status: 'unknown' });
  tabs.push({ tab_id: 'wD:t1', workspace_id: 'wD', label: 'Shell', number: 1, pane_count: 1, agent_status: 'unknown', focused: false });
  panes.push({ pane_id: 'wD:p1', tab_id: 'wD:t1', workspace_id: 'wD', agent_status: 'unknown' });
  return {
    workspaces: [
      { workspace_id: 'w8', label: 'micro1', number: 1, agent_status: 'idle', focused: true, worktree: { repo_name: 'micro1', checkout_path: '/Users/u/micro1' } },
      { workspace_id: 'wD', label: '7time', number: 2, agent_status: 'idle', focused: false },
    ],
    tabs, panes, worktrees: [],
  };
}

function setup(mut = (s) => s) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-plugin-test-'));
  const stateFile = path.join(dir, 'fake.json');
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(stateFile, JSON.stringify(mut(baseState())));
  fs.writeFileSync(log, '');
  const env = { ...process.env, HERDR_TRANSPORT: 'local', HERDR_BIN: STUB, FAKE_HERDR_STATE: stateFile, FAKE_HERDR_LOG: log, HERDR_PLUGIN_STATE: path.join(dir, 'owned.json') };
  // makeHerdr spawns HERDR_BIN with the parent's env, so expose the stub's env vars to the child.
  Object.assign(process.env, { FAKE_HERDR_STATE: stateFile, FAKE_HERDR_LOG: log });
  const cfg = loadConfig(env);
  const owned = new Ownership(cfg.stateFile, cfg.hostKey);
  const tools = makeTools({ herdr: makeHerdr(cfg), owned, cfg });
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { tools, owned, calls, env, dir };
}

async function rejects(p, code) {
  await assert.rejects(p, (e) => { assert.ok(e instanceof ToolError, `expected ToolError, got ${e}`); assert.equal(e.code, code); return true; });
}

test('agent kind is rejected as a name and nothing is sent', async () => {
  const { tools, calls } = setup();
  for (const kind of ['grok', 'claude', 'codex', 'pi']) {
    await rejects(tools.herdr_prompt_agent({ target: kind, text: 'do it' }), 'kind_not_name');
    await rejects(tools.herdr_read_agent({ target: kind }), 'kind_not_name');
  }
  await rejects(tools.herdr_start_agent({ name: 'claude', kind: 'claude', pane: 'wD:p1' }), 'kind_not_name');
  await rejects(tools.herdr_start_agent({ name: 'Bad Name', kind: 'claude', pane: 'wD:p1' }), 'invalid_agent_name');
  assert.equal(calls().length, 0, 'no herdr call was made');
});

test('prompt by name or pane id prepends /skill and returns the reply', async () => {
  const { tools, calls } = setup((s) => { s.panes[1].agent_status = 'idle'; return s; });
  const r = await tools.herdr_prompt_agent({ target: 'reviewer', text: 'look at the diff', skill: 'review' });
  assert.equal(r.sent, '/review look at the diff');
  assert.equal(r.reply_source, 'recent-unwrapped');
  const prompt = calls().find((c) => c[0] === 'agent' && c[1] === 'prompt');
  assert.deepEqual(prompt.slice(0, 5), ['agent', 'prompt', 'reviewer', '/review look at the diff', '--wait']);
  const r2 = await tools.herdr_prompt_agent({ target: 'w8:p1', text: 'hi' });
  assert.equal(r2.outcome, 'settled');
});

test('blocked/stalled prompt returns the screen, and an identical resend is refused', async () => {
  const { tools, calls } = setup((s) => { s.panes[0].stall = true; return s; });
  const blocked = await tools.herdr_prompt_agent({ target: 'w8:p3', text: 'continue' });
  assert.equal(blocked.outcome, 'blocked');
  assert.match(blocked.screen, /Allow rm -rf/);
  const stalled = await tools.herdr_prompt_agent({ target: 'w8:p1', text: 'go' });
  assert.equal(stalled.outcome, 'stalled');
  await rejects(tools.herdr_prompt_agent({ target: 'w8:p1', text: 'go' }), 'duplicate_prompt');
  const n = calls().filter((c) => c[1] === 'prompt').length;
  await tools.herdr_prompt_agent({ target: 'w8:p1', text: 'go', confirm_resend: true });
  assert.equal(calls().filter((c) => c[1] === 'prompt').length, n + 1);
  assert.ok(!calls().some((c) => c[1] === 'send-keys'), 'never answers dialogs');
});

test('read_agent picks visible while working and recent-unwrapped when idle', async () => {
  const { tools } = setup();
  assert.equal((await tools.herdr_read_agent({ target: 'reviewer' })).source, 'visible');
  assert.equal((await tools.herdr_read_agent({ target: 'w8:p1' })).source, 'recent-unwrapped');
});

test('8th tab is refused; same label returns the existing tab; creates use --no-focus', async () => {
  const { tools, calls } = setup();
  await rejects(tools.herdr_create_tab({ workspace: 'w8', label: 'Eighth' }), 'tab_limit_reached');
  assert.ok(!calls().some((c) => c[0] === 'tab' && c[1] === 'create'));
  const same = await tools.herdr_create_tab({ workspace: 'w8', label: 'T3' });
  assert.equal(same.created, false);
  assert.equal(same.tab.id, 'w8:t3');
  const made = await tools.herdr_create_tab({ workspace: 'wD', label: 'builder' });
  assert.equal(made.created, true);
  const again = await tools.herdr_create_tab({ workspace: 'wD', label: 'builder' });
  assert.equal(again.created, false);
  assert.equal(again.tab.id, made.tab.id);
  assert.equal(calls().filter((c) => c[0] === 'tab' && c[1] === 'create').length, 1, 'created once');
  for (const c of calls().filter((c) => c[1] === 'create')) assert.ok(c.includes('--no-focus'));
});

test('workspace create is idempotent by label and by checkout path', async () => {
  const { tools, calls } = setup();
  assert.equal((await tools.herdr_create_workspace({ label: 'micro1' })).created, false);
  const byPath = await tools.herdr_create_workspace({ label: 'other', cwd: '/Users/u/micro1' });
  assert.equal(byPath.matched_by, 'checkout_path');
  const made = await tools.herdr_create_workspace({ label: 'tinkabot-test', cwd: '/tmp' });
  assert.equal(made.created, true);
  assert.equal((await tools.herdr_create_workspace({ label: 'tinkabot-test' })).workspace.id, made.workspace.id);
  assert.equal(calls().filter((c) => c[0] === 'workspace' && c[1] === 'create').length, 1);
});

test('run returns the real nonzero exit code and only the command output', async () => {
  const { tools } = setup();
  const f = await tools.herdr_run({ pane: 'wD:p1', command: 'false' });
  assert.equal(f.exit_code, 1);
  const e3 = await tools.herdr_run({ pane: 'wD:p1', command: "echo hello; echo 'it''s' ; sh -c 'exit 3'" });
  assert.equal(e3.exit_code, 3);
  assert.equal(e3.output, 'hello\nits');
  const ok = await tools.herdr_run({ pane: 'wD:p1', command: 'seq 1 500' });
  assert.equal(ok.exit_code, 0);
  assert.equal(ok.output_lines, 200);
  assert.equal(ok.truncated, true);
  assert.ok(ok.output.endsWith('500'));
});

test('run refuses agent panes and multi-line commands', async () => {
  const { tools, calls } = setup();
  await rejects(tools.herdr_run({ pane: 'w8:p1', command: 'ls' }), 'pane_hosts_agent');
  await rejects(tools.herdr_run({ pane: 'wD:p1', command: 'ls\nrm -rf /' }), 'invalid_argument');
  assert.ok(!calls().some((c) => c[1] === 'run'));
});

test('close refuses unowned ids and closes owned ones without --group', async () => {
  const { tools, calls, owned } = setup();
  await rejects(tools.herdr_close({ id: 'w8' }), 'not_owned');
  await rejects(tools.herdr_close({ id: 'w8:t1' }), 'not_owned');
  assert.ok(!calls().some((c) => c[1] === 'close'));
  const made = await tools.herdr_create_workspace({ label: 'tinkabot-test' });
  assert.deepEqual(owned.list().map((e) => e.id).sort(), [made.workspace.id, made.tab.id].sort());
  const r = await tools.herdr_close({ id: made.workspace.id });
  assert.equal(r.closed, true);
  assert.equal(owned.list().length, 0, 'workspace and its tabs dropped from the record');
  assert.ok(!calls().flat().includes('--group'));
});

test('herdr error JSON becomes a structured error with code and fix hint', async () => {
  const { tools } = setup((s) => { s.errors = { 'workspace close': { code: 'workspace_group_close_required', message: 'workspace has linked worktrees' } }; return s; });
  await assert.rejects(tools.herdr_read_agent({ target: 'ghost' }), (e) => {
    assert.equal(e.code, 'agent_not_found');
    assert.equal(e.herdr_code, 'agent_not_found');
    assert.match(e.hint, /never by kind/);
    return true;
  });
  const made = await tools.herdr_create_workspace({ label: 'tmp' });
  await assert.rejects(tools.herdr_close({ id: made.workspace.id }), (e) => {
    assert.equal(e.herdr_code, 'workspace_group_close_required');
    assert.match(e.hint, /--group is never used/);
    return true;
  });
  const handle = makeHandler(tools);
  const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'herdr_read_agent', arguments: { target: 'ghost' } } });
  assert.equal(res.result.isError, true);
  assert.equal(res.result.structuredContent.error.herdr_code, 'agent_not_found');
});

test('snapshot groups agents by state and flags unnamed agents', async () => {
  const { tools } = setup();
  const s = await tools.herdr_snapshot();
  assert.deepEqual(s.agents_by_state.waiting_for_input.map((a) => a.target), ['w8:p3']);
  assert.deepEqual(s.agents_by_state.working.map((a) => a.target), ['reviewer']);
  assert.deepEqual(s.agents_by_state.idle.map((a) => a.target), ['w8:p1']);
  assert.equal(s.workspaces[0].tabs.length, 7);
  assert.equal(s.workspaces[0].tabs[0].agents[0].kind, 'grok');
  assert.ok(s.warnings.some((w) => /no name/.test(w)));
});

test('ssh transport quotes every argv element for the remote shell', () => {
  const nasty = ["it's", 'a b', '$(touch /tmp/pwn)', '`id`', '"q"', ''];
  for (const s of nasty) assert.equal(execFileSync('sh', ['-c', `printf %s ${shQuote(s)}`], { encoding: 'utf8' }), s);
  const inv = buildInvocation(loadConfig({ HERDR_HOST: 'laptop' }), ['pane', 'run', 'w1:p1', "echo 'x'; false"]);
  assert.equal(inv.cmd, 'ssh');
  assert.deepEqual(inv.argv.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'laptop']);
  assert.match(inv.argv[5], /exec herdr pane run w1:p1 'echo '\\''x'\\''; false'$/);
});

test('MCP stdio handshake: initialize, tools/list, tools/call', async () => {
  const { env } = setup();
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  child.stdout.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'herdr_snapshot', arguments: {} } });
  child.stdin.end();
  await new Promise((r) => child.on('close', r));
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(byId[1].result.serverInfo.name, 'herdr');
  assert.equal(byId[2].result.tools.length, 11);
  assert.ok(!byId[2].result.tools.some((t) => JSON.stringify(t).includes('--group')));
  assert.equal(byId[3].result.isError, false);
  assert.equal(byId[3].result.structuredContent.workspaces.length, 2);
});
