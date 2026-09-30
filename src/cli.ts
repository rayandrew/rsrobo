#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Engine } from "./agent.ts";
import { askRepo, decorate } from "./ask.ts";
import { type BenchRun, benchMd, lastRun, loadCases, saveRun, score } from "./bench.ts";
import { ciReport } from "./ci.ts";
import { compareMd } from "./compare.ts";
import { runReviewPi } from "./engine-pi.ts";
import {
  deliverCommit,
  fixMd,
  loadFindings,
  patchApplies,
  pick,
  runFix,
  type Suggestion,
  suggestions,
  type Via,
} from "./fix.ts";
import { runGate } from "./gate.ts";
import { checkout, cloneDefault, fetchPr } from "./github.ts";
import { pruneKb, type Sensitivity } from "./kb.ts";
import { ledger, ledgerMd } from "./ledger.ts";
import { addLessons, kbProject } from "./lessons.ts";
import {
  commentInbox,
  type PostMode,
  postComment,
  postInbox,
  postLessons,
  postReview,
  postSuggestions,
} from "./post.ts";
import { relatedReport } from "./related.ts";
import {
  initNotes,
  type Previous,
  prepare,
  type Result,
  reconcile,
  render,
  runReview,
  type Severity,
  saveReview,
} from "./review.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
const usage = [
  "usage: rsrobo review owner/repo#N [--model alias] [--verify alias] [--budget usd] [--effort high] [--focus a,b] [--min-severity P2] [--notes dir] [--skills dir] [--post pending|review|inbox|comment] [--save dir] [--kb dir] [--json]",
  "       rsrobo compare owner/repo#N --models a,b [--effort high] [--budget usd] [--kb dir]",
  "       rsrobo fix owner/repo#N 2,3|all [--via patch|suggest|stacked|push] [--model alias] [--post]",
  "       rsrobo init-notes owner/repo [--notes dir] [--force]",
  '       rsrobo ask owner/repo "question" [--issue N --post] [--model alias] [--kb dir]',
  "       rsrobo summarize|triage owner/repo --issue N [--post] [--model alias]",
  "       rsrobo lessons <review.json> --kb-write dir [--post]",
  "       rsrobo bench [--model alias] [--save notes] [--kb dir]",
  "       rsrobo ledger [--save notes]",
  "       rsrobo models",
].join("\n");

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
    "kb-write": { type: "string", default: process.env.RSROBO_KB_WRITE_DIR },
    json: { type: "boolean", default: false },
    models: { type: "string" },
    via: { type: "string", default: "patch" },
    force: { type: "boolean", default: false },
    requester: { type: "string" },
    issue: { type: "string" },
    work: { type: "string", default: process.env.RSROBO_WORK_DIR ?? join(root, ".work") },
  },
});

const [task, target] = positionals;

// models: the aliases, then every model pi offers from an allowed provider, as `provider/model`.
if (task === "models") {
  for (const [name, m] of Object.entries(
    config.models as Record<string, string | { provider: string; model: string }>,
  )) {
    console.log(`${name.padEnd(12)} ${typeof m === "string" ? `claude ${m}` : `pi ${m.provider}/${m.model}`}`);
  }
  const list = execFileSync("pi", ["--list-models"], { encoding: "utf8" }).split("\n").slice(1);
  for (const line of list) {
    const [provider, model] = line.trim().split(/\s+/);
    if (provider && model && config.pi_providers.includes(provider))
      console.log(`${"".padEnd(12)} pi ${provider}/${model}`);
  }
  process.exit(0);
}
// An alias is a Claude model id string, or `{ engine: "pi", provider, model }` for the pi engine.
// Besides aliases, `provider/model` is accepted for the providers in `pi_providers`, so any model pi knows works.
const resolve = (name: string): Engine => {
  const m = config.models[name];
  if (typeof m === "string") return { engine: "claude", model: m };
  if (m) return { engine: "pi", ...m };
  const pm = /^([\w-]+)\/(.+)$/.exec(name);
  if (pm && (config.pi_providers as string[]).includes(pm[1])) return { engine: "pi", provider: pm[1], model: pm[2] };
  return fail(
    `unknown model "${name}"; aliases: ${Object.keys(config.models).join(", ")}; or provider/model with provider in ${config.pi_providers.join(", ")}`,
  );
};
type Policy = { kb?: Sensitivity[]; fix?: Via[]; providers?: string[] };
const repoPolicy = (owner: string, repo: string): Policy | undefined =>
  Object.entries(config.repos as Record<string, Policy>).find(([g]) =>
    new RegExp(`^${g.replace(/\*/g, "[^/]*")}$`).test(`${owner}/${repo}`),
  )?.[1];
