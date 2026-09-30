#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareMd } from "./compare.ts";
import { checkout, fetchPr } from "./github.ts";
import { pruneKb, type Sensitivity } from "./kb.ts";
import { type PostMode, postComment, postInbox, postLessons, postReview } from "./post.ts";
import { prepare, render, runReview, type Severity, saveReview } from "./review.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const usage =
  "usage: rsrobo review owner/repo#N [--model alias] [--verify alias] [--budget usd] [--effort high] [--focus a,b] [--min-severity P2] [--notes dir] [--skills dir] [--post pending|review|inbox|comment] [--save dir] [--kb dir] [--json]\n       rsrobo compare owner/repo#N --models a,b [--effort high] [--budget usd] [--kb dir]";

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
    models: { type: "string" },
    work: { type: "string", default: process.env.RSROBO_WORK_DIR ?? join(root, ".work") },
  },
});

const [task, target] = positionals;
const m = (task === "review" || task === "compare") && target ? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(target) : null;
if (!m) fail(usage);
const [, owner, repo, number] = m;

// compare: one child review per model, each in its own work dir, then one comparison table.
if (task === "compare") {
  const aliases = (values.models ?? fail("compare needs --models a,b")).split(",");
  const settled = await Promise.allSettled(
    aliases.map(async (alias) => {
      const args = [process.argv[1], "review", target, "--model", alias, "--json", "--save", ""];
      if (values.effort) args.push("--effort", values.effort);
      if (values.budget) args.push("--budget", values.budget);
      if (values.kb) args.push("--kb", values.kb);
      const env = { ...process.env, RSROBO_WORK_DIR: join(values.work, `compare-${alias}`), RSROBO_NOTES_DIR: "" };
      const out = await new Promise<string>((ok, no) => {
        const c = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "inherit"] });
        let s = "";
        c.stdout.on("data", (d) => {
          s += d;
        });
        c.on("close", (code) => (code === 0 ? ok(s) : no(new Error(`${alias}: review exited ${code}`))));
      });
      return { alias, result: JSON.parse(out) };
    }),
  );
  const runs = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  for (const s of settled) if (s.status === "rejected") console.error(String(s.reason));
  if (!runs.length) fail("every model failed");
  console.log(compareMd(fetchPr(owner, repo, Number(number)), runs));
  process.exit(0);
}
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
const dir = checkout(pr, values.work);
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
