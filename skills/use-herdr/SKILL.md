---
name: Use herdr
description: >-
  Use for any coding task on the user's computer. That work goes through herdr
  on the laptop via the herdr_* tools, never on this box. Start with
  herdr_snapshot, read before you act, one workspace per repository, and leave
  other agents' dialogs to their owner.
---
# Use herdr

herdr is the lane for coding work on the user's computer. Drive it only through the `herdr_*` tools. They run herdr on the laptop over Tailscale and enforce the mechanical rules for you: no addressing by kind, `--no-focus`, at most 7 tabs, real exit codes, no blind resends, close only what you created, and never `--group`. When a tool refuses, its error carries a `hint`. Follow the hint. Don't look for a way around it. Use a Cursor cloud agent only when the user allows cloud work.

## Connect

The MCP server runs `herdr` over `ssh $HERDR_HOST` (default `laptop`), or runs it directly when `HERDR_TRANSPORT=local`. A `transport_unreachable` error means the tailnet or ssh is down:

1. If the daemon isn't running: `sudo tailscaled --statedir=/var/lib/tailscale --socket=/run/tailscale/tailscaled.sock`
2. Bring up the saved login: `sudo tailscale --socket=/run/tailscale/tailscaled.sock up --accept-dns=false --ssh=false --netfilter-mode=off`. Don't use an exit node, subnet routes, or DNS takeover.
3. The auth key is only in `/etc/tailscale/auth.env` (`TS_AUTHKEY`, root, mode 600). Never print it or copy it anywhere. The saved login in `/var/lib/tailscale` persists. Ask for a new key only if that login is gone.
4. With `--accept-dns=false`, the name `laptop` won't resolve to the tailnet, and the tailnet only allows ssh as the laptop's user. Point `HERDR_HOST` at `user@<tailnet-ip>`, or add an ssh `Host laptop` alias with `HostName` set to the tailnet IP and `User` set.

## Read before you act

- Call `herdr_snapshot` first. Tell the user what's on screen before you change anything.
- Address agents by the `target` field from the snapshot. That's the agent's name if it has one, otherwise its pane id. `herdr_read_agent` picks the right source for you.
- A settled prompt doesn't prove the work got done. Ask the agent to write its result to a file, then check that file.
- If a prompt comes back `blocked`, `stalled`, or `timeout`, the tool shows you the screen. Decide from what's on screen. Only set `confirm_resend` when a resend is clearly right.
- **Never answer another agent's approval or question dialog.** The tools can't send keys, and you shouldn't find another way to. Show the dialog to the person who owns it.

## Workspaces and tabs

- One workspace per repository. A tab is either a terminal or one agent role. `herdr_create_workspace` returns the existing workspace when it finds a match.
- Keep the user's tabs as they are. Ask before you add or rename a tab, unless the user wants you working on your own. After any rename, tell the user. Never close the user's tabs or workspaces.
- When the user points you at a workspace that already has tabs, work in those tabs and stay in the visible session so the user can take over. Don't start hidden runs.
- Keep a lasting record of which tab does which kind of work. If your record disagrees with herdr, herdr is right: update the record. Never create tabs just to make herdr match your record.
- When asked to create an agent, give it its own clearly named tab (`herdr_create_tab`, then `herdr_start_agent`). Never run a coding agent outside herdr.

## Roles

Before you assign work in a repository, learn what each agent in that workspace is for. Use the tab title, the agent's name, its transcript, or ask the agent. Don't carry roles over from another repository, and don't go by memory.

The default pattern is the same in every repository:
- **Claude** reviews (PRs especially) and handles UI design and multimedia.
- **Codex** is the workhorse for tasks that need a lot of intelligence.
- **Pi** (OpenAI auth) builds and is mostly interchangeable with Codex.
- **Grok Build** is the fallback when Codex limits run low. It also builds out plans from Codex or Claude and applies their review fixes.

To invoke a skill, pass `skill` to `herdr_prompt_agent`. Don't spell out the skill's instructions in the prompt too.

## Several bots in one repo

Give each bot its own worktree (`herdr_create_worktree`, one branch per bot) so they don't overwrite each other's work. You own merging their work into sensible PRs. Don't make one giant PR just to merge everything, and don't open one tiny PR per worktree when the task doesn't need it. Use your judgement.

## Be the user's eyes

Across the workspaces you're responsible for, watch `herdr_snapshot`'s `agents_by_state`. Track which sessions are `waiting_for_input` (blocked on a dialog), which are `working`, which are `idle`, and which are `unknown`, plus anything new or erroring since you last looked. Report these unprompted, including during voice chats. When something needs the user, use `herdr_notify`. Drive herdr the way the user would if they were at the computer.
