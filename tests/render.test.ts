import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Pr } from "../src/github.ts";
import { blocking, mergePass, missedFiles, type Result, render, saveReview } from "../src/review.ts";

const pr: Pr = {
  owner: "o",
  repo: "r",
  number: 7,
  title: "t",
  body: "",
  base: "b".repeat(40),
  head: "a".repeat(40),
  html_url: "https://github.com/o/r/pull/7",
  head_ref: "feat",
  head_repo: "o/r",
  author: "me",
  people: { contributors: ["me"], commenters: [], reviewers: [] },
  commits: [],
  files: [],
};
const result: Result = {
  map: "One file.",
  changes: [{ area: "y.py", change: "adds a thing" }],
  skipped: ["gen.pb.go: generated"],
  lessons: [],
  findings: [
    {
      file: "x.py",
      line_start: 3,
      line_end: 4,
      severity: "P3",
      title: "minor",
      problem: "See `x.py:3-4`.",
      evidence: [],
      fix: "none",
    },
    {
      file: "y.py",
      line_start: 10,
      line_end: 12,
      severity: "P1",
      title: "wrong",
      problem: "w",
      evidence: ["`y.py:10` does a", "`y.py:12` does b"],
      fix: "swap them",
      suggested_patch: "--- a\n+++ b\n",
      n: 2,
    },
  ],
  model: "claude-sonnet-5-5",
  effort: "high",
  cost_usd: 0.123,
  seconds: 9,
  files: 2,
};

