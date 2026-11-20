# Token Factory runs

How to run the workshop task on open models served by Nebius Token Factory and compare them with a
vendor model in the same harness.

**Harness: Codex CLI.** Cursor CLI can't call a custom endpoint, so Token Factory models run in
Codex through a custom provider (Responses API, `https://api.tokenfactory.nebius.com/v1`). The vendor
reference is Codex with Sol 6.1 on the same machine, Codex version and day.

## Why there is a relay

Codex sends each MCP server's tools as one `type: "namespace"` entry (`mcp__jira` with its tools
inside) and expects tool calls back with a `namespace` field. Token Factory ignores namespace
entries, so without help the model sees no MCP tools: it can't read the ticket and burns the run
looking for it. Codex has no setting to send them as plain functions.

`e2e/tf-relay.ts` sits between Codex and Token Factory on `127.0.0.1` (random port). The bench starts
it in its own process for `--provider tokenfactory`; nothing else to run.

| Direction | What the relay does |
|---|---|
| Codex → TF | Every namespace becomes plain function tools named `<namespace>__<tool>` (`mcp__jira__jira_get_issue`). History items with a `namespace` get the same flat name. |
| TF → Codex | Every `function_call` with such a name gets `namespace` + the original `name` back, in streamed (SSE) and plain JSON responses. |
| Usage | Each completed response's `usage` is appended to `.measurements/tf-relay.jsonl` as Token Factory reported it. |

The bench takes a Token Factory attempt's tokens from that log (everything logged since the attempt
started). This also counts runs that Codex never finished, such as the 10-minute timeout, where
Codex itself prints no usage.

Checked with Codex 0.171.0. If a later Codex changes the namespace format, the symptom comes back:
the model has no `jira_*` tools and calls `list_mcp_resources` instead.

Conditions: `baseline`, `hygiene`, `proxy`. There is no `hooks` condition — the Codex MCP hook never
fired in the October runs.

## One-time setup

```bash
npm install
npm run setup -- codex      # Docker + MCP servers + trust; also creates .env from .env.example
npm run task -- codex       # TASK.md into apps/angular-demo
npm run workshop:doctor     # must print PASS
codex mcp list              # only the five workshop servers should load
```

If `codex mcp list` shows your own global servers, set `enabled = false` under their
`[mcp_servers.<name>]` in `~/.codex/config.toml` for the runs and switch them back afterwards.

Put your key into `.env` (git-ignored):

```text
NEBIUS_API_KEY=<your key>
```

Use a key from a Token Factory project created for this experiment only: the console then shows
its usage alone, which is an independent check of the numbers the bench parses from Codex.

Check the model IDs and prices: the IDs in `CODEX_PRICE` (`e2e/_lib.ts`) must match
`GET https://api.tokenfactory.nebius.com/v1/models`. A model without a price row is recorded with
cost 0 and a warning.

## Smoke test

```bash
npm run bench -- --ping --models zai-org/GLM-5.3-Flash      # one tiny request: provider + key work
npm run bench -- --models zai-org/GLM-5.3-Flash             # one full baseline attempt: MCP, edits, gate
```

The full attempt must show an `mcp_tool_call` to `jira_get_issue`, a `📊 Codex:` line with non-zero
tokens and a gate result. Repeat it for each model before the real runs.

`529 System is overloaded` lines from Token Factory are retried by Codex; they don't fail the run.

## Real runs

```bash
# Token Factory models, 5 attempts per cell
npm run bench -- --models zai-org/GLM-5.3-Flash,MiniMaxAI/MiniMax-M3.1-Flash,deepseek-ai/DeepSeek-V4-Pro \
  --conditions baseline,hygiene,proxy --attempts 5

# Vendor reference, same harness and day
npm run bench -- --provider openai --models gpt-6.1-sol --effort medium \
  --conditions baseline,hygiene,proxy --attempts 3
```

Run sequentially: Token Factory raises rate limits gradually, and parallel runs can hit 429.

Every attempt is appended to `.measurements/metrics.jsonl` with `model`, `provider`, `lever`,
`attempt`, `wallMs`, tokens by type, cost and the gate result. The bench prints medians at the end.
Cost per passed run = cost of all attempts ÷ attempts that passed.
