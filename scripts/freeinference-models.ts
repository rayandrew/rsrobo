#!/usr/bin/env node
// Writes a pi models.json for freeinference from its live /v1/models list, so new models need no config change.
// usage: node scripts/freeinference-models.ts > ~/.pi/agent/models.json   (needs FREEINFERENCE_API_KEY)
type Model = {
  id: string;
  input_modalities?: string[];
  context_length?: number;
  max_output_length?: number;
};

const key = process.env.FREEINFERENCE_API_KEY;
if (!key) {
  console.error("FREEINFERENCE_API_KEY is not set");
  process.exit(1);
}
const res = await fetch("https://freeinference.org/v1/models", { headers: { authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.error(`freeinference: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const { data } = (await res.json()) as { data: Model[] };
const models = data.map((m) => ({
  id: m.id,
  input: m.input_modalities ?? ["text"],
  contextWindow: m.context_length ?? 131072,
  maxTokens: m.max_output_length ?? 8192,
}));
const out = {
  providers: {
    freeinference: {
      baseUrl: "https://freeinference.org/v1",
      api: "openai-completions",
      apiKey: "$FREEINFERENCE_API_KEY",
      models,
    },
  },
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
console.error(`${models.length} models`);
