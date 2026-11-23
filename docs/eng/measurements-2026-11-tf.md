# Token Factory measurements — November 2026

Runs from 2026-11-20 to 2026-11-23: smoke runs plus the overnight run of `scripts/overnight.sh`.
- Harness: Codex CLI 0.171 for every model, with Token Factory models going through `e2e/tf-relay.ts`.
- Task: `catalog-pagination`, the same as the October runs.
- Gate: hidden reference tests, tsc and eslint.
- Each attempt is capped at 20 minutes, and an attempt stopped at the cap is still graded.

Prices, $ per 1M tokens (input / cached input / output):
- **Token Factory, as of 2026-11-20:**
  - GLM-5.3-Flash: 0.15 / 0.03 / 0.50
  - MiniMax-M3.1-Flash: 0.15 / 0.015 / 0.60
  - DeepSeek-V4-Pro-0813: 1.32 / 0.04 / 3.96
- **Sol 6.1:** OpenAI API, 2 / 0.10 / 10.

Raw data and the summary script:
- `.measurements/metrics.jsonl`
- `.measurements/tf-relay.jsonl`
- `.measurements/codex-hook.jsonl`
- `npx tsx e2e/summarize.ts`

## Results

Notation:
- "Passed" is passes / attempts.
- "$/run" is the median.
- "$/passed run" is the cost of all attempts divided by the number of passes.
- The range is min–max $/run.

| Model | Condition | Passed | Median tokens | $/run | $/passed run | Range $/run | vs baseline |
|---|---|---|---|---|---|---|---|
| Sol 6.1 (reference) | baseline | 3/3 | 647K | $0.184 | $0.192 | 0.18–0.21 | — |
| | hygiene | 3/3 | 394K | $0.139 | $0.147 | 0.14–0.17 | −24% |
| | proxy | 3/3 | 461K | $0.145 | $0.148 | 0.14–0.16 | −21% |
| DeepSeek-V4-Pro-0813 | baseline | 5/5 | 1266K | $0.294 | $0.269 | 0.10–0.45 | — |
| | hygiene | 4/5 | 930K | $0.164 | $0.220 | 0.13–0.25 | −44% |
| | proxy | 5/5 | 2118K | $0.357 | $0.387 | 0.34–0.49 | +22% |
| | hooks | 5/5 | 1245K | $0.395 | $0.314 | 0.09–0.41 | +34% |
| MiniMax-M3.1-Flash | baseline | 5/5 | 5090K | $0.113 | $0.123 | 0.08–0.18 | — |
| | hygiene | 5/5 | 2121K | $0.047 | $0.050 | 0.04–0.06 | −58% |
| | proxy | 4/5 | 3491K | $0.087 | $0.101 | 0.03–0.12 | −23% |
| | hooks | 5/5 | 4867K | $0.107 | $0.103 | 0.06–0.12 | −5% |
| GLM-5.3-Flash | baseline | 2/5 | 1366K | $0.080 | $0.474 | 0.00–0.63 | — |
| | hygiene | 3/6 | 2968K | $0.134 | $0.468 | 0.00–0.73 | n/a |
| | proxy | 5/6 | 3017K | $0.172 | $0.198 | 0.05–0.25 | n/a |
| | hooks | 4/6 | 1984K | $0.099 | $0.165 | 0.02–0.28 | n/a |

## Findings

1. **Hygiene is the lever that holds across models.** It cuts cost by 44–58% for DeepSeek and MiniMax and by 24% for Sol. For MiniMax every hygiene attempt costs less than every baseline attempt. Sol matches its October direction: hygiene cost −19% then, −24% now; proxy cost −26% then, −21% now.
2. **MCP compaction (proxy, hooks) saves little on Token Factory.** Its effect is within the attempt-to-attempt spread.
   - **Hook fires.** The hook fired in 14 of 15 overnight hooks attempts, 4–6 times each; GLM attempt 2 had 0 fires.
   - **Compression.** It shrinks each MCP result from 37–40K to 1–3K characters, yet peak context drops only ~8K tokens.
   - **Why it saves little.** With 80–97% of input served from cache at $0.015–0.04/MTok, a large MCP result is paid in full once and then cached almost free. Cost follows the number of agent steps, not result size.
   - **Proxy and DeepSeek.** The proxy made DeepSeek take more steps: a median of 25 model requests against 15 in baseline, and 24–32 shell commands against 11–14. The model reads code to recover detail the compact results drop.
3. **GLM-5.3-Flash is unreliable in this harness.** It passed in 14 of 23 attempts, and 8 attempts hit the time limit.
   - In several failed attempts it loops on an unrelated tool: Codex's `codex_apps` `codex_document_control.list_document_sessions`, up to 319 calls in one attempt, with reasoning "Need no.".
   - DeepSeek and MiniMax ignore those tools.
   - Report GLM by $/passed run, with this caveat.
4. **Against the Sol 6.1 reference (baseline $/run):**
   - MiniMax is 39% cheaper ($0.113 vs $0.184).
   - DeepSeek costs 60% more ($0.294) and uses about twice the tokens.
   - GLM is cheapest per attempt, but per passed run it costs $0.474.

## Caveats

- Attempts per row are 3 (Sol), 5 or 6 (Token Factory), so medians move with one outlier. Read DeepSeek proxy and hooks as "no clear saving", not as "+22%" or "+34%".
- Wall time includes agents waiting on long commands such as `npm run start`, so it is a ceiling, not model latency.
- Codex exposes its own apps (`codex_apps`) to every model. A future bench should turn them off so weaker models are not distracted.
