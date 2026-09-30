import assert from "node:assert/strict";
import { test } from "node:test";
import { lessonMd } from "../src/lessons.ts";

test("lessonMd renders a fact and a pitfall in rkb's shape", () => {
  const fact = lessonMd(
    {
      type: "fact",
      title: "Keys are big-endian",
      topic: "index",
      tags: ["rocksdb", "keys"],
      statement: "`a.h:1` says so.",
      evidence: "read",
    },
    "dftracer-utils",
    "https://x/pull/1",
  );
  assert.match(
    fact,
    /^---\ntype: fact\nverified_how: read\nwhen:\n {2}project: dftracer-utils\ntags:\n {2}- rocksdb\n {2}- keys\n---\n\n# Keys are big-endian\n\n## Statement\n\n`a\.h:1` says so\.\n\n## Evidence\n\n- https:\/\/x\/pull\/1: read\n$/,
  );
  const pit = lessonMd(
    { type: "pitfall", title: "t", topic: "cpp", tags: ["x"], symptom: "s", cause: "c", fix: "f", evidence: "e" },
    "p",
    "u",
  );
  assert.match(pit, /## Symptom\n\ns\n\n## Cause\n\nc\n\n## Fix\n\nf\n\n## Evidence\n\n- u: e\n$/);
});
