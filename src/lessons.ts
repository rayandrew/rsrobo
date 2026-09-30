import { execFileSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";

// A lesson the reviewer proposes, in rkb's shape. `topic` is a folder such as `cpp` or `index`; rkb places
// it under projects/<project>/<topic>/ from `when: project`.
export type Lesson = {
  type: "fact" | "pitfall";
  title: string;
  topic: string;
  tags: string[];
  statement?: string;
  symptom?: string;
  cause?: string;
  fix?: string;
  evidence: string;
};

export const lessonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "title", "topic", "tags", "evidence"],
  properties: {
    type: { type: "string", enum: ["fact", "pitfall"] },
    title: { type: "string", description: "A short sentence that states the claim, under 80 characters" },
    topic: {
      type: "string",
      description: "One lowercase word for the thing involved: cpp, python, index, query, cmake, ci",
    },
    tags: { type: "array", items: { type: "string" }, description: "Two to four words to find it by" },
    statement: { type: "string", description: "fact: the claim with the code that shows it" },
    symptom: { type: "string", description: "pitfall: what goes wrong" },
    cause: { type: "string", description: "pitfall: why" },
    fix: { type: "string", description: "pitfall: what to do instead" },
    evidence: { type: "string", description: "Where it was seen: PR, files and lines" },
  },
};

// The lesson as the markdown rkb add reads. Scope is the project; the reviewer only read the code, so `read`.
export function lessonMd(l: Lesson, project: string, pr: string): string {
  const front = [
    "---",
    `type: ${l.type}`,
    "verified_how: read",
    "when:",
    `  project: ${project}`,
    "tags:",
    ...l.tags.map((t) => `  - ${t}`),
    "---",
  ];
  const sections =
    l.type === "fact"
      ? ["## Statement", "", l.statement ?? "", ""]
      : ["## Symptom", "", l.symptom ?? "", "", "## Cause", "", l.cause ?? "", "", "## Fix", "", l.fix ?? "", ""];
  return [...front, "", `# ${l.title}`, "", ...sections, "## Evidence", "", `- ${pr}: ${l.evidence}`, ""].join("\n");
}

export type Added = { title: string; id?: string; skipped?: string; error?: string };

const rkb = (kbDir: string, args: string[], input?: string) =>
  spawnSync("rkb", [...args, "--format", "json"], {
    input,
    encoding: "utf8",
    cwd: kbDir,
    env: { ...process.env, RKB_HOME: kbDir, RKB_AUTO_CONFIRM: process.env.RKB_AUTO_CONFIRM ?? "continue" },
  });

// A lesson whose title the kb already has, case-insensitive, after a fresh pull. Two runs in flight cannot see
// each other's proposals, so this check happens at write time, not at review time.
function existing(kbDir: string, title: string, project: string): string | undefined {
  const r = rkb(kbDir, ["search", title, "--no-model", "--limit", "5", "--project", project]);
  try {
    const hits = (JSON.parse(r.stdout).results ?? []) as { id: string; title: string }[];
    return hits.find((h) => h.title.trim().toLowerCase() === title.trim().toLowerCase())?.id;
  } catch {
    return undefined;
  }
}

// Pulls, writes each lesson with `rkb add` into `kbDir` (an unpruned clone), then `rkb sync` pushes, with one
// retry for a lost push race. Never throws: a refused lesson comes back with its error so the inbox can show it.
export function addLessons(kbDir: string, lessons: Lesson[], project: string, pr: string): Added[] {
  const out: Added[] = [];
  rkb(kbDir, ["sync"]);
  for (const l of lessons) {
    const dup = existing(kbDir, l.title, project);
    if (dup) {
      out.push({ title: l.title, skipped: dup });
      continue;
    }
    const r = rkb(kbDir, ["add", "--topic", l.topic, "--project", project], lessonMd(l, project, pr));
    try {
      const j = JSON.parse(r.stdout || "{}");
      if (j.status === "written") out.push({ title: l.title, id: j.id });
      else out.push({ title: l.title, error: j.question ?? j.error?.message ?? j.status ?? r.stderr?.slice(-300) });
    } catch {
      out.push({ title: l.title, error: (r.stderr || r.stdout).slice(-300) });
    }
  }
  if (out.some((a) => a.id)) {
    let s = rkb(kbDir, ["sync"]);
    if (s.status !== 0) s = rkb(kbDir, ["sync"]);
    if (s.status !== 0) out.push({ title: "rkb sync", error: (s.stderr || s.stdout).slice(-300) });
  }
  return out;
}

// The kb project a repository maps to: the folder whose README lists the repo as a remote, else the repo name.
export function kbProject(kbDir: string, owner: string, repo: string): string {
  try {
    const hit = execFileSync(
      "grep",
      ["-rl", `github.com/${owner}/${repo}`, "--include=README.md", `${kbDir}/projects`],
      {
        encoding: "utf8",
      },
    )
      .split("\n")
      .find(Boolean);
    if (hit) return dirname(hit).split("/").pop() ?? repo;
  } catch {}
  return repo;
}