// Per-repo provider policy: LLNL work must not go to Chinese-origin models, so freeinference is off there.
const allowedEngine = (e: Engine, owner: string, repo: string): Engine => {
  const provider = e.engine === "claude" ? "claude" : e.provider;
  const allowed = repoPolicy(owner, repo)?.providers ?? ["claude", ...config.pi_providers];
  if (!allowed.includes(provider))
    fail(`provider ${provider} is not allowed on ${owner}/${repo}; allowed: ${allowed.join(", ")}`);
  return e;
};
const alias = (name: string): string => {
  const e = resolve(name);
  if (e.engine !== "claude") fail(`alias "${name}" runs on pi; this task needs a Claude alias`);
  return e.model;
};

// init-notes: draft <notes>/<owner>/<repo>/CLAUDE.md from the default branch. Never overwrites without --force.
// ask: answer a question about the default branch; --issue N posts the answer there as the bot and copies it to the inbox.
if (task === "ask" || task === "summarize" || task === "triage") {
  const rm = target ? /^([\w.-]+)\/([\w.-]+)$/.exec(target) : null;
  const canned: Record<string, string> = { summarize: "Summarize this pull request.", triage: "Triage this issue." };
  const question = positionals[2] ?? canned[task] ?? "";
  if (!rm || !question) fail(usage);
  if (task !== "ask" && !values.issue) fail(`${task} needs --issue N`);
  const [, owner, repo] = rm;
  const dir = cloneDefault(owner, repo, values.work);
  prepare(dir, { owner, repo } as Parameters<typeof prepare>[1], values.notes);
  if (values.kb) pruneKb(values.kb, repoPolicy(owner, repo)?.kb ?? ["public", "internal"]);
  const engine = allowedEngine(
    resolve(values.model === config.default_model ? config.ask_model : (values.model ?? config.ask_model)),
    owner,
    repo,
  );
  const { md, cost_usd, seconds, issue } = askRepo(dir, owner, repo, question, {
    issue: values.issue ? Number(values.issue) : undefined,
    engine: allowedEngine(
      resolve(values.model === config.default_model ? config.ask_model : (values.model ?? config.ask_model)),
      owner,
      repo,
    ),
    budgetUsd: Math.min(Number(values.budget), config.max_budget_usd),
    effort: values.effort ?? "medium",
    promptsDir: join(root, "prompts"),
    kbDir: values.kb,
    mode: task,
  });
  const body = decorate(md, {
    mode: task,
    question,
    model: engine.model,
    cost_usd,
    seconds,
    requester: values.requester,
    issue,
  });
  if (values.issue && values.post) {
    const userToken = process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    const url = `repos/${owner}/${repo}/issues/${values.issue}/comments`;
    const res = JSON.parse(
      execFileSync("gh", ["api", "-X", "POST", url, "-f", `body=${body}`], {
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: botToken() },
      }),
    ) as { html_url: string };
    execFileSync(
      "gh",
      [
        "api",
        "-X",
        "POST",
        `repos/${config.inbox_repo}/issues`,
        "-f",
        `title=rsrobo: ask on ${owner}/${repo}#${values.issue}`,
        "-f",
        `body=${res.html_url}\n\n${body}`,
        "-f",
        "labels[]=rsrobo",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: userToken },
      },
    );
    console.log(res.html_url);
  } else console.log(body);
  process.exit(0);
}

