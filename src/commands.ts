export type TaskSpec = {
  task: string;
  args: Record<string, string>;
  text: string;
};

export const KNOWN_KEYS = new Set([
  "model",
  "focus",
  "files",
  "ignore",
  "budget",
  "post",
  "via",
  "platform",
  "tests",
  "effort",
]);
const TASKS = new Set([
  "review",
  "fix",
  "triage",
  "summarize",
  "explain",
  "tests",
  "changelog",
  "compare",
  "init-notes",
]);
const TOKEN = /^[A-Za-z0-9_.,*/\-$]+$/;

// Parse the text after "@bot". Throws on anything it does not understand; the caller reports the message back.
export function parseCommand(body: string, botLogin: string): TaskSpec | null {
  const m = new RegExp(`@${botLogin}\\b\\s*([^\\n]*)`, "i").exec(body);
  if (!m) return null;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  const task = words.shift() ?? "";
  if (!TASKS.has(task)) throw new Error(`unknown task "${task}"`);
  const args: Record<string, string> = {};
  const text: string[] = [];
  for (const w of words) {
    const eq = w.indexOf("=");
    if (eq > 0 && /^[a-z_]+$/.test(w.slice(0, eq))) {
      const [k, v] = [w.slice(0, eq), w.slice(eq + 1)];
      if (!KNOWN_KEYS.has(k)) throw new Error(`unknown key "${k}"`);
      if (!TOKEN.test(v) || v.includes("..") || v.startsWith("/") || /:\/\//.test(v))
        throw new Error(`bad value for "${k}"`);
      args[k] = v;
    } else {
      text.push(w);
    }
  }
  return { task, args, text: text.join(" ") };
}
