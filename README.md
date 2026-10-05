# herdr Agent Plugin

Lets bots drive [herdr](https://herdr.dev) (a terminal multiplexer for coding agents) on the user's laptop safely.
It has two parts. A zero-dependency stdio MCP server (`server/herdr-mcp.mjs`, Node built-ins only) turns herdr's rules into code. A lean skill (`skills/use-herdr/SKILL.md`) keeps only the judgement calls that code can't make.

## Layout
```
plugin.json                 Agent Plugins manifest (schema 1.0.0)
mcp.json                    stdio server, cwd ${PLUGIN_ROOT}
server/herdr-mcp.mjs        data shapes, transport, pure parsers/policy, tools, JSON-RPC loop
skills/use-herdr/SKILL.md   "Use herdr" judgement rules
test/server.test.mjs        node --test suite (fake herdr on PATH)
test/bin/herdr              fake herdr that mirrors real 0.9.0 JSON
scripts/handshake.mjs       pipes initialize + tools/list + tools/call into the server
scripts/live-proof.mjs      rerunnable live proof in a throwaway `tinkabot-test` workspace
docs/                       build notes, captured real herdr output, proof logs (gitignored: they hold host/session details)
```

## Configuration (env on the MCP server)
| var | default | meaning |
|---|---|---|
| `HERDR_TRANSPORT` | `ssh` | `local` runs `herdr` directly |
| `HERDR_HOST` | `laptop` | ssh destination, e.g. `user@100.x.y.z` |
| `HERDR_REMOTE_PATH` | `/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin` | prepended to PATH on the remote side (non-login zsh lacks Homebrew) |
| `HERDR_BIN` | `herdr` | binary name/path |
| `HERDR_PLUGIN_STATE` | `~/.local/state/herdr-plugin/owned.json` | ownership record, kept per host |

## Tools
`herdr_snapshot`, `herdr_read_agent`, `herdr_prompt_agent`, `herdr_run`, `herdr_create_workspace`, `herdr_create_tab`, `herdr_create_worktree`, `herdr_start_agent`, `herdr_close`, `herdr_rename_tab`, `herdr_notify`.
The plugin deliberately has no bare `herdr`, no send-keys, no `--group`, no pane split/move, and no dialog answering.

## Verify
```
npm test                                             # 13 behaviour tests against the fake herdr
HERDR_HOST=user@tailnet-ip node scripts/handshake.mjs
HERDR_HOST=user@tailnet-ip node scripts/live-proof.mjs   # creates/closes only `tinkabot-test`
```
