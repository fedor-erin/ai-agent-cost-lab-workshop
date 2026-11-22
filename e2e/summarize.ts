/**
 * Summarize Token Factory bench runs from .measurements/metrics.jsonl.
 *
 *   npx tsx e2e/summarize.ts [--since 2026-11-20]
 *
 * Takes every codex run with a `provider` field recorded since --since (smoke runs included), reprices
 * it with today's CODEX_PRICE (so an attempt recorded at an old price is corrected), groups by
 * model × condition, and writes:
 *   .measurements/overnight-summary.json — machine-readable, one row per model × condition
 *   .measurements/overnight-summary.md   — the same as a table, plus checks
 *
 * Per row: attempts, passes, timed out, median tokens, median $/run, $/passed run (cost of all
 * attempts ÷ passes), median wall s, and the change of median $/run vs that model's baseline.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexCost } from "./_lib.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const MEAS = join(REPO_ROOT, ".measurements");
const i = process.argv.indexOf("--since");
const since = i >= 0 ? process.argv[i + 1] : "2026-11-20";

interface Metric {
  lever?: string; model?: string; provider?: string; attempt?: number; wallMs?: number; timedOut?: boolean;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number; totalCost: number; gatePassed?: boolean;
}

const runs: Array<{ ts: string; m: Metric; cost: number }> = [];
for (const line of readFileSync(join(MEAS, "metrics.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const { ts, metric: m } = JSON.parse(line) as { ts: string; metric: Metric };
  if (ts < since || !m.provider || !m.model) continue;
  const cost = codexCost(m.model, {
    input_tokens: m.inputTokens + m.cacheReadTokens, cached_input_tokens: m.cacheReadTokens, output_tokens: m.outputTokens,
  });
  runs.push({ ts, m, cost });
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};

const ORDER = ["baseline", "hygiene", "proxy", "hooks"];
const groups = new Map<string, typeof runs>();
for (const r of runs) {
  const k = `${r.m.model}|${r.m.lever ?? "baseline"}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

interface Row {
  model: string; provider: string; condition: string; attempts: number; passes: number; timedOut: number;
  medianTokens: number; medianCost: number; costPerPass: number | null; medianWallS: number; vsBaseline: number | null;
}
const rows: Row[] = [...groups.entries()].map(([k, rs]) => {
  const [model, condition] = k.split("|");
  const passes = rs.filter((r) => r.m.gatePassed).length;
  const total = rs.reduce((a, r) => a + r.cost, 0);
  return {
    model, provider: rs[0].m.provider!, condition, attempts: rs.length, passes,
    timedOut: rs.filter((r) => r.m.timedOut).length,
    medianTokens: median(rs.map((r) => r.m.totalTokens)),
    medianCost: median(rs.map((r) => r.cost)),
    costPerPass: passes ? total / passes : null,
    medianWallS: median(rs.map((r) => (r.m.wallMs ?? 0) / 1000)),
    vsBaseline: null,
  };
});
for (const r of rows) {
  const b = rows.find((x) => x.model === r.model && x.condition === "baseline");
  if (b && r !== b) r.vsBaseline = r.medianCost / b.medianCost - 1;
}
rows.sort((a, b) => a.model.localeCompare(b.model) || ORDER.indexOf(a.condition) - ORDER.indexOf(b.condition));

// Checks the morning review must look at; they do not stop the summary.
const checks: string[] = [];
for (const r of rows) {
  if (r.attempts < 3) checks.push(`${r.model} · ${r.condition}: only ${r.attempts} attempt(s) — median is weak`);
  if (r.passes < r.attempts) checks.push(`${r.model} · ${r.condition}: ${r.attempts - r.passes} failed gate`);
  if (r.timedOut > 0) checks.push(`${r.model} · ${r.condition}: ${r.timedOut} stopped at the time limit (wall time inflated)`);
  if (r.medianTokens === 0) checks.push(`${r.model} · ${r.condition}: zero tokens recorded — usage capture broken`);
}
const hookLog = join(MEAS, "codex-hook.jsonl");
const hookLines = existsSync(hookLog) ? readFileSync(hookLog, "utf8").split("\n").filter(Boolean).length : 0;
const hookRuns = runs.filter((r) => r.m.lever === "hooks").length;
if (hookRuns > 0 && hookLines < hookRuns) checks.push(`hooks: ${hookLines} hook fires for ${hookRuns} hooks attempts — some attempts may have run without the hook`);

writeFileSync(join(MEAS, "overnight-summary.json"), JSON.stringify({ since, generated: new Date().toISOString(), rows, checks, hookFires: hookLines }, null, 2) + "\n");

const pct = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`);
const md = [
  `# Token Factory bench summary (runs since ${since})`,
  "",
  "| model | condition | passed | timed out | median tokens | median $/run | $/passed run | vs baseline | median wall s |",
  "|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.model} | ${r.condition} | ${r.passes}/${r.attempts} | ${r.timedOut} | ${Math.round(r.medianTokens / 1000)}K | $${r.medianCost.toFixed(3)} | ${r.costPerPass === null ? "—" : "$" + r.costPerPass.toFixed(3)} | ${pct(r.vsBaseline)} | ${Math.round(r.medianWallS)} |`),
  "",
  "Costs are repriced with the CODEX_PRICE table in e2e/_lib.ts at summary time.",
  "",
  "## Checks",
  ...(checks.length ? checks.map((c) => `- ${c}`) : ["- none"]),
  "",
];
writeFileSync(join(MEAS, "overnight-summary.md"), md.join("\n"));
console.log(md.join("\n"));
