# Overnight Token Factory runs — runbook

How to run the full Token Factory comparison unattended, recover from failures, and check the
results. The November 2026 results are in [measurements-2026-11-tf.md](measurements-2026-11-tf.md).

## 1. What runs

`scripts/overnight.sh` (start it under `caffeinate -i`) does this:

| Step | Command it runs | Attempts | Output |
|---|---|---|---|
| preflight | checks below | — | `.measurements/overnight/status.log` |
| stage1-tf | TF models · baseline | 4 (+1 smoke = 5) | `overnight/stage1-tf.log` |
| stage1-sol | Sol 6.1 · baseline · effort medium | 2 (+1 smoke = 3) | `overnight/stage1-sol.log` |
| stage2-tf | TF models · hygiene, proxy, hooks | 5 each | `overnight/stage2-tf.log` |
| stage2-sol | Sol 6.1 · hygiene, proxy | 3 each | `overnight/stage2-sol.log` |
| summary | `npx tsx e2e/summarize.ts` | — | `.measurements/overnight-summary.{md,json}` |

TF models: `zai-org/GLM-5.3-Flash`, `MiniMaxAI/MiniMax-M3.1-Flash`, `deepseek-ai/DeepSeek-V4-Pro-0813`.
Sol has no hooks condition: with Sol the Codex hook never fires (code mode, measured 2026-10-07).

Expected: about 68 attempts and 5–6 h. An attempt stops at 20 min, and the gate still grades it.

Preflight stops the night before any attempt if any of these fail:
- branch is `token-factory`;
- no uncommitted changes outside `apps/angular-demo/src`;
- node, codex, node_modules and `NEBIUS_API_KEY` are present;
- `TASK.md` exists;
- the Docker API answers and all 6 `plata-mcp-*` containers are healthy;
- at least 5 GB of disk is free;
- the levers reset cleanly;
- all 3 TF models and Sol answer a ping.

It only warns about a missing charger or a missing `caffeinate`.

## 2. Start

```bash
./scripts/overnight.sh --preflight-only    # ~2 min, must end with "preflight OK"
caffeinate -i ./scripts/overnight.sh
```
Keep the lid open and the charger in. Closing the lid sleeps a MacBook Air even under caffeinate.

## 3. Recovery

Every attempt is written to `metrics.jsonl` as soon as it ends, so a crash loses at most the attempt
in flight. The script is resumable: finished steps leave `overnight/<step>.done` and are skipped.
**Restarting the same command continues where the night stopped.** Use `--fresh` only to start over.

| Symptom (status.log / step log) | Cause | Fix |
|---|---|---|
| `PREFLIGHT FAIL: Docker API not answering` or `500 … _ping` | Docker Desktop hung | Docker Desktop → Restart, wait for green, rerun |
| `container plata-mcp-X is unhealthy/missing` | MCP mocks down | `docker compose up -d`, wait 30 s, rerun |
| `Token Factory ping: n/3` | key, quota or TF outage | check `.env` key and console.tokenfactory.nebius.com; rerun later |
| `uncommitted changes outside the app` | leftover edits | `git stash` (or commit), rerun |
| `proxy:… failed (try i/4)` in a step log | Docker blip | bench retries 4× / 60 s by itself; if it still fails the step is marked FAILED, rerun later |
| `MCP proxy on :9100 did not become healthy` | proxy build broken | `docker compose logs proxy`; `npm run proxy:reset && npm run proxy:rebuild`; rerun |
| `FAILED stageX (exit n)` | bench crashed | read the end of `overnight/stageX.log`; fix; rerun (finished steps are skipped) |
| many `stopped at the N-minute limit` | agent hangs on a long command (e.g. `npm run start`) | not an error: the gate still grades; report wall time with that caveat |
| step log ends mid-attempt, no FAILED line | Mac slept or the terminal closed | rerun; the partial attempt is not in metrics.jsonl |
| `hook fired 0×` on a hooks attempt | hook not loaded | check `apps/angular-demo/.codex/hooks.json` after `npm run hooks:solution`; exclude that attempt from the hooks row |

Bench rerun after a partial step adds attempts on top of those already recorded. That is fine:
the summary takes medians over all attempts since 2026-11-20 (the first GLM smoke).

## 4. After the night

1. **Did it finish?** `overnight/status.log` should show `preflight OK`, four `done` lines, `summary`
   and `night finished`. For a FAILED step, find the cause in its log (table above) and rerun.
2. **Summary:** `npx tsx e2e/summarize.ts` → `.measurements/overnight-summary.md` (and `.json`).
3. **Sanity checks before you quote any number:**
   - every model × condition has ≥ 3 attempts;
   - tokens are > 0 for every attempt, and for Token Factory runs `tf-relay.jsonl` has rows in each
     attempt's time window;
   - with a pass rate below ~60%, quote cost per passed run, not cost per run;
   - hooks: `codex-hook.jsonl` shows 4–6 fires per hooks attempt (one per MCP call); an attempt with
     0 fires ran without the hook;
   - proxy: MCP results in the step logs are visibly shorter than in baseline;
   - prices: the summary reprices with `CODEX_PRICE` in `e2e/_lib.ts`; check it against the
     provider's price list on the day of the runs;
   - report the spread (min–max per cell), not only the median: per-run cost can vary 2–4×;
   - Sol 6.1 should land near the October Codex numbers (`optimization-catalog.md`): same harness and
     model, so a large gap means a setup difference.
4. **Record:** write the results up like `measurements-2026-11-tf.md` (table, method, findings,
   caveats). `.measurements/` is git-ignored, so the write-up is the only copy in the repo.
