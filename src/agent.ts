import { spawnSync } from "node:child_process";
import { collect } from "./engine-pi.ts";

// One headless agent run on either engine, for the tasks that need plain text back: fix, init-notes, ask.
// `review` keeps its own runners because of the schema and the verify subagent.
export type Engine = { engine: "claude"; model: string } | { engine: "pi"; provider: string; model: string };

export type AgentOptions = {
  engine: Engine;
  effort: string;
  budgetUsd: number;
  tools: "read" | "edit";
  kb?: { dir: string; project: string };
  timeoutMin?: number;
};

const THINKING: Record<string, string> = { low: "low", medium: "medium", high: "high" };

export function runAgent(dir: string, prompt: string, o: AgentOptions): { text: string; cost_usd: number } {
  const env = o.kb ? { ...process.env, RKB_HOME: o.kb.dir, RKB_PROJECT: o.kb.project } : process.env;
  const timeout = (o.timeoutMin ?? 40) * 60_000;
  if (o.engine.engine === "claude") {
    const tools = o.tools === "edit" ? "Read,Grep,Glob,Edit,Write" : "Read,Grep,Glob";
    const allowed = [
      ...(o.tools === "edit" ? ["Edit", "Write"] : []),
      ...(o.kb ? ["mcp__rkb__rkb_search", "mcp__rkb__rkb_show"] : []),
    ];
    const r = spawnSync(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--no-session-persistence",
        "--setting-sources",
        "project",
        "--tools",
        tools,
        "--permission-prompts",
        "none",
        "--model",
        o.engine.model,
        "--effort",
        o.effort,
        "--max-budget-usd",
        String(o.budgetUsd),
        ...(o.kb
          ? [
              "--strict-mcp-config",
              "--mcp-config",
              JSON.stringify({ mcpServers: { rkb: { command: "rkb", args: ["mcp"] } } }),
            ]
          : []),
        ...(allowed.length ? ["--allowedTools", ...allowed] : []),
      ],
      { cwd: dir, encoding: "utf8", maxBuffer: 64 << 20, timeout, env },
    );
    if (r.status !== 0) throw new Error(`claude exited ${r.status}: ${(r.stderr ?? "").slice(-2000)}`);
    const out = JSON.parse(r.stdout);
    if (out.is_error) throw new Error(`claude failed: ${out.result}`);
    return { text: String(out.result ?? "").trim(), cost_usd: out.total_cost_usd ?? 0 };
  }
  const tools = [
    "read",
    "grep",
    "find",
    "ls",
    ...(o.tools === "edit" ? ["edit", "write"] : []),
    ...(o.kb ? ["rkb_search", "rkb_show"] : []),
  ];
  const r = spawnSync(
    "pi",
    [
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--approve",
      "--tools",
      tools.join(","),
      "--provider",
      o.engine.provider,
      "--model",
      o.engine.model,
      "--thinking",
      THINKING[o.effort] ?? "high",
      prompt,
    ],
    { cwd: dir, encoding: "utf8", maxBuffer: 256 << 20, timeout, env },
  );
  if (r.status !== 0) throw new Error(`pi exited ${r.status}: ${(r.stderr ?? "").slice(-2000)}`);
  const { text, cost } = collect(r.stdout);
  return { text: text.trim(), cost_usd: cost };
}
