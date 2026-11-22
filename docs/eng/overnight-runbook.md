# Overnight Token Factory runs — runbook

Two readers: whoever starts the night on the Mac, and Claude reviewing in the morning.
Repo: `~/Documents/Github/ai-agent-cost-lab-workshop`, branch `token-factory`.

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
cd ~/Documents/Github/ai-agent-cost-lab-workshop
git pull                                   # or push, if commits were made here
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

## 4. Morning review (Claude)

Run in the repo through device_bash (`$HOME/mnt/ai-agent-cost-lab-workshop`):

1. **Did the night finish?** Read `overnight/status.log`: expect `preflight OK`, 4 × `done`, `summary`, `night finished`.
   If it is still running, report the current step and its attempt count, then schedule another check.
   If a step FAILED, find the cause in its log (table above) and tell Fedor the exact command to resume.
2. **Recompute:** `npx tsx e2e/summarize.ts` (works in the VM too) → `.measurements/overnight-summary.md`.
3. **Sanity checks** before any slide changes. Stop and report instead of updating if a check fails badly.
   - Every model × condition has ≥ 3 attempts; the TF baseline has 5 and Sol has 3.
   - Gate passes: a row with < 60% passes gets "$/passed run" as the headline, not "$/run".
   - Tokens are > 0 for every attempt.
   - TF tokens come from the relay: `tf-relay.jsonl` has rows inside each attempt's time window.
   - Hooks: `codex-hook.jsonl` has ≥ 4 fires per hooks attempt (one per MCP server called).
   - Relay token growth after the MCP calls is ~1–2K per call with hooks and ~3–10K without.
   - Proxy: MCP results in the step logs are visibly shorter than in baseline.
   - Prices: the summary reprices with `CODEX_PRICE` (DeepSeek $1.32 / $0.04 / $3.96, GLM $0.15 / $0.03 / $0.50, MiniMax $0.15 / $0.015 / $0.60, Sol $2 / $0.10 / $10).
   - Direction: hygiene, proxy and hooks should not raise median *tokens* by more than noise vs baseline. If one does, check whether the attempts timed out or wandered before calling it a result. Report the spread (min–max), not just the median.
   - Sol 6.1 baseline should land near the October Codex numbers (docs/eng/optimization-catalog.md): same harness and model, so a large gap means a setup difference.
4. **Update Notion WIP** (page 9f66ed1efc938376ac9f01c94b0db07e). Fetch it first; the other chat edits it too. Change only TBDs and numbers, keep the wording.
   - Slide 8: Sol 6.1 reference tokens and $/run.
   - Slide 39 and "What we found": TF model results.
   - Slide 43 (Menti 8): the correct answer.
   - Slide 44 table: per model median $/run, tokens, pass rate, and the Sol reference row.
   - Slide 45: team bill and bill split, with prices as of 2026-11-20.
   - Stage 2: slides 13, 25, 27, 33 and 37. These rows were "—" for hooks; now they get real hook numbers for TF models, and Sol stays "hook never fires". Also rewrite the "no hook row" sentences in the experiment paragraph, the hook section and Outcomes: the hook fires for TF models because they call MCP tools directly, and does not fire for Sol (code mode).
5. **Standalone pptx** (`/home/claude/tfdeck/build.js` → outputs):
   - renumber to 43–47;
   - DeepSeek price $1.32 / $0.04 / $3.96;
   - Sol 6.1 reference;
   - numbers from the summary;
   - render, check, send.
6. **Repo record:**
   - write `docs/eng/measurements-2026-11-tf.md` (summary table, method, caveats, spread);
   - commit it with the summary script outputs left out (`.measurements` is ignored);
   - ask Fedor to push.
7. **Consistency pass:**
   - every number in WIP and the pptx matches `overnight-summary.json`;
   - the same number is identical everywhere it appears (slide 8 vs 44 vs 45);
   - percentages are recomputed from medians;
   - the harness is named Codex CLI everywhere;
   - hook claims match the measurements.
8. **Report to Fedor** (SendUserMessage):
   - what ran: attempts, passes, timeouts, failures and recoveries;
   - the headline numbers;
   - what was updated, by slide;
   - checks that failed or look suspicious;
   - what is left for him: push, main deck, Menti.