if (task === "init-notes") {
  const rm = target ? /^([\w.-]+)\/([\w.-]+)$/.exec(target) : null;
  if (!rm) fail(usage);
  const [, owner, repo] = rm;
  const dir = cloneDefault(owner, repo, values.work);
  const { md, cost_usd } = initNotes(dir, {
    engine: allowedEngine(resolve(values.model ?? fail(usage)), owner, repo),
    budgetUsd: Math.min(Number(values.budget), config.max_budget_usd),
    promptsDir: join(root, "prompts"),
  });
  if (values.notes) {
    const out = join(values.notes, owner, repo, "CLAUDE.md");
    if (existsSync(out) && !values.force) fail(`${out} exists; pass --force to overwrite`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    console.log(`${out}\n$${cost_usd.toFixed(2)}`);
  } else console.log(md);
  process.exit(0);
}
// One review in a child process with its own work dir and no saving; compare and bench fan out over it.
function childReview(prTarget: string, alias: string, workName: string): Promise<Result> {
  const args = [process.argv[1], "review", prTarget, "--model", alias, "--json", "--save", ""];
  if (values.effort) args.push("--effort", values.effort);
  if (values.budget) args.push("--budget", values.budget);
  if (values.kb) args.push("--kb", values.kb);
  const env = { ...process.env, RSROBO_WORK_DIR: join(values.work, workName), RSROBO_NOTES_DIR: "" };
  return new Promise((ok, no) => {
    const c = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "inherit"] });
    let s = "";
    c.stdout.on("data", (d) => {
      s += d;
    });
    c.on("close", (code) =>
      code === 0 ? ok(JSON.parse(s)) : no(new Error(`${alias} on ${prTarget}: review exited ${code}`)),
    );
  });
}

// bench: every case in <notes>/bench/cases.json through one model, scored against the expected defects.
if (task === "bench") {
  const notes = values.save || fail("bench needs --save <notes dir> (or RSROBO_NOTES_DIR)");
  const cases = loadCases(notes);
  const alias = values.model ?? config.default_model;
  const date = new Date().toISOString();
  const settled = await Promise.allSettled(
    cases.map((c) => childReview(c.pr, alias, `bench-${c.pr.replace(/[^\w]/g, "_")}`)),
  );
  const run: BenchRun = {
    date,
    model: resolve(alias).model,
    effort: values.effort ?? "high",
    cases: cases.flatMap((c, i) => {
      const s = settled[i];
      if (s.status === "rejected") {
        console.error(String(s.reason));
        return [];
      }
      return [score(c, s.value)];
    }),
  };
  if (!run.cases.length) fail("every case failed");
  const file = saveRun(notes, run);
  console.log(benchMd(run, lastRun(notes, run.model, date)));
  console.error(file);
  process.exit(0);
}

// lessons: write the lessons of one saved review into the kb through rkb, and log ids in the inbox. The workflow
// runs it in its own job under a concurrency group, so only one runner writes the kb at a time.
if (task === "lessons") {
  const file = target ?? fail(usage);
  const kbWrite = values["kb-write"] ?? fail("lessons needs --kb-write <unpruned kb clone>");
  const saved = JSON.parse(readFileSync(file, "utf8")) as Result & { pr: string };
  const m2 = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(saved.pr) ?? fail(`no PR url in ${file}`);
  const lessons = saved.lessons ?? [];
  if (!lessons.length) {
    console.log("no lessons");
    process.exit(0);
  }
  const written = addLessons(kbWrite, lessons, kbProject(kbWrite, m2[1], m2[2]), saved.pr);
  const lines = lessons.map((l) => {
    const w = written.find((a) => a.title === l.title);
    const state = w?.id ? `written as ${w.id}` : w?.skipped ? `exists as ${w.skipped}` : `refused: ${w?.error ?? "?"}`;
    return `${l.type}: ${l.title} (${state})`;
  });
  const sync = written.find((a) => a.title === "rkb sync");
  if (sync) lines.push(`rkb sync failed: ${sync.error}`);
  console.log(lines.join("\n"));
  if (values.post) {
    const userToken = process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    postLessons(fetchPr(m2[1], m2[2], Number(m2[3])), lines, userToken, config.inbox_repo);
  }
  process.exit(0);
}

