#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkout, fetchPr } from "./github.ts";
import { pruneKb, type Sensitivity } from "./kb.ts";
import { type PostMode, postComment, postInbox, postLessons, postReview } from "./post.ts";
import { prepare, render, runReview, type Severity, saveReview } from "./review.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const usage =
  "usage: rsrobo review owner/repo#N [--model alias] [--verify alias] [--budget usd] [--effort high] [--focus a,b] [--min-severity P2] [--notes dir] [--skills dir] [--post pending|review|inbox|comment] [--save dir] [--kb dir] [--json]";

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
    save: { type: "string", default: process.env.RSROBO_NOTES_DIR },
    kb: { type: "string", default: process.env.RSROBO_KB_DIR },
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
const repoConfig = Object.entries(config.repos as Record<string, { kb?: Sensitivity[] }>).find(([g]) =>
  new RegExp(`^${g.replace(/\*/g, "[^/]*")}$`).test(`${owner}/${repo}`),
)?.[1];
if (values.kb) {
  const { kept, removed } = pruneKb(values.kb, repoConfig?.kb ?? ["public"]);
  console.error(`kb: ${kept} lessons kept, ${removed} removed`);
}
const dir = checkout(pr, join(root, ".work"));
prepare(dir, pr, values.notes);
const result = runReview(dir, pr, {
  model: alias(modelAlias),
  verifyModel: alias(values.verify ?? modelAlias),
  budgetUsd: Math.min(Number(values.budget), config.max_budget_usd),
  effort: values.effort ?? "high",
  focus: values.focus,
  skillsDir: values.skills,
  kbDir: values.kb,
  promptsDir: join(root, "prompts"),
});
writeFileSync(join(dir, ".rsrobo", "review.json"), JSON.stringify(result, null, 2));
const minSeverity = values["min-severity"] as Severity;

if (values.save) saveReview(values.save, pr, result, minSeverity);

// When posting, stdout carries only the URL and the footer: workflow logs on the public hub must not show findings.
if (values.post) {
  const userToken = process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const url = {
    pending: () => postReview(pr, result, patch(), userToken, "pending", minSeverity),
    review: () => postReview(pr, result, patch(), botToken(), "review", minSeverity),
    inbox: () => postInbox(pr, result, userToken, config.inbox_repo),
    comment: () => postComment(pr, result, botToken(), config.bot_login),
  }[values.post as PostMode];
  if (!url) fail(usage);
  const posted = url();
  // Every run also lands in the inbox, so the notes repo keeps a copy of each review.
  const archived = values.post === "inbox" ? posted : postInbox(pr, result, userToken, config.inbox_repo);
  console.log(
    `${posted}\n${archived}\n${result.findings.length} findings, $${result.cost_usd.toFixed(2)}, ${result.seconds}s`,
  );
} else {
  console.log(values.json ? JSON.stringify(result, null, 2) : render(pr, result, minSeverity));
}

function patch() {
  return readFileSync(join(dir, ".rsrobo", "diff.patch"), "utf8");
}
function botToken() {
  return process.env.BOT_TOKEN ?? fail("BOT_TOKEN is not set");
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
