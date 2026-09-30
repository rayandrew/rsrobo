#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkout, fetchPr } from "./github.ts";
import { type PostMode, postComment, postInbox, postPending } from "./post.ts";
import { prepare, render, runReview, type Severity } from "./review.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const usage =
  "usage: rsrobo review owner/repo#N [--model alias] [--verify alias] [--budget usd] [--effort high] [--focus a,b] [--min-severity P2] [--notes dir] [--skills dir] [--post pending|inbox|comment] [--json]";

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
    post: { type: "string" },
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
const minSeverity = values["min-severity"] as Severity;

// When posting, stdout carries only the URL and the footer: workflow logs on the public hub must not show findings.
if (values.post) {
  const userToken = process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const url = {
    pending: () =>
      postPending(pr, result, readFileSync(join(dir, ".rsrobo", "diff.patch"), "utf8"), userToken, minSeverity),
    inbox: () => postInbox(pr, result, userToken, config.inbox_repo),
    comment: () => postComment(pr, result, process.env.BOT_TOKEN ?? fail("BOT_TOKEN is not set"), config.bot_login),
  }[values.post as PostMode];
  if (!url) fail(usage);
  console.log(`${url()}\n${result.findings.length} findings, $${result.cost_usd.toFixed(2)}, ${result.seconds}s`);
} else {
  console.log(values.json ? JSON.stringify(result, null, 2) : render(pr, result, minSeverity));
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
