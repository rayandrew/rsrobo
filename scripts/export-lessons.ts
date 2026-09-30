#!/usr/bin/env node
// Export the public, active rkb lessons of one kb folder as one markdown file for rsrobo-notes.
// usage: node scripts/export-lessons.ts projects/dftracer-utils > lessons.md
import { execFileSync } from "node:child_process";
import { sensitivity } from "../src/kb.ts";

type Topic = { folder: string };
type Lesson = { id: string; status: string; title: string };
type Shown = { path: string; title: string; frontmatter: { labels?: { sensitivity?: string } }; body: string };

const folder = process.argv[2];
if (!folder) {
  console.error("usage: export-lessons.ts <kb-folder>");
  process.exit(1);
}
const rkb = (...args: string[]) => JSON.parse(execFileSync("rkb", [...args, "--format", "json"], { encoding: "utf8" }));
const root: string = rkb("list").root;

// Keep the lesson's own sections except Context and Evidence; drop the H1, the file already has the title.
const statement = (body: string) =>
  body
    .split(/\n(?=## )/)
    .map((sec) => sec.replace(/^# .*\n?/m, "").trim())
    .filter((sec) => sec && !/^## (Context|Evidence)\b/.test(sec))
    .join("\n\n");

const topics: Topic[] = rkb("list", folder).topics ?? [{ folder }];
const out = [
  `# Lessons for ${folder}`,
  "",
  "Exported from rkb. Public lessons only. Facts and pitfalls to keep in mind while reviewing.",
  "",
];
let n = 0;
for (const t of topics) {
  const lessons: Lesson[] = rkb("list", t.folder).lessons ?? [];
  for (const l of lessons) {
    if (l.status !== "active") continue;
    const shown: Shown = rkb("show", l.id);
    if (sensitivity(root, shown.path, shown.frontmatter.labels?.sensitivity) !== "public") continue;
    out.push(`## ${shown.title}`, "", statement(shown.body), "");
    n++;
  }
}
process.stdout.write(out.join("\n"));
console.error(`${n} lessons exported`);
