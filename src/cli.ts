#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkout, fetchPr } from "./github.ts";
import { prepare, render, runReview, type Severity } from "./review.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const usage =
  "usage: rsrobo review owner/repo#N [--model alias] [--verify alias] [--budget usd] [--effort high] [--focus a,b] [--min-severity P2] [--notes dir] [--skills dir] [--json]";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: config.default_model },
    verify: { type: "string", default: config.verify_model },
    budget: { type: "string", default: String(config.default_budget_usd) },
    effort: { type: "string", default: config.effort },
    focus: { type: "string" },
    "min-severity": { type: "string", default: config.min_severity },
    notes: { type: "string", default: process.env.RSROBO_NOTES_DIR },
    skills: { type: "string", default: process.env.RSROBO_SKILLS_DIR },
    json: { type: "boolean", default: false },
  },
});

const [task, target] = positionals;
const m = task === "review" && target ? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(target) : null;
if (!m) fail(usage);
const [, owner, repo, number] = m;
const modelAlias = values.model ?? fail(usage);
const alias = (name: string) =>
  config.models[name] ?? fail(`unknown model alias "${name}"; known: ${Object.keys(config.models).join(", ")}`);

const pr = fetchPr(owner, repo, Number(number));
const dir = checkout(pr, join(root, ".work"));
prepare(dir, pr, values.notes);
const result = runReview(dir, pr, {
  model: alias(modelAlias),
  verifyModel: alias(values.verify ?? modelAlias),
  budgetUsd: Math.min(Number(values.budget), config.max_budget_usd),
  effort: values.effort ?? "high",
  focus: values.focus,
  skillsDir: values.skills,
  promptsDir: join(root, "prompts"),
});
result.alias = modelAlias;
writeFileSync(join(dir, ".rsrobo", "review.json"), JSON.stringify(result, null, 2));
console.log(values.json ? JSON.stringify(result, null, 2) : render(pr, result, values["min-severity"] as Severity));

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
