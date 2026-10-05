#!/usr/bin/env node
// herdr MCP server: zero-dependency stdio JSON-RPC wrapper around the `herdr` CLI.
//
// ── Data shapes (verified against herdr 0.9.0 JSON, protocol 22) ─────────────
//
// Wire envelope (every JSON command):
//   { id: "cli:<group>:<verb>", result: { type: "<kind>", ... } }
//   { id: "cli:<group>:<verb>", error: { code: string, message: string } }   exit 1
//   syntax errors: plain "usage: ..." text, exit 2. `pane read`/`agent read` print text.
//
// Domain shapes this server returns (raw field names in brackets):
/**
 * @typedef {{ id: string,            // [workspace_id] e.g. "w8"
 *             label: string,         // [label]
 *             number: number,        // [number] sidebar position
 *             tab_count: number,     // [tab_count]
 *             status: string,        // [agent_status] rollup
 *             focused: boolean,      // [focused]
 *             repo: string|null,     // [worktree.repo_name]
 *             checkout_path: string|null, // [worktree.checkout_path]
 *             tabs: Tab[] }} Workspace
 * @typedef {{ id: string,            // [tab_id] e.g. "w8:t3"
 *             workspace_id: string, label: string, number: number,
 *             pane_count: number, status: string, focused: boolean,
 *             agents: Agent[] }} Tab
 * @typedef {{ target: string,        // name if set, else pane_id — what prompt/read accept
 *             name: string|null,     // [name] ABSENT on unnamed agents (most of them)
 *             kind: string,          // [agent] e.g. "claude" — never a valid target
 *             status: 'idle'|'done'|'working'|'blocked'|'unknown', // [agent_status]
 *             pane_id: string, tab_id: string, workspace_id: string,
 *             title: string,         // [terminal_title_stripped]
 *             cwd: string }} Agent
 * @typedef {{ exit_code: number|null, timed_out: boolean, output: string,
 *             output_lines: number, truncated: boolean }} CommandResult
 * @typedef {{ host: string, workspaces: Workspace[],
 *             agents_by_state: { waiting_for_input: Agent[],  // blocked: approval/question UI
 *                                working: Agent[], idle: Agent[], // idle + done
 *                                unknown: Agent[] },             // herdr has no "errored" state
 *             warnings: string[] }} Snapshot
 */

import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// ── Policy constants (the rules the old skill asked bots to remember) ────────
export const MAX_TABS = 7;
export const MAX_LINES = 200;
export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const WORKSPACE_ID_RE = /^w[0-9A-Za-z]+$/;
export const TAB_ID_RE = /^w[0-9A-Za-z]+:t[0-9A-Za-z]+$/;
export const PANE_ID_RE = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
export const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
// `herdr agent` (0.9.0) kind list. A kind is a label, never an addressable agent.
export const KINDS = ['pi', 'claude', 'codex', 'gemini', 'cursor', 'devin', 'agy', 'cline', 'omp',
  'mastracode', 'opencode', 'copilot', 'kimi', 'kiro', 'droid', 'amp', 'grok', 'hermes', 'kilo',
  'qodercli', 'qwen', 'maki', 'muse'];

// herdr error code -> one-line fix hint.
export const HINTS = {
  agent_not_found: 'Address the agent by its live name or pane id (see herdr_snapshot), never by kind; it may also have exited.',
  agent_not_idle: 'The agent is working: herdr_read_agent shows its visible screen; wait before reading full history.',
  agent_blocked: 'The agent is at an approval/question dialog and nothing was sent. Show the screen to its owner; do not answer it yourself.',
  agent_prompt_stalled: 'No working/blocked state within 5s. Read the screen: the prompt may still be in the input box. Do not resend blindly.',
  agent_not_ready: 'Startup dialog is showing; the name stays reserved. Read the screen and let the owner clear it.',
  agent_name_taken: 'Pick another unique lowercase name ([a-z][a-z0-9_-]{0,31}).',
  invalid_agent_name: 'Names must match [a-z][a-z0-9_-]{0,31}; kinds like "grok" are not names.',
  agent_pane_busy: 'That pane is not an idle shell. Create a fresh tab with herdr_create_tab and use its pane.',
  workspace_group_close_required: 'This workspace has linked worktrees. Close your own worktree workspaces first; --group is never used because it closes other people\'s work.',
  workspace_not_found: 'Workspace id is stale or wrong. Re-run herdr_snapshot for current ids.',
  tab_not_found: 'Tab id is stale or wrong. Re-run herdr_snapshot for current ids.',
  pane_not_found: 'Pane id is stale or wrong. Re-run herdr_snapshot for current ids.',
  timeout: 'Timed out. Read the screen before doing anything else; do not resend the same input.',
  transport_unreachable: 'Cannot reach the herdr host over ssh. Check `tailscale status`, that HERDR_HOST resolves to the tailnet IP, and the ssh user is allowed by tailnet policy.',
  herdr_not_found: 'herdr is not on the remote PATH. Set HERDR_REMOTE_PATH (default includes /opt/homebrew/bin).',
  usage_error: 'herdr rejected the arguments (exit 2). This is a bug in the plugin; report the args shown.',
  bad_output: 'herdr returned something that is not JSON. See raw output.',
};

