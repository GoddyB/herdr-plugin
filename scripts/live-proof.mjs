// Live proof against a real herdr. Touches ONLY a throwaway workspace labelled `tinkabot-test`
// that it creates itself, and closes only that workspace (by its own id, via herdr_close).
// Usage: HERDR_HOST=user@tailnet-ip node scripts/live-proof.mjs
import assert from 'node:assert/strict';
import { connect } from './mcp-client.mjs';

const LABEL = 'tinkabot-test';
const c = await connect();
const step = (s, o) => console.log(`\n## ${s}\n${JSON.stringify(o, null, 2)}`);

const snap = await c.call('herdr_snapshot');
assert.equal(snap.isError, false, JSON.stringify(snap.data));
const before = snap.data.workspaces.map((w) => `${w.id}:${w.label}:${w.tab_count}`);
step('snapshot (summary)', {
  host: snap.data.host,
  workspaces: snap.data.workspaces.map((w) => ({ id: w.id, label: w.label, tab_count: w.tab_count, tabs: w.tabs.map((t) => `${t.id} ${t.label} [${t.agents.map((a) => `${a.kind}:${a.status}`).join(',')}]`) })),
  agents_by_state: Object.fromEntries(Object.entries(snap.data.agents_by_state).map(([k, v]) => [k, v.map((a) => `${a.target}(${a.kind})`)])),
  warnings: snap.data.warnings,
});
assert.ok(!snap.data.workspaces.some((w) => w.label === LABEL), `a "${LABEL}" workspace already exists; refusing to reuse it`);

const refuse = await c.call('herdr_close', { id: snap.data.workspaces[0].id });
step('close of a workspace we did not create (must refuse)', refuse.data);
assert.equal(refuse.data.error.code, 'not_owned');

const kind = await c.call('herdr_prompt_agent', { target: 'grok', text: 'hi' });
step('prompt addressed by kind (must refuse, nothing sent)', kind.data);
assert.equal(kind.data.error.code, 'kind_not_name');

const ws = await c.call('herdr_create_workspace', { label: LABEL, cwd: '/tmp' });
step('create workspace', ws.data);
assert.equal(ws.data.created, true);
const W = ws.data.workspace.id;
try {
  const again = await c.call('herdr_create_workspace', { label: LABEL });
  step('create workspace again (idempotent)', { created: again.data.created, id: again.data.workspace.id });
  assert.equal(again.data.workspace.id, W);

  const tab = await c.call('herdr_create_tab', { workspace: W, label: 'proof', cwd: '/tmp' });
  step('create tab', tab.data);
  assert.equal(tab.data.created, true);

  const f = await c.call('herdr_run', { pane: tab.data.root_pane, command: 'false', timeout_ms: 20000 });
  step('run `false`', f.data);
  assert.equal(f.data.exit_code, 1);

  const ok = await c.call('herdr_run', { pane: tab.data.root_pane, command: 'echo hello from $(hostname -s) && sh -c "exit 7"', timeout_ms: 20000 });
  step('run echo + exit 7', ok.data);
  assert.equal(ok.data.exit_code, 7);
} finally {
  const closed = await c.call('herdr_close', { id: W });
  step('close our workspace', closed.data);
  const after = await c.call('herdr_snapshot');
  const now = after.data.workspaces.map((w) => `${w.id}:${w.label}:${w.tab_count}`);
  step('other workspaces unchanged', { before, after: now });
  assert.deepEqual(now, before);
  await c.close();
}
console.log('\nLIVE PROOF PASSED');
