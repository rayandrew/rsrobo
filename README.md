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
