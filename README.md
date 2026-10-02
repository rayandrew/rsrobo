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

Per-repo context lives in the private `rsrobo-notes` repo at `<owner>/<repo>/`: an `AGENTS.md` with the review notes and optional `.claude/skills/`. `AGENTS.md` is the file every engine reads: pi and Codex natively, Claude Code from 2.1.277 when no `CLAUDE.md` sits beside it. So there is no `CLAUDE.md` in the notes. Point `RSROBO_NOTES_DIR` at the checkout. `RSROBO_SKILLS_DIR` optionally adds a skills checkout.

The PR's own `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.pi/` and `.agents/` are removed before review; nothing from the PR head configures the reviewer. When the repository has an `AGENTS.md` or `CLAUDE.md` on the base branch, which a PR cannot edit, it is handed to the reviewer as data in `.rsrobo/repo-guidance.md`.

What goes into a notes file, from the published evidence: commands with flags first, defect patterns to flag, conventions that differ from the language default, pitfalls, and what not to flag. No repository overview or directory map; they raise cost and do not help. Under 80 lines. Paths only where they are unlikely to move.

## Hub workflow

`.github/workflows/review.yml` runs the same CLI on `workflow_dispatch`. The `review` job never pushes to the notes repo: it uploads what it wrote as an artifact, and the `notes` job, one at a time across all runs, pushes it with a rebase-and-retry loop and then deletes the artifact. The `lessons` job does the same for the kb. Secrets: `USER_TOKEN` (classic PAT, `repo` + `workflow`), `BOT_TOKEN` (bot account classic PAT, `notifications` + `public_repo`), `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`).

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

- Code style rules from the `code-style` skill are in the review prompt for every repository: magic literals, dead code and silent fallbacks are P2; comment noise, bare `TODO`s, non-ASCII and speculative abstractions are P3. A repository's notes file can switch any of them off under "Do not flag". The `fix` task follows the same rules when it writes code.
- Commit messages are checked in code, not by the model. A repo entry with `commits: {types, severity}` in `config.json` makes each commit subject and the PR title that is not a Conventional Commit a finding of that severity; `P1` gives "Needs changes". AI attribution in a commit message or the PR body, such as a `Co-authored-by` trailer with a tool address or a product name, "Generated with Claude Code", or any `Assisted-by` or `Generated-by` trailer, is a finding of the same severity. A co-author with a first name and a normal address is a person and passes. The model words a replacement for each bad subject, the code shows it only when it passes the same check, and the table ends with the reword steps and a copy-paste text for an agent.
- A changed source file that the model lists as not read gets one second pass over those files only; its findings and cost are added. Lock files, generated output, styling and images may stay unread.
- A public review with a P0 or P1 result, in a finding or a commit message, is posted as "Request changes"; any other result is a comment review, and it dismisses the bot's earlier change request. The dismissal needs write access to the repository.
- A second `review` or `assess start` on the same PR is incremental: the model reads only the files that changed since the last reviewed commit and re-checks the earlier findings, which keep their numbers; findings the code now handles are listed as resolved. A finding that the bot already commented on is not posted again: it stays in the table as "still open", and only new findings get comments. With no new commit the saved result is used and no model runs. `@rsrobo review full` or `@rsrobo assess start full` reviews the whole PR again.
- The reviewer reads what people wrote on the PR. It does not repeat their points, and a comment from an allowed commenter that rejects a finding closes it; a comment from anyone else closes nothing.
- The pi setup step in the workflow copies `pi/rkb-extension.ts`, the file `rkb install pi` generates, because that command asks a question and cannot run in CI. Refresh the copy after an rkb upgrade: `cp ~/.pi/agent/extensions/rkb.ts pi/rkb-extension.ts`.
- `@rsrobo review [model=alias] [effort=low|medium|high] [budget=usd] [post=pending|review|inbox|comment] [focus=a,b] [free text]` posts a public review as the bot: the overview as the body, one inline comment per finding.
- `@rsrobo assess start [same keys]` runs the same review but keeps it as a pending draft under my name, visible only to me. `@rsrobo assess finish` (or `publish`) posts that saved draft as the bot and deletes my pending one; no model runs.
- `@rsrobo fix 2,3|all [via=patch|suggest|stacked|push] [platform=linux|macos] [model=alias]` applies findings from the latest saved review. `patch` writes the diff to `reviews/<owner>/<repo>/<pr>/fix-*.md` in the notes repo; `suggest` also opens a pending review with suggestion blocks for hunks inside the PR diff; `stacked` pushes a branch and opens a PR against the PR branch; `push` commits onto the PR branch. The commit message is `fix: <title>` with no trailer. The author is the `rsrobo` account by default, pushed with its token; `as=me` makes the requester the author and pushes with the user token. `stacked` and `push` first run the repo's `test:` command from its notes, on a macOS runner with `platform=macos`, and stop on failure. `config.json` says which levels each repo allows.
- Unlisted repos get every fix level, every provider and public plus internal kb lessons; the `repos` entries in `config.json` restrict the LLNL orgs.
- `@rsrobo ask <question>` on an issue or a PR answers from the default branch and the kb, with linked code references and a sources line. On an issue the question may refer to it: `ask have we implemented this?`, `ask search duplicates`. The model sees the issue, keyword-matched open items with a body excerpt, and every open title. Haiku by default, a few cents. The answer is posted by the bot in the thread and copied to the inbox. A stranger's ask waits for your `approve` like every other command.
- `@rsrobo summarize` on a PR writes a reviewer brief: what changes, why, read first, how to test, risks, open questions. `@rsrobo triage` on an issue gives type, area, severity, duplicate, state and labels from the repo's own label set, with evidence and what the reporter must add. Both post in the thread and copy to the inbox.
- `@rsrobo init-notes` drafts `<owner>/<repo>/AGENTS.md` in the notes repo from the default branch. It never overwrites an existing file.
- Requesting a review from the bot on the PR page starts a default review. Own repos only; the bot must be a collaborator.
- Only `rayandrew` can start a run, the first one and every later one. When someone else mentions the bot or re-requests its review from the PR page, the bot replies once on the PR with a table of the commands each side can use, and the request lands in the inbox. The @mention in that reply is what notifies you. `@rsrobo approve [model=... effort=... budget=...]` on the same PR runs the waiting request; your keys replace theirs, so you can cap the model and effort. With nothing waiting, `approve` means `review`.
- `@rsrobo approve watch` also watches that PR: the poller reads its head commit once a minute, and after every push, by anyone, it dispatches an incremental review with the defaults. The watch ends when the PR closes, or after 30 days. `@rsrobo watch` and `@rsrobo unwatch` work on their own, and `approve all watch` does both.
- `@rsrobo approve all` also trusts that person on that PR: their later requests there run at once, with their options, inside the repo policy. Trust is per PR and per person, ends when the PR closes, and after 30 days at most. `approve all user=<login>` names the person; `@rsrobo revoke [user=<login>]` takes it back.