test("render links, filters, and footer", () => {
  const md = render(pr, result, "P2");
  assert.match(
    md,
    /> \[!CAUTION\]\n> \*\*Needs changes\.\*\* 1 finding in 2 files\. `claude-sonnet-5-5` at high effort, \$0\.12, 0 min\./,
  );
  assert.match(md, /- \[`y\.py:10`\]\(https:[^)]+#L10-L10\) does a\n- \[`y\.py:12`\][^\n]*does b/);
  assert.match(md, /\| `y\.py` \| adds a thing \|/);
  assert.match(md, /Copy-paste text for an agent/);
  assert.match(md, /\| P1 \| \[y\.py:10-12\]\(https:\/\/github\.com\/o\/r\/blob\/a{40}\/y\.py#L10-L12\) \| wrong \|/);
  assert.doesNotMatch(md, /\*\*P3 minor\*\*/);
  assert.match(md, /<summary>Suggested fix<\/summary>[\s\S]*```diff\n--- a\n\+\+\+ b\n```/);
});

test("code refs in prose become links", () => {
  const md = render(pr, result);
  assert.match(md, /See \[`x\.py:3-4`\]\(https:\/\/github\.com\/o\/r\/blob\/a{40}\/x\.py#L3-L4\)\./);
});

test("render with no findings", () => {
  assert.match(render(pr, { ...result, findings: [] }), /> \[!TIP\]\n> \*\*Looks good\.\*\* No findings in 2 files/);
});

test("saveReview writes one md and one json per run in the PR folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsrobo-"));
  const a = saveReview(dir, pr, result, "P3", new Date("2026-09-30T10:00:00Z"));
  saveReview(dir, pr, result, "P3", new Date("2026-09-30T11:00:00Z"));
  assert.match(
    readFileSync(a, "utf8"),
    /^https:\/\/github.com\/o\/r\/pull\/7 at a{40}\n\n- author: @me\n- commits: @me\n\n> \[!CAUTION\]/,
  );
  assert.deepEqual(readdirSync(join(dir, "reviews", "o", "r", "7")).sort(), [
    "2026-09-30-10-00-aaaaaaa.json",
    "2026-09-30-10-00-aaaaaaa.md",
    "2026-09-30-11-00-aaaaaaa.json",
    "2026-09-30-11-00-aaaaaaa.md",
  ]);
});

test("saveReview records author, people and requester", () => {
  const dir = mkdtempSync(join(tmpdir(), "rsrobo-"));
  const withPeople = { ...pr, people: { contributors: ["me", "pal"], commenters: ["bob"], reviewers: [] } };
  const f = saveReview(dir, withPeople, { ...result, requester: "me" }, "P3", new Date("2026-09-30T10:00:00Z"));
  assert.match(
    readFileSync(f, "utf8"),
    /^https:[^\n]+\n\n- author: @me\n- commits: @me, @pal\n- comments: @bob\n- run asked by: @me\n\n/,
  );
  assert.equal(JSON.parse(readFileSync(f.replace(/\.md$/, ".json"), "utf8")).people.commenters[0], "bob");
});

test("fullPaths resolves a bare file name to its unique tracked path", async () => {
  const { fullPaths } = await import("../src/ask.ts");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "rsrobo-git-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  writeFileSync(join(dir, "a", "b", "x.cpp"), "");
  writeFileSync(join(dir, "y.cpp"), "");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  assert.equal(
    fullPaths(dir, "see `x.cpp:3-4` and `y.cpp:1` and `z.cpp:9`"),
    "see `a/b/x.cpp:3-4` and `y.cpp:1` and `z.cpp:9`",
  );
});

test("reconcile keeps numbers for findings at the same place and lists the resolved ones", async () => {
  const { reconcile } = await import("../src/review.ts");
  const prev = {
    head: "b".repeat(40),
    findings: [
      { ...result.findings[1], n: 1 },
      { ...result.findings[0], n: 2 },
      {
        file: "gone.py",
        line_start: 1,
        line_end: 2,
        severity: "P1" as const,
        title: "gone",
        problem: "",
        evidence: [],
        fix: "",
        n: 3,
      },
    ],
  };
  const fresh: Result = {
    ...result,
    findings: [
      { ...result.findings[1], line_start: 12, line_end: 14, title: "wrong, moved" },
      { file: "new.py", line_start: 5, line_end: 5, severity: "P2", title: "new", problem: "", evidence: [], fix: "" },
    ],
  };
  const r = reconcile(prev, fresh);
  assert.deepEqual(
    r.findings.map((f) => [f.n, f.title]),
    [
      [1, "wrong, moved"],
      [4, "new"],
    ],
  );
  assert.deepEqual(
    r.resolved?.map((f) => f.n),
    [2, 3],
  );
  assert.match(render(pr, r), /Resolved since the last review: #2 minor; #3 gone\./);
});

test("decorate strips preambles, colors triage by severity, collapses sources", async () => {
  const { decorate } = await import("../src/ask.ts");
  const d = {
    mode: "triage" as const,
    question: "Triage this issue.",
    model: "m",
    cost_usd: 0.1,
    seconds: 4,
    requester: "me",
    issue: { number: 9, title: "Crash" },
  };
  const md = decorate(
    'Based on my analysis:\n\n| Field | Value |\n|---|---|\n| Severity | P1 |\n\n**Evidence.** x\n\nSources: `a/b.c:1`, lesson 1234567890 "t"',
    d,
  );
  assert.match(md, /^> \[!CAUTION\]\n> \*\*Triage\*\* on #9 Crash\n\n\| Field/);
  assert.doesNotMatch(md, /Based on my analysis/);
  assert.match(md, /<details><summary>Sources<\/summary>\n\n`a\/b\.c:1`, lesson 1234567890 "t"\n\n<\/details>/);
  assert.match(md, /<sub>rsrobo triage · `m` · \$0\.10 · 4s · asked by @me<\/sub>$/);
  assert.match(
    decorate("Yes. Because.\nSources: x", { ...d, mode: "ask", question: "q?" }),
    /^> \[!NOTE\]\n> \*\*Answer\*\* on #9 Crash: q\?\n\nYes\. Because\./,
  );
});

test("enforceLabels keeps only labels the repository has", async () => {
  const { enforceLabels } = await import("../src/ask.ts");
  const t = "| Labels | bug, Performance, `needs-info`, made-up |\n| State | ready |";
  assert.equal(
    enforceLabels(t, ["bug", "performance", "needs-info"]),
    "| Labels | bug, performance, needs-info |\n| State | ready |",
  );
  assert.equal(enforceLabels("| Labels | made-up |", ["bug"]), "| Labels | none |");
});

test("commit issues show in the overview and turn a clean review into needs changes", () => {
  const withIssue: Result = {
    ...result,
    findings: [],
    commit_issues: [
      {
        where: "bbbbbbb",
        subject: "Update LICENSE",
        problem: "not `type(scope): description`",
        severity: "P1",
        url: "https://x/c",
        suggested: "docs: update the license",
      },
    ],
  };
  const md = render({ ...pr, commits: [{ sha: "b".repeat(40), subject: "Update LICENSE" }] }, withIssue);
  assert.match(md, /^> \[!CAUTION\]\n> \*\*Needs changes\.\*\* No findings in 2 files/);
  assert.match(md, /\*\*Commit messages\.\*\* 1 of 2 subjects do not follow Conventional Commits\./);
  assert.match(
    md,
    /\| P1 \| \[bbbbbbb\]\(https:\/\/x\/c\) \| `Update LICENSE` \| not `type\(scope\): description` \| `docs: update the license` \|/,
  );
  assert.equal(blocking([], withIssue.commit_issues), true);
  assert.equal(blocking([result.findings[0]]), false);
  assert.match(md, /To fix: reword each commit with `git rebase -i`/);
  assert.match(
    md,
    /bbbbbbb: "Update LICENSE" -> "docs: update the license"\nRun `git rebase -i bbbbbbb` and mark each listed commit `reword`\.\nDo not push\./,
  );
});

test("a skipped source file gets a second pass; lock files and styling do not", () => {
  const files = ["web/View.tsx", "web/view.css", "web/package-lock.json", "src/a.cpp"].map((filename) => ({
    filename,
    status: "added",
    changes: 9,
  }));
  const skipped = ["web/View.tsx lines 560-1104: not read", "web/view.css: styling", "web/package-lock.json: skimmed"];
  const missed = missedFiles({ ...pr, files }, skipped);
  assert.deepEqual(missed, ["web/View.tsx"]);
  const second: Result = {
    ...result,
    skipped: [],
    cost_usd: 1,
    seconds: 10,
    findings: [
      { ...result.findings[0] },
      { ...result.findings[0], file: "web/View.tsx", line_start: 700, line_end: 702, severity: "P1", title: "new" },
    ],
  };
  const merged = mergePass({ ...result, skipped }, second, missed);
  assert.deepEqual(merged.skipped, ["web/view.css: styling", "web/package-lock.json: skimmed"]);
  assert.equal(merged.findings.length, result.findings.length + 1);
  assert.equal(merged.cost_usd, result.cost_usd + 1);
});
