# Token Factory runs

How to run the workshop task on open models served by Nebius Token Factory and compare them with a
vendor model in the same harness.

**Harness: Codex CLI.** Cursor CLI can't call a custom endpoint, so Token Factory models run in
Codex through a custom provider (Responses API, `https://api.tokenfactory.nebius.com/v1`). The vendor
reference is Codex with Sol 6.1 on the same machine, Codex version and day.

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

The full attempt must show a `📊 Codex:` line with non-zero tokens and a gate result. Repeat it for
each model before the real runs.

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
