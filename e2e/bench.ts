/**
 * Bench — headless Codex runs over models × conditions × attempts, for the Token Factory comparison.
 *
 *   npm run bench -- --ping --models zai-org/GLM-5.3-Flash                    # connectivity only
 *   npm run bench -- --models zai-org/GLM-5.3-Flash                           # 1 baseline attempt (smoke)
 *   npm run bench -- --models a,b,c --conditions baseline,hygiene,proxy --attempts 5
 *   npm run bench -- --provider openai --models gpt-6.1-sol --effort medium   # vendor reference
 *
 * Provider "tokenfactory" (default) points Codex at https://api.tokenfactory.nebius.com/v1 through
 * `-c model_providers...` overrides and reads NEBIUS_API_KEY from .env. Provider "openai" uses your
 * normal Codex login. Order follows the October runs: attempt 1 of every cell, then attempt 2, …
 * Each attempt is appended to .measurements/metrics.jsonl; a median summary is printed at the end.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetScenario, runCodex, gitUser, SCENARIO, type RunResult } from "./_lib.js";
import { recordWorkshopMetric } from "./metrics.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const APP_DIR = join(REPO_ROOT, "apps", "angular-demo");
const PROMPT = readFileSync(join(REPO_ROOT, "workshop", "facilitator", "PROMPT.md"), "utf8").trim();
const CONDITIONS = { baseline: 1, hygiene: 2, proxy: 3 } as const;
type Condition = keyof typeof CONDITIONS;

const TOKEN_FACTORY_ARGS = [
  "-c", 'model_provider="tokenfactory"',
  "-c", 'model_providers.tokenfactory.name="Nebius Token Factory"',
  "-c", 'model_providers.tokenfactory.base_url="https://api.tokenfactory.nebius.com/v1"',
  "-c", 'model_providers.tokenfactory.env_key="NEBIUS_API_KEY"',
  "-c", 'model_providers.tokenfactory.wire_api="responses"',
];

// ── args ───────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const list = (v: string | undefined): string[] => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const models = list(flag("models"));
const conditions = list(flag("conditions") ?? "baseline") as Condition[];
const attempts = Number(flag("attempts") ?? "1");
const provider = flag("provider") ?? "tokenfactory";
const effort = flag("effort");
const ping = process.argv.includes("--ping");

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (models.length === 0) die("pass --models <id[,id…]>");
for (const c of conditions) if (!(c in CONDITIONS)) die(`unknown condition "${c}" (use ${Object.keys(CONDITIONS).join(", ")})`);
if (!Number.isInteger(attempts) || attempts < 1) die("--attempts must be a positive integer");
if (provider !== "tokenfactory" && provider !== "openai") die('--provider must be "tokenfactory" or "openai"');

try { process.loadEnvFile(join(REPO_ROOT, ".env")); } catch { /* no .env — rely on the shell env */ }
if (provider === "tokenfactory" && !process.env.NEBIUS_API_KEY) die("NEBIUS_API_KEY is empty — put your key into .env");

const codexArgs = [
  "-s", "workspace-write",
  ...(provider === "tokenfactory" ? TOKEN_FACTORY_ARGS : []),
  ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
];

// ── ping: one tiny request per model, outside the repo, no MCP ───────────

if (ping) {
  for (const model of models) {
    console.log(`\n━━━ ping ${provider}:${model} ━━━`);
    try {
      const out = execFileSync("codex", ["exec", "--json", "--skip-git-repo-check", "-m", model, ...codexArgs, "Reply with exactly: PONG"],
        { cwd: tmpdir(), encoding: "utf8", timeout: 120_000, env: process.env });
      console.log(out.trim().split("\n").slice(-3).join("\n"));
    } catch (err: any) {
      console.error(`  ✗ ${String(err?.stderr || err?.message).slice(0, 2000)}`);
    }
  }
  process.exit(0);
}

// ── levers (same npm scripts the workshop uses, pinned to codex) ─────────

if (!existsSync(join(APP_DIR, "TASK.md"))) die("apps/angular-demo/TASK.md missing — run: npm run task -- codex");

function npm(script: string): void {
  execFileSync("npm", ["run", "--silent", script], { cwd: REPO_ROOT, stdio: "inherit", env: { ...process.env, WORKSHOP_AGENT: "codex" } });
}

function resetLevers(rebuildProxy: boolean): void {
  npm("agents:reset");
  npm("hooks:reset");
  npm("proxy:reset");
  if (rebuildProxy) npm("proxy:rebuild");
}

function applyLever(c: Condition): void {
  if (c === "hygiene") npm("agents:solution");
  if (c === "proxy") npm("proxy:solution");
}

/** Same clean-up as workshop-runner: all agent edits in the app, plus the last grade that the
 * testrail/github MCP mocks would report back to the next run. */
function cleanApp(): void {
  execFileSync("git", ["checkout", "--", "apps/angular-demo/src"], { cwd: REPO_ROOT, stdio: "ignore" });
  execFileSync("git", ["clean", "-fdq", "apps/angular-demo/src"], { cwd: REPO_ROOT, stdio: "ignore" });
  const dir = join(REPO_ROOT, ".workshop");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (f.startsWith("agent-fix-run") || f.endsWith(".gate.json")) rmSync(join(dir, f));
}

// ── runs ───────────────────────────────────────────────────────────────

interface Row { model: string; condition: Condition; r: RunResult }
const rows: Row[] = [];

resetLevers(false);
for (let attempt = 1; attempt <= attempts; attempt++) {
  for (const condition of conditions) {
    for (const model of models) {
      console.log(`\n━━━ ${provider}:${model} · ${condition} · attempt ${attempt}/${attempts} ━━━`);
      cleanApp();
      resetScenario();
      applyLever(condition);
      const r = await runCodex(PROMPT, { model, args: codexArgs });
      rows.push({ model, condition, r });
      recordWorkshopMetric({
        run: CONDITIONS[condition], agent: "codex", user: gitUser(), task: SCENARIO, lever: condition,
        model, provider, attempt, wallMs: r.wallMs,
        inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
        cacheReadTokens: r.usage.cacheReadTokens, cacheWriteTokens: r.usage.cacheCreationTokens,
        totalTokens: r.usage.totalTokens, totalCost: r.usage.totalCost, gatePassed: r.gatePassed,
      });
      cleanApp();
      resetScenario();
      resetLevers(condition === "proxy");
    }
  }
}

// ── summary: medians over all attempts; cost per passed run = all cost ÷ passes ──

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length === 0) return 0;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
console.log("\n━━━ SUMMARY ━━━");
console.log("model | condition | passed | median tokens | median $/run | $/passed run | median wall s");
for (const model of models) {
  for (const condition of conditions) {
    const rs = rows.filter((x) => x.model === model && x.condition === condition).map((x) => x.r);
    const passed = rs.filter((r) => r.gatePassed).length;
    const cost = rs.reduce((a, r) => a + r.usage.totalCost, 0);
    console.log([
      model, condition, `${passed}/${rs.length}`,
      `${Math.round(median(rs.map((r) => r.usage.totalTokens)) / 1000)}K`,
      `$${median(rs.map((r) => r.usage.totalCost)).toFixed(3)}`,
      passed ? `$${(cost / passed).toFixed(3)}` : "—",
      `${Math.round(median(rs.map((r) => r.wallMs ?? 0)) / 1000)}`,
    ].join(" | "));
  }
}

// runCodex leaves a 10-minute kill timer per run; exit explicitly instead of waiting for it.
process.exit(0);
