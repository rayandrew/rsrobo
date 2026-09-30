# rsrobo

Personal, mention-driven PR review bot. Runs `claude -p` on a PR checkout; posts the result where I choose.

## Local

```
node src/cli.ts review owner/repo#N --model sonnet --budget 2
node src/cli.ts compare owner/repo#N --models sonnet,opus   # bake-off, parallel, prints a comparison
npm run check      # biome lint+format, tsc, tests
npm run fix        # apply biome fixes
```

Needs `gh` (logged in) and `claude` (logged in, or `ANTHROPIC_API_KEY`).

Per-repo context lives in the private `rsrobo-notes` repo at `<owner>/<repo>/` (a `CLAUDE.md`, optional `.claude/skills/`). Point `RSROBO_NOTES_DIR` at its checkout. `RSROBO_SKILLS_DIR` optionally adds a skills checkout. The PR's own `CLAUDE.md`, `AGENTS.md` and `.claude/` are removed before review; nothing from the PR head configures the reviewer.

## Hub workflow

`.github/workflows/review.yml` runs the same CLI on `workflow_dispatch`. Secrets: `USER_TOKEN` (classic PAT, `repo` + `workflow`), `BOT_TOKEN` (bot account classic PAT, `notifications` + `public_repo`), `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`).

```
gh workflow run review.yml -f repo=owner/name -f pr=N -f post=inbox
```

## Poller

`poller/` is a Cloudflare Worker. Every minute it reads the bot account's notifications, keeps mentions by allowed commenters on allowed repos, parses the command, dispatches the workflow, and marks the thread read. Handled comment IDs live in KV for 30 days. Bad commands become an issue in the notes repo.

One-time setup:

```
npx wrangler login
npx wrangler kv namespace create SEEN -c poller/wrangler.toml   # paste the id into wrangler.toml
npx wrangler secret put BOT_TOKEN -c poller/wrangler.toml
npx wrangler secret put USER_TOKEN -c poller/wrangler.toml
npm run deploy
```

Command grammar:

- `@rsrobo review [model=alias] [effort=low|medium|high] [budget=usd] [post=pending|review|inbox|comment] [focus=a,b] [free text]`
- `@rsrobo fix 2,3|all [via=patch|suggest|stacked|push] [platform=linux|macos] [model=alias]` applies findings from the latest saved review. `patch` posts the diff to the inbox issue; `suggest` also opens a pending review with suggestion blocks for hunks inside the PR diff; `stacked` pushes a branch and opens a PR against the PR branch; `push` commits onto the PR branch. `stacked` and `push` first run the repo's `test:` command from its notes, on a macOS runner with `platform=macos`, and stop on failure. `config.json` says which levels each repo allows.
- `@rsrobo init-notes` drafts `<owner>/<repo>/CLAUDE.md` in the notes repo from the default branch. It never overwrites an existing file.
- Requesting a review from the bot on the PR page starts a default review. Own repos only; the bot must be a collaborator.

Failed CI checks on the PR head are fetched read-only and handed to the reviewer as `.rsrobo/ci.md`.

## Engines

`model=` takes an alias from `config.json`, or `provider/model` for any provider in `pi_providers`. A string alias runs on Claude Code (`claude -p`, subscription token). An object alias or a `provider/model` runs on [pi](https://pi.dev) with that provider: `model=luna`, `model=openrouter/anthropic/claude-sonnet-5.5`, `model=freeinference/kimi-k2.7-code`. Both engines use the same prompts, the verify subagent and the kb tools. pi has no cost cap; a 40 minute timeout stands in.

Each repo lists the providers it may use in `config.json` (`providers`); `llnl-asr/*` excludes `freeinference`, whose models are Chinese-origin. `openrouter` can route to such models too, so pick the model with care there.

CI auth for pi: `OPENROUTER_API_KEY` and `FREEINFERENCE_API_KEY` as secrets. The job builds `~/.pi/agent/models.json` for freeinference from its live `/v1/models` list with `scripts/freeinference-models.ts`, and falls back to the committed `pi/models.json`. OpenRouter and Codex models come from pi's own catalog. `rsrobo models` lists everything `model=` accepts. For a Codex subscription, put the `openai-codex` entry of `~/.pi/agent/auth.json` into the `PI_AUTH_JSON` secret; the job writes it back. Refresh tokens rotate, so that secret can go stale.
