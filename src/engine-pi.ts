import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Pr } from "./github.ts";
import { buildPrompt, type Options, type Result, type Review, reviewSchema } from "./review.ts";

// Second engine: pi (https://pi.dev) with any provider it knows. Same prompt files as the Claude engine.
// Differences: the verify subagent is a pi-subagents custom agent written into the checkout, the schema
// is requested as a fenced JSON block and parsed from the answer, and there is no cost cap, only a timeout.

export type PiModel = { provider: string; model: string };

const THINKING: Record<string, string> = { low: "low", medium: "medium", high: "high" };
const KB_TOOLS = ["rkb_search", "rkb_show"];

export function runReviewPi(
  dir: string,
  pr: Pr,
  o: Options & { pi: PiModel; verifyPi: PiModel },
  timeoutMin = 40,
): Result {
  const kbTools = o.kbDir ? KB_TOOLS : [];
  mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
  writeFileSync(
    join(dir, ".pi", "agents", "verify.md"),
    [
      "---",
      "name: verify",
      "description: Confirms or rejects one candidate finding by reading the code",
      `tools: read, grep, find, ls${kbTools.length ? ", ext:rkb/rkb_search, ext:rkb/rkb_show" : ""}`,
      `model: ${o.verifyPi.provider}/${o.verifyPi.model}`,
      `thinking: ${THINKING[o.effort] ?? "high"}`,
      "max_turns: 30",
      "run_in_background: false",
      "prompt_mode: replace",
      "---",
      "",
      readFileSync(join(o.promptsDir, "verify.md"), "utf8"),
    ].join("\n"),
  );
  const prompt = [
    buildPrompt(pr, o)
      .replace("`rkb_search` tool exists", "`rkb_search` tool exists")
      .replace("`verify` subagent", "`verify` subagent through the `Agent` tool with `run_in_background: false`"),
    "<output>",
    "End your answer with exactly one fenced ```json block that matches this JSON schema. No text after it.",
    JSON.stringify(reviewSchema),
    "</output>",
  ].join("\n\n");
  const t0 = Date.now();
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
      ["read", "grep", "find", "ls", "Agent", ...kbTools].join(","),
      "--provider",
      o.pi.provider,
      "--model",
      o.pi.model,
      "--thinking",
      THINKING[o.effort] ?? "high",
      prompt,
    ],
    {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 256 << 20,
      timeout: timeoutMin * 60_000,
      env: o.kbDir ? { ...process.env, RKB_HOME: o.kbDir, RKB_PROJECT: pr.repo } : process.env,
    },
  );
  if (r.status !== 0) throw new Error(`pi exited ${r.status}: ${(r.stderr ?? "").slice(-2000)}`);
  const { text, cost } = collect(r.stdout);
  const review = lastJson<Review>(text);
  if (!review?.findings) throw new Error(`pi review returned no JSON block:\n${text.slice(-1500)}`);
  review.findings.sort((a, b) => a.severity.localeCompare(b.severity));
  return {
    ...review,
    model: `${o.pi.provider}/${o.pi.model}`,
    effort: o.effort,
    cost_usd: cost,
    seconds: Math.round((Date.now() - t0) / 1000),
    files: pr.files.length,
  };
}

// Final assistant text and the summed cost of every assistant message, from pi's JSONL events.
export function collect(jsonl: string): { text: string; cost: number } {
  let text = "";
  let cost = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: {
      type: string;
      message?: { role: string; content: { type: string; text?: string }[]; usage?: { cost?: { total?: number } } };
    };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant") cost += ev.message.usage?.cost?.total ?? 0;
    if (ev.type === "turn_end" && ev.message) {
      text = ev.message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    }
  }
  return { text, cost };
}

// The last JSON value in the text: a fenced ```json block first, else the last balanced object.
export function lastJson<T>(text: string): T | null {
  const fenced = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].pop();
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  for (let i = text.lastIndexOf("{"); i >= 0; i = text.lastIndexOf("{", i - 1)) {
    const end = text.lastIndexOf("}");
    if (end < i) break;
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch {}
  }
  return null;
}
