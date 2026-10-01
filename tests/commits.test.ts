import assert from "node:assert/strict";
import { test } from "node:test";
import { applySuggestions, checkCommits, subjectProblem } from "../src/commits.ts";
import type { Pr } from "../src/github.ts";

const types = ["feat", "fix", "docs", "chore", "bench"];

test("subjectProblem accepts conventional subjects and git's own merge and revert subjects", () => {
  for (const ok of [
    "feat: add a thing",
    "fix(coro): publish task completion",
    "feat(index)!: drop the old key layout",
    "bench: the engine against pandas",
    "Merge branch 'feat/x' into 'develop'",
    'Revert "feat: add a thing"',
  ]) {
    assert.equal(subjectProblem(ok, types), null, ok);
  }
});

test("subjectProblem names what is wrong", () => {
  assert.match(subjectProblem("Update LICENSE", types) ?? "", /not `type\(scope\): description`/);
  assert.match(subjectProblem("feature: add a thing", types) ?? "", /unknown type `feature`/);
  assert.match(subjectProblem("fix!(coro): leak", types) ?? "", /goes after the scope/);
  assert.match(subjectProblem("fix:no space", types) ?? "", /not `type/);
});

test("checkCommits checks the PR title and every commit, and is off without a policy", () => {
  const pr = {
    title: "Add replay",
    html_url: "https://github.com/o/r/pull/7",
    commits: [
      { sha: "a".repeat(40), subject: "feat: add replay" },
      { sha: "b".repeat(40), subject: "WIP" },
    ],
  } as Pr;
  assert.deepEqual(checkCommits(pr, undefined), []);
  const issues = checkCommits(pr, { types, severity: "P1" });
  assert.deepEqual(
    issues.map((i) => [i.where, i.severity]),
    [
      ["PR title", "P1"],
      ["bbbbbbb", "P1"],
    ],
  );
  assert.equal(issues[1].url, `https://github.com/o/r/pull/7/commits/${"b".repeat(40)}`);
});

test("applySuggestions keeps only a suggestion that passes the check", () => {
  const issue = (where: string) => ({ where, subject: "x", problem: "p", severity: "P1" as const, url: "u" });
  const out = applySuggestions(
    [issue("PR title"), issue("aaaaaaa"), issue("bbbbbbb")],
    [
      { where: "PR title", subject: "feat(prov): add the provenance view" },
      { where: "aaaaaaa", subject: "Added things" },
    ],
    types,
  );
  assert.deepEqual(
    out.map((c) => c.suggested),
    ["feat(prov): add the provenance view", undefined, undefined],
  );
});
