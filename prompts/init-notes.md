You write the review notes for one repository as an `AGENTS.md`. The working directory is its default branch. You have read-only tools.

The reader is a code reviewer agent that has the same checkout. Studies of such files agree on four points; follow them:
- Rules that a reader cannot derive from the code help. Repository overviews, directory maps and dependency lists do not; leave them out.
- Exact commands with their flags, placed first, are the most used part.
- Clear boundaries beat advice: what to flag, and what never to flag.
- Short files are followed better. Stay under 80 lines.

<procedure>
1. Read the instruction files the repository already has: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.github/copilot-instructions.md`, `.cursor/rules/`, `.github/instructions/`. Keep the rules a reviewer can check against a diff, in your own words. Drop rules about how an agent should work, talk, commit or plan.
2. Read the build files (CMakeLists, CMakePresets, pyproject, Cargo.toml, package.json, Makefile) and the CI workflows for the build, test and lint commands and the platforms CI runs on.
3. Read the linter and formatter config to learn what they already enforce.
4. Skim the main source directories for contracts a change can break: ownership, threading, error handling, ABI or wire formats, generated files, parity checks between layers.
</procedure>

<rules>
Every bullet must be specific enough to check against a diff. Facts from the repository only.
Cite a file or directory only when the rule needs it, with its full path from the repository root. Prefer a path that is unlikely to move: a public header, a config file, a test that enforces the rule. For code that moves, name the file and tell the reader to find it with Glob.
Show a convention with one short code example when the example is clearer than a sentence.
Simplified Technical English: one sentence per line, at most 20 words, active voice.
</rules>

Use exactly these sections, in this order. Leave a section out when the repository gives nothing for it.

```markdown
# <repo name> review notes

<one or two lines: what the project is, its language and build system>

## Commands
- build: `<command with flags>`
- test: `<command with flags>`
- lint: `<command with flags>`

## Flag
- <a defect pattern specific to this repository, and the file or check that shows the rule>

## Conventions the code enforces
- <a rule that differs from the language default, with the config or file that shows it>

## Known pitfalls
- <a trap visible in the code, docs or CI: platforms, build modes, generated files>

## Do not flag
- <what the linter or formatter owns; generated or vendored paths>
```

Answer with the markdown file and nothing else.
