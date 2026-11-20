/**
 * Token Factory relay — a local HTTP hop between Codex and Token Factory's Responses API.
 *
 * Why: Codex sends every MCP server's tools as ONE `{ type: "namespace", name: "mcp__jira", tools: [...] }`
 * entry and expects calls back as `{ type: "function_call", namespace: "mcp__jira", name: "jira_get_issue" }`.
 * Token Factory ignores namespace entries, so without this relay the model never sees the MCP tools.
 *
 * Request:  each namespace → plain function tools named `<namespace>__<tool>`; history items that
 *           carry a `namespace` get the same flat name.
 * Response: every `function_call` whose flat name came from a namespace gets `namespace` + `name` back
 *           (streamed SSE and plain JSON).
 * Usage:    every completed response's `usage` is appended to .measurements/tf-relay.jsonl — the token
 *           counts as Token Factory reported them, independent of Codex.
 */
import { createServer, type Server } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AddressInfo } from "node:net";

export const TF_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

type Json = Record<string, any>;
type NameMap = Map<string, { namespace: string; name: string }>;

const SEP = "__";

/** Flatten namespace tools and namespaced history items in place; return flat name → original. */
export function flattenRequest(body: Json): NameMap {
  const map: NameMap = new Map();
  if (Array.isArray(body.tools)) {
    body.tools = body.tools.flatMap((t: Json) => {
      if (t?.type !== "namespace" || !Array.isArray(t.tools)) return [t];
      return t.tools.map((fn: Json) => {
        const flat = `${t.name}${SEP}${fn.name}`;
        map.set(flat, { namespace: t.name, name: fn.name });
        return { ...fn, name: flat };
      });
    });
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.namespace && typeof item.name === "string") {
        const flat = `${item.namespace}${SEP}${item.name}`;
        map.set(flat, { namespace: item.namespace, name: item.name });
        item.name = flat;
        delete item.namespace;
      }
    }
  }
  return map;
}

/** Restore `namespace` + `name` on function_call items anywhere inside a response object. */
export function restoreNames(obj: unknown, map: NameMap): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) { for (const x of obj) restoreNames(x, map); return; }
  const o = obj as Json;
  if (o.type === "function_call" && typeof o.name === "string" && map.has(o.name)) {
    const orig = map.get(o.name)!;
    o.namespace = orig.namespace;
    o.name = orig.name;
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") restoreNames(v, map);
}

/** Rewrite one SSE event block (`event: …\ndata: {…}`); also report its usage, if any. */
function rewriteEvent(block: string, map: NameMap, onUsage: (u: Json, model?: string) => void): string {
  return block.split("\n").map((line) => {
    if (!line.startsWith("data:")) return line;
    const raw = line.slice(5).trim();
    if (!raw.startsWith("{")) return line;
    try {
      const data = JSON.parse(raw);
      restoreNames(data, map);
      if (data.type === "response.completed" && data.response?.usage) onUsage(data.response.usage, data.response.model);
      return `data: ${JSON.stringify(data)}`;
    } catch {
      return line;
    }
  }).join("\n");
}

export interface Relay { url: string; close: () => Promise<void> }

/** Start the relay on 127.0.0.1 (random port). Codex points `base_url` at `relay.url`. */
export function startRelay(opts: { upstream?: string; usageLog?: string } = {}): Promise<Relay> {
  const upstream = (opts.upstream ?? process.env.TF_UPSTREAM ?? TF_BASE_URL).replace(/\/$/, "");
  const logUsage = (u: Json, model?: string): void => {
    if (!opts.usageLog) return;
    try {
      mkdirSync(dirname(opts.usageLog), { recursive: true });
      appendFileSync(opts.usageLog, JSON.stringify({ ts: new Date().toISOString(), model, usage: u }) + "\n");
    } catch { /* logging is best-effort */ }
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let payload: string | undefined = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
      let map: NameMap = new Map();
      let model: string | undefined;
      if (payload && (req.headers["content-type"] ?? "").includes("json")) {
        const body = JSON.parse(payload);
        model = body.model;
        map = flattenRequest(body);
        payload = JSON.stringify(body);
      }

      const headers: Record<string, string> = { "accept-encoding": "identity" };
      for (const h of ["authorization", "content-type", "accept", "openai-beta"]) {
        const v = req.headers[h];
        if (typeof v === "string") headers[h] = v;
      }
      const up = await fetch(upstream + (req.url ?? "").replace(/^\/v1/, ""), { method: req.method, headers, body: payload });

      const type = up.headers.get("content-type") ?? "";
      res.writeHead(up.status, { "content-type": type || "application/octet-stream" });
      if (!up.body) { res.end(); return; }

      if (type.includes("text/event-stream")) {
        const decoder = new TextDecoder();
        let buf = "";
        for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            res.write(rewriteEvent(buf.slice(0, i), map, (u, m) => logUsage(u, m ?? model)) + "\n\n");
            buf = buf.slice(i + 2);
          }
        }
        if (buf) res.write(rewriteEvent(buf, map, (u, m) => logUsage(u, m ?? model)));
        res.end();
      } else {
        const text = await up.text();
        try {
          const data = JSON.parse(text);
          restoreNames(data, map);
          if (data?.usage && data?.object === "response") logUsage(data.usage, data.model ?? model);
          res.end(JSON.stringify(data));
        } catch {
          res.end(text);
        }
      }
    } catch (err: any) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `tf-relay: ${err?.message ?? err}` } }));
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}