export class ToolError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.hint = extra.hint ?? HINTS[code] ?? null;
    this.data = extra.data;
    this.herdr_code = extra.herdr_code;
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint,
      ...(this.herdr_code ? { herdr_code: this.herdr_code } : {}),
      ...(this.data !== undefined ? { data: this.data } : {}) };
  }
}

// ── Config (boundary: environment) ───────────────────────────────────────────
export function loadConfig(env = process.env) {
  const transport = env.HERDR_TRANSPORT === 'local' ? 'local' : 'ssh';
  const host = env.HERDR_HOST || 'laptop';
  return {
    transport,
    host,
    hostKey: transport === 'local' ? 'local' : host,
    bin: env.HERDR_BIN || 'herdr',
    remotePath: env.HERDR_REMOTE_PATH || '/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin',
    sshConnectTimeout: Number(env.HERDR_SSH_CONNECT_TIMEOUT || 10),
    stateFile: env.HERDR_PLUGIN_STATE ||
      path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'herdr-plugin', 'owned.json'),
  };
}

// ── Transport boundary ───────────────────────────────────────────────────────
/** POSIX single-quote one argv element so the remote shell sees it verbatim. */
export function shQuote(s) {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-.:/=@%+,]+$/.test(s)) return s;
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

export function buildInvocation(cfg, args) {
  if (cfg.transport === 'local') return { cmd: cfg.bin, argv: args };
  const remote = `export PATH="${cfg.remotePath}:$PATH"; exec ${shQuote(cfg.bin)} ${args.map(shQuote).join(' ')}`;
  return {
    cmd: 'ssh',
    argv: ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${cfg.sshConnectTimeout}`, cfg.host, remote],
  };
}

function spawnCollect(cmd, argv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', killed = false;
    const t = setTimeout(() => { killed = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 127, out, err: err + String(e.message), killed }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out, err, killed }); });
  });
}

/** Parse one herdr response into {result} or throw ToolError. Pure. */
export function parseHerdr({ code, out, err, killed }, { text = false, transport = 'ssh', args = [] } = {}) {
  if (killed) throw new ToolError('timeout', `herdr ${args.slice(0, 2).join(' ')} did not return in time`);
  const blob = (out || '') + (out && err ? '\n' : '') + (err || '');
  const firstJson = (s) => { const i = s.indexOf('{'); if (i < 0) return null; try { return JSON.parse(s.slice(i).trim()); } catch { return null; } };
  if (code !== 0) {
    const j = firstJson(err) || firstJson(out);
    if (j && j.error) {
      throw new ToolError(j.error.code || 'herdr_error', j.error.message || 'herdr error',
        { herdr_code: j.error.code, hint: HINTS[j.error.code] ?? 'Read the message before retrying; do not repeat the same call blindly.' });
    }
    if (transport === 'ssh' && code === 255) throw new ToolError('transport_unreachable', blob.trim().split('\n').pop() || 'ssh failed');
    if (code === 127 || /command not found/.test(blob)) throw new ToolError('herdr_not_found', blob.trim());
    if (code === 2) throw new ToolError('usage_error', blob.trim(), { data: { args } });
    throw new ToolError('herdr_error', blob.trim() || `herdr exited ${code}`);
  }
  if (text) return out;
  if (!out.trim()) return { type: 'ok' };
  const j = firstJson(out);
  if (!j) throw new ToolError('bad_output', 'expected JSON', { data: out.slice(0, 500) });
  if (j.error) throw new ToolError(j.error.code, j.error.message, { herdr_code: j.error.code });
  return j.result ?? j;
}

export function makeHerdr(cfg, runner = spawnCollect) {
  return async function herdr(args, { text = false, timeoutMs = 30000 } = {}) {
    if (args.includes('--group')) throw new ToolError('forbidden', '--group is never passed by this plugin');
    const { cmd, argv } = buildInvocation(cfg, args);
    const r = await runner(cmd, argv, timeoutMs);
    return parseHerdr(r, { text, transport: cfg.transport, args });
  };
}

// ── Pure parsers: raw herdr JSON -> domain shapes ────────────────────────────
export function toAgent(a) {
  return {
    target: a.name || a.pane_id, name: a.name ?? null, kind: a.agent, status: a.agent_status || 'unknown',
    pane_id: a.pane_id, tab_id: a.tab_id, workspace_id: a.workspace_id,
    title: a.terminal_title_stripped ?? a.terminal_title ?? '', cwd: a.cwd ?? '',
  };
}
export function toTab(t) {
  return { id: t.tab_id, workspace_id: t.workspace_id, label: t.label, number: t.number,
    pane_count: t.pane_count, status: t.agent_status, focused: !!t.focused, agents: [] };
}
export function toWorkspace(w) {
  return { id: w.workspace_id, label: w.label, number: w.number, tab_count: w.tab_count,
    status: w.agent_status, focused: !!w.focused, repo: w.worktree?.repo_name ?? null,
    checkout_path: w.worktree?.checkout_path ?? null, tabs: [] };
}

/** Assemble a Snapshot from the three list responses. Pure. */
export function buildSnapshot(host, wsList, tabList, agentList) {
  const workspaces = (wsList.workspaces || []).map(toWorkspace);
  const byWs = new Map(workspaces.map((w) => [w.id, w]));
  const tabs = (tabList.tabs || []).map(toTab);
  const byTab = new Map(tabs.map((t) => [t.id, t]));
  for (const t of tabs) byWs.get(t.workspace_id)?.tabs.push(t);
  const agents = (agentList.agents || []).map(toAgent);
  const groups = { waiting_for_input: [], working: [], idle: [], unknown: [] };
  for (const a of agents) {
    byTab.get(a.tab_id)?.agents.push(a);
    const g = a.status === 'blocked' ? 'waiting_for_input' : a.status === 'working' ? 'working'
      : (a.status === 'idle' || a.status === 'done') ? 'idle' : 'unknown';
    groups[g].push(a);
  }
  const warnings = [];
  for (const w of workspaces) if (w.tab_count > MAX_TABS) warnings.push(`workspace ${w.id} "${w.label}" has ${w.tab_count} tabs (cap ${MAX_TABS}); no new tabs will be created there`);
  const labels = new Map();
  for (const w of workspaces) labels.set(w.label, [...(labels.get(w.label) || []), w.id]);
  for (const [l, ids] of labels) if (ids.length > 1) warnings.push(`workspace label "${l}" is shared by ${ids.join(', ')}; refer to it by id`);
  const unnamed = agents.filter((a) => !a.name).length;
  if (unnamed) warnings.push(`${unnamed} agent(s) have no name; address them by pane_id (their "target")`);
  return { host, workspaces, agents_by_state: groups, warnings };
}

/** Validate an agent target: a live name or pane id, never a kind. Pure. */
export function checkTarget(target) {
  if (typeof target !== 'string' || !target) throw new ToolError('invalid_argument', 'agent target is required');
  if (KINDS.includes(target)) {
    throw new ToolError('kind_not_name', `"${target}" is an agent kind, not a name.`,
      { hint: 'Use the agent\'s live name or its pane id from herdr_snapshot (field "target"), e.g. "w8:p2".' });
  }
  if (!NAME_RE.test(target) && !PANE_ID_RE.test(target)) {
    throw new ToolError('invalid_argument', `"${target}" is neither an agent name ([a-z][a-z0-9_-]{0,31}) nor a pane id (wX:pN)`);
  }
  return target;
}

export function checkId(id, re, what) {
  if (typeof id !== 'string' || !re.test(id)) throw new ToolError('invalid_argument', `${what} id "${id}" is malformed`, { hint: 'Copy ids from herdr_snapshot.' });
  return id;
}
export function checkLabel(label, what = 'label') {
  if (typeof label !== 'string' || !label.trim()) throw new ToolError('invalid_argument', `${what} is required`);
  if (label.startsWith('-')) throw new ToolError('invalid_argument', `${what} may not start with "-"`);
  if (/[\n\r]/.test(label) || label.length > 80) throw new ToolError('invalid_argument', `${what} must be one line, <= 80 chars`);
  return label.trim();
}
const clampLines = (n, d) => Math.max(1, Math.min(MAX_LINES, Number.isFinite(+n) && +n > 0 ? Math.floor(+n) : d));

/** Build the run wrapper and its marker regex. Pure. */
export function wrapCommand(command, token) {
  return {
    line: `${command}; printf '\\n__HERDR_EXIT_${token}:%s__\\n' "$?"`,
    regex: `__HERDR_EXIT_${token}:[0-9]+__`,
    echoNeedle: `__HERDR_EXIT_${token}:%s__`,
    markerRe: new RegExp(`^__HERDR_EXIT_${token}:([0-9]+)__\\s*$`),
  };
}

/** Extract the real exit code and the command's own output from pane text. Pure. */
export function extractRun(text, wrap, maxLines = MAX_LINES) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  let m = -1, code = null;
  for (let i = lines.length - 1; i >= 0; i--) { const mm = lines[i].match(wrap.markerRe); if (mm) { m = i; code = Number(mm[1]); break; } }
  if (m < 0) return null;
  let start = 0;
  for (let i = m - 1; i >= 0; i--) if (lines[i].includes(wrap.echoNeedle)) { start = i + 1; break; }
  let body = lines.slice(start, m);
  while (body.length && !body[body.length - 1].trim()) body.pop();
  while (body.length && !body[0].trim()) body.shift();
  const truncated = body.length > maxLines;
  if (truncated) body = body.slice(-maxLines);
  return { exit_code: code, timed_out: false, output: body.join('\n'), output_lines: body.length, truncated };
}

// ── Ownership record (state lives on the side running this server) ──────────
export class Ownership {
  constructor(file, hostKey) { this.file = file; this.hostKey = hostKey; }
  _load() {
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); return j && j.hosts ? j : { version: 1, hosts: {} }; }
    catch { return { version: 1, hosts: {} }; }
  }
  _save(j) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
    fs.renameSync(tmp, this.file);
  }
  list() { return this._load().hosts[this.hostKey] || []; }
  get(id) { return this.list().find((e) => e.id === id) || null; }
  add(entry) {
    const j = this._load(); const l = j.hosts[this.hostKey] || [];
    if (!l.some((e) => e.id === entry.id)) l.push({ ...entry, created_at: new Date().toISOString() });
    j.hosts[this.hostKey] = l; this._save(j);
  }
  remove(id) {
    const j = this._load();
    // closing a workspace also drops the tabs recorded inside it
    j.hosts[this.hostKey] = (j.hosts[this.hostKey] || []).filter((e) => e.id !== id && e.workspace_id !== id);
    this._save(j);
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

export const TOOL_DEFS = [
  { name: 'herdr_snapshot', description: 'One call: every workspace with its tabs and the agents in them, plus agents grouped by waiting_for_input (blocked on approval/question), working, idle, unknown. Start here; use the ids and agent "target" values it returns.', inputSchema: S({}) },
  { name: 'herdr_read_agent', description: 'Read what an agent is showing. Picks the right source automatically: the visible screen while working/blocked, the latest reply (recent-unwrapped) when idle.', inputSchema: S({ target: str('Agent name or pane id (the "target" from herdr_snapshot). Kinds like "claude" are rejected.'), lines: int('Lines of history when idle, max 200 (default 120).') }, ['target']) },
  { name: 'herdr_prompt_agent', description: 'Send a prompt to an agent by name or pane id and wait until it settles. Optional skill is invoked as a leading "/skill". On timeout/stalled/blocked it returns the visible screen instead of retrying, and an identical re-send after such an outcome is refused unless confirm_resend is true.', inputSchema: S({ target: str('Agent name or pane id. Kinds are rejected.'), text: str('Prompt text, single submission.'), skill: str('Skill to invoke, e.g. "review" -> "/review <text>".'), timeout_ms: int('Wait budget in ms (default 600000, max 3600000).'), reply_lines: int('Lines of reply to return when idle (default 80, max 200).'), confirm_resend: { type: 'boolean', description: 'Set only after reading the screen and deciding a re-send is right.' } }, ['target', 'text']) },
  { name: 'herdr_run', description: 'Run one shell command in a terminal (non-agent) pane and return its REAL exit code and trimmed output (<=200 lines). Refuses panes that host an agent.', inputSchema: S({ pane: str('Pane id, e.g. "w8:p3" (root_pane from herdr_create_tab).'), command: str('One-line POSIX shell command.'), timeout_ms: int('Wait budget in ms (default 120000, max 1800000).'), lines: int('Max output lines (default 200, max 200).') }, ['pane', 'command']) },
  { name: 'herdr_create_workspace', description: 'Get-or-create a workspace (one per repository) without stealing focus. Returns the existing one if the label or checkout path already matches.', inputSchema: S({ label: str('Workspace label, usually the repo name.'), cwd: str('Absolute path on the herdr host (the repo checkout).') }, ['label']) },
  { name: 'herdr_create_tab', description: 'Get-or-create a tab in a workspace without stealing focus. Returns an existing tab with the same label; refuses an 8th tab.', inputSchema: S({ workspace: str('Workspace id, e.g. "w8".'), label: str('Tab label describing its role.'), cwd: str('Absolute start directory on the herdr host.') }, ['workspace', 'label']) },
  { name: 'herdr_create_worktree', description: 'Get-or-create a git worktree + its own workspace for one bot (branch per bot) without stealing focus. Re-opens an existing branch instead of creating twice.', inputSchema: S({ workspace: str('Source repo workspace id.'), branch: str('New or existing branch name.'), base: str('Base ref for a new branch.'), label: str('Workspace label for the worktree.') }, ['workspace', 'branch']) },
  { name: 'herdr_start_agent', description: 'Start a coding agent with a unique name in an idle shell pane (e.g. the root_pane of a tab you created).', inputSchema: S({ name: str('Unique lowercase name [a-z][a-z0-9_-]{0,31}, not a kind.'), kind: { type: 'string', enum: KINDS, description: 'Agent kind.' }, pane: str('Pane id at an idle shell.'), timeout_ms: int('Startup wait (default 60000).') }, ['name', 'kind', 'pane']) },
  { name: 'herdr_close', description: 'Close a workspace, tab, or worktree that THIS plugin created (recorded in its ownership file). Anything else is refused.', inputSchema: S({ id: str('Workspace or tab id returned by a herdr_create_* call.') }, ['id']) },
  { name: 'herdr_rename_tab', description: 'Rename a tab. Tell the user afterwards that you renamed it.', inputSchema: S({ tab: str('Tab id.'), label: str('New label.') }, ['tab', 'label']) },
  { name: 'herdr_notify', description: 'Show a toast to the person at the herdr client.', inputSchema: S({ title: str('Toast title.'), body: str('Optional body.'), sound: { type: 'string', enum: ['none', 'done', 'request'] } }, ['title']) },
];

export function makeTools({ herdr, owned, cfg, now = () => Date.now(), token = () => randomBytes(5).toString('hex') }) {
  const lastPrompt = new Map(); // target -> {hash, outcome, at}

  const screen = async (target) => {
    try { return await herdr(['agent', 'read', target, '--source', 'visible'], { text: true }); }
    catch (e) { return `(could not read screen: ${e.message})`; }
  };
  const tabsOf = async (ws) => (await herdr(['tab', 'list', '--workspace', ws])).tabs || [];

  const tools = {
    async herdr_snapshot() {
      const [w, t, a] = await Promise.all([herdr(['workspace', 'list']), herdr(['tab', 'list']), herdr(['agent', 'list'])]);
      const snap = buildSnapshot(cfg.hostKey, w, t, a);
      snap.owned = owned.list().map((e) => e.id);
      return snap;
    },

    async herdr_read_agent({ target, lines }) {
      checkTarget(target);
      const agent = toAgent((await herdr(['agent', 'get', target])).agent);
      const idle = agent.status === 'idle' || agent.status === 'done';
      const args = idle ? ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(clampLines(lines, 120))]
        : ['agent', 'read', target, '--source', 'visible'];
      const text = await herdr(args, { text: true });
      return { agent, source: idle ? 'recent-unwrapped' : 'visible', text };
    },

    async herdr_prompt_agent({ target, text, skill, timeout_ms, reply_lines, confirm_resend }) {
      checkTarget(target);
      if (typeof text !== 'string' || !text.trim()) throw new ToolError('invalid_argument', 'text is required');
      let body = text.trim();
      if (skill) {
        const s = String(skill).replace(/^\//, '');
        if (!SKILL_RE.test(s)) throw new ToolError('invalid_argument', `skill "${skill}" is not a valid skill name`);
        if (!body.startsWith(`/${s}`)) body = `/${s} ${body}`;
      }
      if (body.startsWith('-')) throw new ToolError('invalid_argument', 'prompt text may not start with "-"', { hint: 'Start with a word.' });
      const hash = createHash('sha256').update(body).digest('hex');
      const prev = lastPrompt.get(target);
      if (prev && prev.hash === hash && prev.outcome !== 'settled' && now() - prev.at < 30 * 60e3 && !confirm_resend) {
        throw new ToolError('duplicate_prompt', `The same prompt to ${target} ended "${prev.outcome}" ${Math.round((now() - prev.at) / 1000)}s ago.`,
          { hint: 'It may already be in the input box or running. Read the screen (herdr_read_agent); pass confirm_resend:true only if a re-send is right.', data: { screen: await screen(target) } });
      }
      const t = Math.min(Math.max(Number(timeout_ms) || 600000, 10000), 3600000);
      try {
        const res = await herdr(['agent', 'prompt', target, body, '--wait', '--timeout', String(t)], { timeoutMs: t + 30000 });
        lastPrompt.set(target, { hash, outcome: 'settled', at: now() });
        const agent = toAgent((await herdr(['agent', 'get', target])).agent);
        const idle = agent.status === 'idle' || agent.status === 'done';
        const reply = idle
          ? await herdr(['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', String(clampLines(reply_lines, 80))], { text: true })
          : await screen(target);
        return { outcome: agent.status === 'blocked' ? 'blocked' : 'settled', sent: body, agent, herdr_result: res,
          reply_source: idle ? 'recent-unwrapped' : 'visible', reply,
          note: 'A settled status does not prove the work happened; check the artifact you asked for.' };
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        const soft = { timeout: 'timeout', agent_prompt_stalled: 'stalled', agent_blocked: 'blocked', agent_not_ready: 'not_ready' }[e.code];
        if (!soft) throw e;
        lastPrompt.set(target, { hash, outcome: soft, at: now() });
        return { outcome: soft, sent: soft === 'blocked' ? null : body, herdr_code: e.herdr_code || e.code, hint: e.hint, screen: await screen(target) };
      }
    },

    async herdr_run({ pane, command, timeout_ms, lines }) {
      checkId(pane, PANE_ID_RE, 'pane');
      if (typeof command !== 'string' || !command.trim()) throw new ToolError('invalid_argument', 'command is required');
      if (/[\n\r]/.test(command)) throw new ToolError('invalid_argument', 'command must be one line', { hint: 'Join steps with && or ;, or write a script file and run it.' });
      if (command.trim().startsWith('-')) throw new ToolError('invalid_argument', 'command may not start with "-"');
      const p = (await herdr(['pane', 'get', pane])).pane;
      if (p.agent) throw new ToolError('pane_hosts_agent', `pane ${pane} hosts a ${p.agent} agent${p.name ? ` (${p.name})` : ''}; typing a shell command there would prompt it`, { hint: 'Use herdr_prompt_agent for agents, or create a terminal tab with herdr_create_tab.' });
      const wrap = wrapCommand(command.trim().replace(/;\s*$/, ''), token());
      const t = Math.min(Math.max(Number(timeout_ms) || 120000, 1000), 1800000);
      const max = clampLines(lines, MAX_LINES);
      await herdr(['pane', 'run', pane, wrap.line]);
      try {
        const res = await herdr(['pane', 'wait-output', pane, '--regex', wrap.regex, '--source', 'recent-unwrapped', '--lines', String(MAX_LINES), '--timeout', String(t)], { timeoutMs: t + 30000 });
        let parsed = extractRun(res.read?.text ?? '', wrap, max);
        if (!parsed) parsed = extractRun(await herdr(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(MAX_LINES)], { text: true }), wrap, max);
        if (!parsed) throw new ToolError('marker_lost', 'exit marker matched but could not be parsed', { data: res.matched_line });
        return { pane, command, ...parsed };
      } catch (e) {
        if (!(e instanceof ToolError) || e.code !== 'timeout') throw e;
        const vis = await herdr(['pane', 'read', pane, '--source', 'visible'], { text: true }).catch(() => '');
        return { pane, command, exit_code: null, timed_out: true, output: vis.split('\n').slice(-max).join('\n'), output_lines: Math.min(max, vis.split('\n').length), truncated: false,
          hint: 'Still running (or waiting for input). Read the pane later; do not re-run it.' };
      }
    },

    async herdr_create_workspace({ label, cwd }) {
      label = checkLabel(label);
      if (cwd !== undefined && (typeof cwd !== 'string' || !cwd.startsWith('/'))) throw new ToolError('invalid_argument', 'cwd must be an absolute path on the herdr host');
      const list = (await herdr(['workspace', 'list'])).workspaces || [];
      const hit = list.find((w) => w.label === label) || (cwd && list.find((w) => w.worktree?.checkout_path === cwd.replace(/\/$/, '')));
      if (hit) return { created: false, matched_by: hit.label === label ? 'label' : 'checkout_path', owned: !!owned.get(hit.workspace_id), workspace: toWorkspace(hit) };
      const args = ['workspace', 'create', '--label', label, '--no-focus'];
      if (cwd) args.push('--cwd', cwd);
      const r = await herdr(args);
      owned.add({ id: r.workspace.workspace_id, type: 'workspace', label });
      owned.add({ id: r.tab.tab_id, type: 'tab', label: r.tab.label, workspace_id: r.workspace.workspace_id });
      return { created: true, owned: true, workspace: toWorkspace(r.workspace), tab: toTab(r.tab), root_pane: r.root_pane?.pane_id };
    },

    async herdr_create_tab({ workspace, label, cwd }) {
      checkId(workspace, WORKSPACE_ID_RE, 'workspace');
      label = checkLabel(label);
      if (cwd !== undefined && (typeof cwd !== 'string' || !cwd.startsWith('/'))) throw new ToolError('invalid_argument', 'cwd must be an absolute path on the herdr host');
      const tabs = await tabsOf(workspace);
      const hit = tabs.find((t) => t.label === label);
      if (hit) {
        const panes = ((await herdr(['pane', 'list', '--workspace', workspace])).panes || []).filter((p) => p.tab_id === hit.tab_id);
        return { created: false, owned: !!owned.get(hit.tab_id), tab: toTab(hit), root_pane: panes[0]?.pane_id ?? null };
      }
      if (tabs.length >= MAX_TABS) {
        throw new ToolError('tab_limit_reached', `workspace ${workspace} already has ${tabs.length} tabs (cap ${MAX_TABS})`,
          { hint: 'Reuse an existing tab (rename it if needed and tell the user), or ask the user before going past seven.', data: { tabs: tabs.map(toTab) } });
      }
      const args = ['tab', 'create', '--workspace', workspace, '--label', label, '--no-focus'];
      if (cwd) args.push('--cwd', cwd);
      const r = await herdr(args);
      owned.add({ id: r.tab.tab_id, type: 'tab', label, workspace_id: workspace });
      return { created: true, owned: true, tab: toTab(r.tab), root_pane: r.root_pane?.pane_id };
    },

    async herdr_create_worktree({ workspace, branch, base, label }) {
      checkId(workspace, WORKSPACE_ID_RE, 'workspace');
      if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/.test(branch) || branch.includes('..')) throw new ToolError('invalid_argument', `branch "${branch}" is not a valid branch name`);
      if (label !== undefined) label = checkLabel(label);
      if (base !== undefined && (typeof base !== 'string' || base.startsWith('-'))) throw new ToolError('invalid_argument', 'base must be a ref');
      const wl = await herdr(['worktree', 'list', '--workspace', workspace]);
      const hit = (wl.worktrees || []).find((w) => w.branch === branch);
      if (hit?.open_workspace_id) return { created: false, owned: !!owned.get(hit.open_workspace_id), workspace_id: hit.open_workspace_id, path: hit.path, branch };
      const args = hit ? ['worktree', 'open', '--workspace', workspace, '--branch', branch, '--no-focus']
        : ['worktree', 'create', '--workspace', workspace, '--branch', branch, '--no-focus'];
      if (!hit && base) args.push('--base', base);
      if (label) args.push('--label', label);
      const r = await herdr(args);
      const wsId = r.workspace?.workspace_id ?? r.open_workspace_id ?? r.worktree?.open_workspace_id;
      if (!wsId) throw new ToolError('bad_output', 'worktree response had no workspace id', { data: r });
      // Only a checkout we created is ours to remove; a re-opened one we can only close.
      owned.add({ id: wsId, type: hit ? 'workspace' : 'worktree', label: label || branch, branch });
      return { created: !hit, reopened: !!hit, owned: true, workspace_id: wsId, path: r.worktree?.path ?? r.path ?? hit?.path ?? null, branch, root_pane: r.root_pane?.pane_id ?? null };
    },

    async herdr_start_agent({ name, kind, pane, timeout_ms }) {
      if (typeof name !== 'string' || !NAME_RE.test(name)) throw new ToolError('invalid_agent_name', `"${name}" does not match [a-z][a-z0-9_-]{0,31}`);
      if (KINDS.includes(name)) throw new ToolError('kind_not_name', `"${name}" is a kind; pick a role name like "${name}-builder"`);
      if (!KINDS.includes(kind)) throw new ToolError('invalid_argument', `unknown kind "${kind}"`, { hint: `One of: ${KINDS.join(', ')}` });
      checkId(pane, PANE_ID_RE, 'pane');
      const t = Math.min(Math.max(Number(timeout_ms) || 60000, 5000), 300000);
      try {
        const r = await herdr(['agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', String(t)], { timeoutMs: t + 30000 });
        return { started: true, agent: r.agent ? toAgent(r.agent) : null, herdr_result: r.agent ? undefined : r };
      } catch (e) {
        if (e instanceof ToolError && e.code === 'agent_not_ready') return { started: true, ready: false, hint: e.hint, screen: await screen(name) };
        throw e;
      }
    },

    async herdr_close({ id }) {
      if (typeof id !== 'string' || !(WORKSPACE_ID_RE.test(id) || TAB_ID_RE.test(id))) throw new ToolError('invalid_argument', `"${id}" is not a workspace or tab id`);
      const e = owned.get(id);
      if (!e) throw new ToolError('not_owned', `${id} was not created by this plugin on ${cfg.hostKey}; refusing to close it`,
        { hint: 'Only ids returned by herdr_create_* are closable. Ask the user to close anything else.', data: { owned: owned.list().map((x) => x.id) } });
      const args = e.type === 'worktree' ? ['worktree', 'remove', '--workspace', id]
        : e.type === 'workspace' ? ['workspace', 'close', id] : ['tab', 'close', id];
      try { await herdr(args); }
      catch (err) {
        if (err instanceof ToolError && /_not_found$/.test(err.code)) { owned.remove(id); return { closed: false, already_gone: true, id }; }
        throw err;
      }
      owned.remove(id);
      return { closed: true, id, type: e.type };
    },

    async herdr_rename_tab({ tab, label }) {
      checkId(tab, TAB_ID_RE, 'tab');
      label = checkLabel(label);
      const before = toTab((await herdr(['tab', 'get', tab])).tab);
      if (before.label === label) return { renamed: false, tab: before };
      await herdr(['tab', 'rename', tab, label]);
      return { renamed: true, from: before.label, to: label, tab: tab, reminder: 'Tell the user you renamed this tab.' };
    },

    async herdr_notify({ title, body, sound }) {
      title = checkLabel(title, 'title');
      const args = ['notification', 'show', title];
      if (body) { if (String(body).startsWith('-')) throw new ToolError('invalid_argument', 'body may not start with "-"'); args.push('--body', String(body)); }
      if (sound) { if (!['none', 'done', 'request'].includes(sound)) throw new ToolError('invalid_argument', 'sound must be none|done|request'); args.push('--sound', sound); }
      await herdr(args);
      return { shown: true };
    },
  };
  return tools;
}

// ── MCP stdio JSON-RPC ───────────────────────────────────────────────────────
const SERVER_INFO = { name: 'herdr', version: '0.1.0' };

export function makeHandler(tools) {
  return async function handle(msg) {
    const { id, method, params } = msg;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (method === 'initialize') {
      return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
        instructions: 'Drives herdr on the user\'s laptop. Start with herdr_snapshot. See the "Use herdr" skill for judgement rules.' });
    }
    if (method === 'notifications/initialized' || (id === undefined && method?.startsWith('notifications/'))) return null;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOL_DEFS });
    if (method === 'tools/call') {
      const name = params?.name; const fn = tools[name];
      if (!fn) return fail(-32602, `unknown tool ${name}`);
      try {
        const out = await fn(params.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
      } catch (e) {
        const err = e instanceof ToolError ? e.toJSON() : { code: 'internal', message: String(e?.message || e), hint: null };
        return reply({ content: [{ type: 'text', text: JSON.stringify({ error: err }, null, 2) }], structuredContent: { error: err }, isError: true });
      }
    }
    if (id === undefined) return null;
    return fail(-32601, `method not found: ${method}`);
  };
}

export function serve({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const cfg = loadConfig(env);
  const herdr = makeHerdr(cfg);
  const tools = makeTools({ herdr, owned: new Ownership(cfg.stateFile, cfg.hostKey), cfg });
  const handle = makeHandler(tools);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let pending = 0, closed = false;
  const maybeExit = () => { if (closed && pending === 0) process.exitCode = 0; };
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    pending++;
    try { const r = await handle(msg); if (r) output.write(JSON.stringify(r) + '\n'); }
    finally { pending--; maybeExit(); }
  });
  rl.on('close', () => { closed = true; maybeExit(); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
