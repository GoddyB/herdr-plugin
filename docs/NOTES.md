# Build notes (progress log)
- Transport finding: `ssh laptop` from box times out: `laptop` resolves via /etc/hosts-less DNS to 198.18.0.1 (not tailnet; accept-dns=false so no MagicDNS). Tailnet IP 100.91.60.48 works.
- Tailnet SSH policy rejects user "box"; user `godservant` is permitted.
- Non-interactive zsh PATH lacks /opt/homebrew/bin, where herdr lives -> must prefix PATH.
- herdr 0.9.0, protocol 22.
- Verified shapes (probe1.txt, raw1/raw2): envelope {id, result:{type,...}} | {id, error:{code,message}}; ids are workspace_id/tab_id/pane_id (not `id`);
  agent kind is field `agent`, status `agent_status`, name `name` (absent when unnamed — all user agents are unnamed today!).
- pane run prints nothing on success. wait-output returns {type:output_matched, matched_line, read:{text,...}}; timeout -> error code `timeout`.
- workspace create -> result.workspace/.tab/.root_pane; tab create -> result.tab/.root_pane; close -> {type:ok}.
- micro1 workspace already has 8 tabs (over the 7 cap).
- herdr kinds (0.9.0): pi claude codex gemini cursor devin agy cline omp mastracode opencode copilot kimi kiro droid amp grok hermes kilo qodercli qwen maki muse
