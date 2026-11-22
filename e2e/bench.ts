/**
 * Bench — headless Codex runs over models × conditions × attempts, for the Token Factory comparison.
 *
 *   npm run bench -- --ping --models zai-org/GLM-5.3-Flash                    # connectivity only
 *   npm run bench -- --models zai-org/GLM-5.3-Flash                           # 1 baseline attempt (smoke)
 *   npm run bench -- --models a,b,c --conditions baseline,hygiene,proxy --attempts 5
 *   npm run bench -- --provider openai --models gpt-6.1-sol --effort medium   # vendor reference
 *
 * Provider "tokenfactory" (default) starts the local relay (e2e/tf-relay.ts) in this process, points
 * Codex at it through `-c model_providers...` overrides and reads NEBIUS_API_KEY from .env; the relay
 * forwards to https://api.tokenfactory.nebius.com/v1. Provider "openai" uses your normal Codex login. Order follows the October runs: attempt 1 of every cell, then attempt 2, …
 * Each attempt is appended to .measurements/metrics.jsonl; a median summary is printed at the end.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resetScenario, runCodex, codexCost, gitUser, SCENARIO, type RunResult, type Snapshot } from "./_lib.js";
import { recordWorkshopMetric } from "./metrics.js";
import { startRelay } from "./tf-relay.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const APP_DIR = join(REPO_ROOT, "apps", "angular-demo");
const PROMPT = readFileSync(join(REPO_ROOT, "workshop", "facilitator", "PROMPT.md"), "utf8").trim();
const CONDITIONS = { baseline: 1, hygiene: 2, proxy: 3 } as const;
type Condition = keyof typeof CONDITIONS;

/** Token Factory usage as the relay saw it in each response (e2e/tf-relay.ts). */
const RELAY_LOG = join(REPO_ROOT, ".measurements", "tf-relay.jsonl");

/** Codex → local relay → Token Factory. The relay makes MCP tools visible to the model. */
const tokenFactoryArgs = (relayUrl: string): string[] => [
  "-c", 'model_provider="tokenfactory"',
  "-c", 'model_providers.tokenfactory.name="Nebius Token Factory"',
  "-c", `model_providers.tokenfactory.base_url="${relayUrl}"`,
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
// Same limit as the October runs; the gate still grades an agent stopped at the limit.
const timeoutMin = Number(flag("timeout-min") ?? "20");
const ping = process.argv.includes("--ping");

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (models.length === 0) die("pass --models <id[,id…]>");
for (const c of conditions) if (!(c in CONDITIONS)) die(`unknown condition "${c}" (use ${Object.keys(CONDITIONS).join(", ")})`);
if (!Number.isInteger(attempts) || attempts < 1) die("--attempts must be a positive integer");
if (!(timeoutMin > 0)) die("--timeout-min must be a positive number");
if (provider !== "tokenfactory" && provider !== "openai") die('--provider must be "tokenfactory" or "openai"');

try { process.loadEnvFile(join(REPO_ROOT, ".env")); } catch { /* no .env — rely on the shell env */ }
if (provider === "tokenfactory" && !process.env.NEBIUS_API_KEY) die("NEBIUS_API_KEY is empty — put your key into .env");

const relay = provider === "tokenfactory" ? await startRelay({ usageLog: RELAY_LOG }) : undefined;
// Codex ignores a project's .codex/config.toml until the project is trusted. Without it the run uses
// the global MCP servers from `npm run setup`: no auto-approval (every MCP call fails under `exec`)
// and no proxy URLs for the proxy condition.
const trustProject = `projects={"${REPO_ROOT}"={trust_level="trusted"},"${APP_DIR}"={trust_level="trusted"}}`;

const codexArgs = [
  "-s", "workspace-write",
  "-c", trustProject,
  ...(relay ? tokenFactoryArgs(relay.url) : []),
  ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
];

// ── ping: one tiny request per model, outside the repo ───────────────────

if (ping) {
  for (const model of models) {
    console.log(`\n━━━ ping ${provider}:${model} ━━━`);
    try {
      // async: the relay runs in this process and must keep serving while codex waits on it
      const call = promisify(execFile)("codex", ["exec", "--json", "--skip-git-repo-check", "-m", model, ...codexArgs, "Reply with exactly: PONG"],
        { cwd: tmpdir(), encoding: "utf8", timeout: 120_000, env: process.env });
      call.child.stdin?.end(); // codex exec reads extra input from stdin until it closes
      const { stdout } = await call;
      console.log(stdout.trim().split("\n").slice(-3).join("\n"));
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

/** The rebuilt proxy container reports "Started" before it listens. Codex connects to its MCP
 * servers once, at start-up, and drops any that fail — the agent then sees no MCP tools at all. */
async function waitForProxy(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch("http://localhost:9100/health")).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  die("MCP proxy on :9100 did not become healthy in 90 s — check: docker compose logs proxy");
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

/** Token Factory usage the relay logged since `sinceMs` — survives a run that codex never finished. */
function relayUsage(sinceMs: number, model: string): Snapshot | undefined {
  if (!existsSync(RELAY_LOG)) return undefined;
  let input = 0, cached = 0, output = 0, n = 0;
  for (const line of readFileSync(RELAY_LOG, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (Date.parse(e.ts) < sinceMs) continue;
    input += e.usage?.input_tokens ?? 0;
    cached += e.usage?.input_tokens_details?.cached_tokens ?? 0;
    output += e.usage?.output_tokens ?? 0;
    n++;
  }
  if (n === 0) return undefined;
  const nonCached = Math.max(0, input - cached);
  return {
    inputTokens: nonCached, outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: 0,
    totalTokens: nonCached + cached + output,
    totalCost: codexCost(model, { input_tokens: input, cached_input_tokens: cached, output_tokens: output }),
  };
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
      if (condition === "proxy") await waitForProxy();
      const since = Date.now();
      const r = await runCodex(PROMPT, { model, args: codexArgs, timeoutMs: timeoutMin * 60_000 });
      // Token Factory runs: count tokens as Token Factory reported them (also covers timed-out runs)
      const tf = relay ? relayUsage(since, model) : undefined;
      if (tf) r.usage = tf;
      rows.push({ model, condition, r });
      recordWorkshopMetric({
        run: CONDITIONS[condition], agent: "codex", user: gitUser(), task: SCENARIO, lever: condition,
        model, provider, attempt, wallMs: r.wallMs, timedOut: r.timedOut,
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
console.log("model | condition | passed | timed out | median tokens | median $/run | $/passed run | median wall s");
for (const model of models) {
  for (const condition of conditions) {
    const rs = rows.filter((x) => x.model === model && x.condition === condition).map((x) => x.r);
    const passed = rs.filter((r) => r.gatePassed).length;
    const cost = rs.reduce((a, r) => a + r.usage.totalCost, 0);
    console.log([
      model, condition, `${passed}/${rs.length}`, `${rs.filter((r) => r.timedOut).length}`,
      `${Math.round(median(rs.map((r) => r.usage.totalTokens)) / 1000)}K`,
      `$${median(rs.map((r) => r.usage.totalCost)).toFixed(3)}`,
      passed ? `$${(cost / passed).toFixed(3)}` : "—",
      `${Math.round(median(rs.map((r) => r.wallMs ?? 0)) / 1000)}`,
    ].join(" | "));
  }
}

// runCodex leaves a 10-minute kill timer per run; exit explicitly instead of waiting for it.
process.exit(0);
