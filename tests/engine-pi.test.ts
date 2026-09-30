import assert from "node:assert/strict";
import { test } from "node:test";
import { collect, lastJson } from "../src/engine-pi.ts";

test("collect sums assistant cost and keeps the final text", () => {
  const ev = [
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "a" }], usage: { cost: { total: 0.01 } } },
    },
    { type: "message_end", message: { role: "user", content: [] } },
    {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "b" }], usage: { cost: { total: 0.02 } } },
    },
    { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "final" }] } },
    "not json",
  ];
  const out = collect(ev.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n"));
  assert.equal(out.text, "final");
  assert.ok(Math.abs(out.cost - 0.03) < 1e-9);
});

test("lastJson prefers the last fenced block, else the last object", () => {
  assert.deepEqual(lastJson('draft {"a":1}\n```json\n{"a":2}\n```\n'), { a: 2 });
  assert.deepEqual(lastJson('text {"x":{"y":1}} tail'), { x: { y: 1 } });
  assert.equal(lastJson("nothing"), null);
});