// ledger: monthly cost per repo and model from the saved reviews, written to <notes>/ledger.md.
if (task === "ledger") {
  const notes = values.save || fail("ledger needs --save <notes dir> (or RSROBO_NOTES_DIR)");
  const md = ledgerMd(ledger(notes));
  writeFileSync(join(notes, "ledger.md"), md);
  console.log(md);
  process.exit(0);
}

const m =
  ["review", "compare", "fix"].includes(task ?? "") && target ? /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(target) : null;
if (!m) fail(usage);
const [, owner, repo, number] = m;

// compare: one child review per model, each in its own work dir, then one comparison table.
if (task === "compare") {
  const aliases = (values.models ?? fail("compare needs --models a,b")).split(",");
  const settled = await Promise.allSettled(
    aliases.map(async (alias) => ({ alias, result: await childReview(target, alias, `compare-${alias}`) })),
  );
  const runs = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
  for (const s of settled) if (s.status === "rejected") console.error(String(s.reason));
  if (!runs.length) fail("every model failed");
  console.log(compareMd(fetchPr(owner, repo, Number(number)), runs));
  process.exit(0);
}
const modelAlias = values.model ?? fail(usage);

const pr = fetchPr(owner, repo, Number(number));
const repoConfig = repoPolicy(owner, repo);

