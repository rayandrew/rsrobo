import assert from "node:assert/strict";
import { test } from "node:test";
import { compareMd } from "../src/compare.ts";
import type { Pr } from "../src/github.ts";
import type { Finding, Result } from "../src/review.ts";

const pr: Pr = {
  owner: "o",
  repo: "r",
  number: 7,
  title: "t",
  body: "",
  base: "b".repeat(40),
  head: "a".repeat(40),
  html_url: "u",
  head_ref: "feat",
  head_repo: "o/r",
  author: "me",
  people: { contributors: ["me"], commenters: [], reviewers: [] },
  commits: [],
  files: [],
};
const f = (file: string, line: number, severity: Finding["severity"], title: string): Finding => ({
  file,
  line_start: line,
  line_end: line + 2,
  severity,
  title,
  problem: "p",
  evidence: [],
  fix: "f",
});
const res = (model: string, findings: Finding[]): Result => ({
  map: "",
  changes: [],
  skipped: [],
  lessons: [],
  findings,
  model,
  effort: "high",
  cost_usd: 1,
  seconds: 60,
  files: 3,
});

test("compareMd groups findings by location across models", () => {
  const md = compareMd(pr, [
    { alias: "a", result: res("m-a", [f("x.py", 10, "P1", "one"), f("y.py", 5, "P2", "only a")]) },
    { alias: "b", result: res("m-b", [f("x.py", 12, "P1", "one again")]) },
  ]);
  assert.match(md, /\| `m-a` \| 2 \| 1 \| \$1\.00 \| 1 min \|/);
  assert.match(md, /\| \[x\.py:10-12\]\([^)]+\) \| one \| P1 \| P1 \|/);
  assert.match(md, /\| \[y\.py:5-7\]\([^)]+\) \| only a \| P2 \| {2}\|/);
  assert.match(md, /<summary>b: 1 findings<\/summary>/);
});
