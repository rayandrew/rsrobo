import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export type Sensitivity = "public" | "internal" | "confidential";

// A lesson without its own label inherits from the nearest folder README that sets one; the default is internal.
export function sensitivity(root: string, path: string, own?: string): Sensitivity {
  if (own) return own as Sensitivity;
  for (let dir = dirname(path); dir !== "." && dir !== "/"; dir = dirname(dir)) {
    const m = readLabel(join(root, dir, "README.md"));
    if (m) return m;
  }
  return "internal";
}

function readLabel(file: string): Sensitivity | undefined {
  try {
    return /^\s*sensitivity:\s*(\w+)/m.exec(readFileSync(file, "utf8"))?.[1] as Sensitivity;
  } catch {
    return undefined;
  }
}

const ownLabel = (file: string) => {
  const head = readFileSync(file, "utf8").slice(0, 2000);
  return /^labels:\s*\n(?:[ \t]+.*\n)*?[ \t]+sensitivity:\s*(\w+)/m.exec(head)?.[1];
};

// Deletes every lesson whose sensitivity is not in `allowed`, so the reviewer cannot read it. In place; use on a throwaway clone.
export function pruneKb(root: string, allowed: Sensitivity[]): { kept: number; removed: number } {
  const out = { kept: 0, removed: 0 };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "site") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".md") && name !== "README.md") {
        const rel = relative(root, p);
        if (allowed.includes(sensitivity(root, rel, ownLabel(p)))) out.kept++;
        else {
          rmSync(p);
          rmSync(p.replace(/\.md$/, ".assets"), { recursive: true, force: true });
          out.removed++;
        }
      }
    }
  };
  for (const scope of ["general", "projects", "systems"]) {
    try {
      walk(join(root, scope));
    } catch {}
  }
  return out;
}