Failed CI checks on the PR head are fetched read-only and handed to the reviewer as `.rsrobo/ci.md`. Related work goes to `.rsrobo/related.md`: issues the PR references, open PRs on the same files, earlier PRs on the same files from the git log, and open issues that name the changed files. No model is involved in either.

## Knowledge base

The reviewer, the verifier and `ask` read the kb through rkb's MCP server, limited to `rkb_search` and `rkb_show`. The job clones `rayandrew/kb` and prunes it to the sensitivity each repo may see (`kb` in `config.json`: `public` for the LLNL orgs, `public` and `internal` for mine).

The reviewer also proposes lessons in rkb's shape: type, title, topic, tags, sections, evidence. A separate `lessons` job writes them with `rkb add` into a fresh, unpruned clone and pushes with `rkb sync`. That job runs under the `kb-write` concurrency group, so two reviews never push at once; it pulls and searches for each title first, so two reviews of one repo cannot write the same lesson twice. Ids, skips and refusals go to the sticky "rsrobo: lessons to distill" issue and show in `rkb changes`. The job sets `RKB_AUTO_CONFIRM=continue` for rkb's burst limit, which needs an rkb release with that variable.

## Bench and ledger

`rsrobo bench --model alias --save <notes>` runs every case in `<notes>/bench/cases.json` (a past PR and the defects it must find) and prints found, extra, cost and time, with the change against the last run of the same model. Runs are saved under `<notes>/bench/runs/`. `rsrobo ledger --save <notes>` writes `<notes>/ledger.md`, monthly cost per repo and model from the saved reviews; the workflow refreshes it after every run.

## Engines

`model=` takes an alias from `config.json`, or `provider/model` for any provider in `pi_providers`. A string alias runs on Claude Code (`claude -p`, subscription token). An object alias or a `provider/model` runs on [pi](https://pi.dev) with that provider: `model=luna`, `model=openrouter/anthropic/claude-sonnet-5.5`, `model=freeinference/kimi-k2.7-code`. Both engines use the same prompts, the verify subagent and the kb tools, for every task: review, compare, fix, init-notes, ask, summarize, triage. pi has no cost cap; a 40 minute timeout stands in.

Each repo lists the providers it may use in `config.json` (`providers`); `llnl-asr/*` excludes `freeinference`, whose models are Chinese-origin. For OpenRouter the LLNL entries also set `vendors`, a list of US model makers, so `openrouter/qwen/...` or `openrouter/deepseek/...` is refused there while `openrouter/~google/gemini-pro-latest` passes. Cohere is Canadian; drop it from the list if US only means US.

CI auth for pi: `OPENROUTER_API_KEY` and `FREEINFERENCE_API_KEY` as secrets. The job builds `~/.pi/agent/models.json` for freeinference from its live `/v1/models` list with `scripts/freeinference-models.ts`, and falls back to the committed `pi/models.json`. OpenRouter and Codex models come from pi's own catalog. `rsrobo models` lists everything `model=` accepts. For a Codex subscription, put the `openai-codex` entry of `~/.pi/agent/auth.json` into the `PI_AUTH_JSON` secret; the job writes it back. Refresh tokens rotate, so that secret can go stale.