// fix: apply chosen findings from the latest saved review, deliver as a patch or as suggestion blocks.
if (task === "fix") {
  const spec = positionals[2] ?? fail(usage);
  const via = values.via as Via;
  if (!["patch", "suggest", "stacked", "push"].includes(via)) fail(usage);
  const allowedVia: Via[] = repoConfig?.fix ?? ["patch", "suggest", "stacked", "push"];
  if (!allowedVia.includes(via))
    fail(`via=${via} is not allowed on ${owner}/${repo}; allowed: ${allowedVia.join(", ")}`);
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
      engine: allowedEngine(resolve(modelAlias), owner, repo),
      budgetUsd: Math.min(Number(values.budget), config.max_budget_usd),
      promptsDir: join(root, "prompts"),
    });
    const reset = () => {
      execFileSync("git", ["-C", dir, "checkout", "-q", "--", "."]);
      execFileSync("git", ["-C", dir, "clean", "-qfd", "-e", ".rsrobo", "-e", "CLAUDE.md", "-e", ".claude"]);
    };
    reset();
    const applies = patchApplies(dir, patch);
    let extra = "";
    if ((via === "stacked" || via === "push") && applies) {
      execFileSync("git", ["-C", dir, "apply", "-"], { input: patch });
      const gate = runGate(dir);
      reset();
      extra = `Gate: ${gate.status}${gate.command ? ` (\`${gate.command}\`)` : ""}.`;
      if (gate.status === "fail") {
        extra += `\n\n\`\`\`text\n${gate.output.trim().split("\n").slice(-40).join("\n")}\n\`\`\``;
      } else if (values.post) {
        const token = process.env.GH_TOKEN ?? execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
        const n = f.n ?? 0;
        extra += ` Delivered: ${deliverCommit(dir, pr, f, n, patch, via, token, config.commit_trailer)}`;
        execFileSync("git", ["-C", dir, "checkout", "-q", pr.head]);
      }
    }
    parts.push([fixMd(pr, f, patch, note, applies), extra].filter(Boolean).join("\n\n"));
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
  // The fix report goes to the notes repo beside the review; the run summary prints its path.
  const urls: (string | null)[] = [];
  if (values.save) {
    const dir2 = join(values.save, "reviews", pr.owner, pr.repo, String(pr.number));
    mkdirSync(dir2, { recursive: true });
    const file = join(
      dir2,
      `fix-${spec.replace(/[^\w]/g, "_")}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`,
    );
    writeFileSync(file, `${pr.html_url} at ${pr.head}\n\n${body}\n`);
    urls.push(file);
  } else urls.push(commentInbox(pr, userToken, config.inbox_repo, body));
  if (via === "suggest" && comments.length) {
    const note = leftover
      ? ` ${leftover} hunk${leftover === 1 ? "" : "s"} outside the diff or too large; see the fix file in the notes repo.`
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
if (values.kb) {
  const { kept, removed } = pruneKb(values.kb, repoConfig?.kb ?? ["public", "internal"]);
  console.error(`kb: ${kept} lessons kept, ${removed} removed`);
}
const dir = checkout(pr, values.work);
prepare(dir, pr, values.notes);
for (const [name, make] of [
  ["ci.md", () => ciReport(pr)],
  ["related.md", () => relatedReport(pr, dir)],
] as const) {
  try {
    writeFileSync(join(dir, ".rsrobo", name), make());
  } catch (e) {
    console.error(`${name}: ${(e as Error).message.split("\n")[0]}`);
  }
}
const engine = resolve(modelAlias);
const verifyEngine = resolve(values.verify ?? modelAlias);
for (const e of [engine, verifyEngine]) allowedEngine(e, owner, repo);
// A re-review: load the last saved review of this PR, and write the diff since its head when there is one.
let previous: Previous | undefined;
try {
  const last = loadFindings(pr, values.save || undefined, dir);
  if (last.findings.every((f) => f.n === undefined)) {
    for (const [i, f] of last.findings.entries()) f.n = i + 1;
  }
  previous = { head: (last as { head?: string }).head ?? pr.head, findings: last.findings };
  if (previous.head !== pr.head) {
    execFileSync("git", ["-C", dir, "fetch", "-q", "origin", previous.head]);
    writeFileSync(
      join(dir, ".rsrobo", "since-last.patch"),
      execFileSync("git", ["-C", dir, "diff", `${previous.head}..${pr.head}`], {
        encoding: "utf8",
        maxBuffer: 256 << 20,
      }),
    );
  }
} catch {
  previous = undefined;
}
const common = {
  previous,
  budgetUsd: Math.min(Number(values.budget), config.max_budget_usd),
  effort: values.effort ?? "high",
  focus: values.focus,
  skillsDir: values.skills,
  kbDir: values.kb,
  promptsDir: join(root, "prompts"),
};
const result =
  engine.engine === "pi"
    ? runReviewPi(dir, pr, {
        ...common,
        model: engine.model,
        verifyModel: engine.model,
        pi: engine,
        verifyPi: verifyEngine.engine === "pi" ? verifyEngine : engine,
      })
    : runReview(dir, pr, { ...common, model: engine.model, verifyModel: alias(values.verify ?? modelAlias) });
reconcile(previous, result);
if (values.requester) result.requester = values.requester;
writeFileSync(join(dir, ".rsrobo", "review.json"), JSON.stringify(result, null, 2));
const minSeverity = values["min-severity"] as Severity;

const savedFile = values.save ? saveReview(values.save, pr, result, minSeverity) : "(not saved)";

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
  // The notes repo keeps the copy of each review; an inbox issue exists only when `post=inbox` asks for one.
  const archived = savedFile;
  // Lessons are written into the kb by `rsrobo lessons` in a separate, serialized job; here they are proposed.
  if (result.lessons.length) {
    postLessons(
      pr,
      result.lessons.map((l) => `${l.type}: ${l.title} (proposed)`),
      userToken,
      config.inbox_repo,
    );
  }
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
