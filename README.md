# rsrobo

Personal, mention-driven PR review bot. Runs `claude -p` on a PR checkout; posts the result where I choose.

## Local

```
node src/cli.ts review owner/repo#N --model sonnet --budget 2
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

Command grammar: `@rsrobo review [model=alias] [effort=low|medium|high] [budget=usd] [post=pending|inbox|comment] [focus=a,b] [free text]`.
