#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareMd } from "./compare.ts";
import { fixMd, loadFindings, patchApplies, pick, runFix, type Suggestion, suggestions, type Via } from "./fix.ts";
import { checkout, fetchPr } from "./github.ts";
import { pruneKb, type Sensitivity } from "./kb.ts";
import {
  commentInbox,
  type PostMode,
  postComment,
  postInbox,
  postLessons,
  postReview,
  postSuggestions,
} from "./post.ts";
import { prepare, render, runReview, type Severity, saveReview } from "./review.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const usage =
  "usage: rsrobo review owner/repo#N [--model alias] [--verify alias] [--budget usd] [--effort high] [--focus a,b] [--min-severity P2] [--notes dir] [--skills dir] [--post pending|review|inbox|comment] [--save dir] [--kb dir] [--json]\n       rsrobo compare owner/repo#N --models a,b [--effort high] [--budget usd] [--kb dir]\n       rsrobo fix owner/repo#N 2,3|all [--via patch|suggest] [--model alias] [--post]";

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
    via: { type: "string", default: "patch" },
    work: { type: "string", default: process.env.RSROBO_WORK_DIR ?? join(root, ".work") },
  },
});

const [task, target] = positionals;
const m =
  ["review", "compare", "fix"].includes(task ?? "") && target ? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(target) : null;
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

// fix: apply chosen findings from the latest saved review, deliver as a patch or as suggestion blocks.
if (task === "fix") {
  const spec = positionals[2] ?? fail(usage);
  const via = values.via as Via;
  if (!["patch", "suggest"].includes(via)) fail(usage);
  const dir = checkout(pr, values.work);
  prepare(dir, pr, values.notes);
  const saved = loadFindings(pr, values.save || undefined, dir);
  const prPatch = readFileSync(join(dir, ".rsrobo", "diff.patch"), "utf8");
  const chosen = pick(saved, spec);
  const parts: string[] = [];
  let comments: Suggestion[] = [];
  let leftover = 0;
  for (const f of chosen) {
    const { patch, note } = runFix(dir, pr, f, {
      model: alias(modelAlias),
      budgetUsd: Math.min(Number(values.budget), config.max_budget_usd),
      promptsDir: join(root, "prompts"),
    });
    execFileSync("git", ["-C", dir, "checkout", "-q", "--", "."]);
    execFileSync("git", ["-C", dir, "clean", "-qfd", "-e", ".rsrobo", "-e", "CLAUDE.md", "-e", ".claude"]);
    const applies = patchApplies(dir, patch);
    parts.push(fixMd(pr, f, patch, note, applies));
    if (via === "suggest" && applies) {
      const s = suggestions(prPatch, patch);
      comments = comments.concat(s.comments);
      leftover += s.leftover;
    }
  }
  const body = parts.join("\n\n---\n\n");
  if (!values.post) {
    console.log(body);
    process.exit(0);
  }
  const userToken = process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const urls = [commentInbox(pr, userToken, config.inbox_repo, body)];
  if (via === "suggest" && comments.length) {
    const note = leftover
      ? ` ${leftover} hunk${leftover === 1 ? "" : "s"} outside the diff or too large; see the inbox patch.`
      : "";
    urls.push(
      postSuggestions(
        pr,
        userToken,
        comments,
        `${comments.length} suggestion${comments.length === 1 ? "" : "s"} from rsrobo fix.${note}`,
      ),
    );
  }
  console.log(urls.filter(Boolean).join("\n"));
  process.exit(0);
}
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
