# Agent skills

The agent skills this repo relies on are committed in `.agents/skills/`, so every contributor and every agent uses the same copy, version controlled with the code. Two sources are installed, in full:

- [`oracle/netsuite-suitecloud-sdk`](https://github.com/oracle/netsuite-suitecloud-sdk/tree/master/packages/agent-skills): Oracle's NetSuite agent skills.
- [`mattpocock/skills`](https://github.com/mattpocock/skills): the workflow skills (triage, grilling, TDD, domain modeling, code review) that `AGENTS.md` and `docs/agents/*` assume.

## Tooling

Skills are managed with [`skills`](https://github.com/vercel-labs/skills), pinned in `devDependencies`. It installs to the universal `.agents/skills/` location that most agents read, and records each skill's source and content hash in `skills-lock.json`. Neither Oracle's skills nor Matt Pocock's are published to npm, so the lock file, not `package-lock.json`, pins them.

Claude Code reads `.claude/skills/` instead. `.claude/skills/` is gitignored and holds links to `.agents/skills/`, created by `npm run skills:install`. Committed symlinks would not survive a Windows checkout.

## Commands

| Command                              | Does                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `npm run skills:install`             | Restores `.agents/skills/` from `skills-lock.json` and links it into `.claude/skills/`. Run it after cloning. |
| `npm run skills:list`                | Lists installed skills and their sources.                                                                     |
| `npm run skills:check`               | Exits 1 when any installed skill has an update.                                                               |
| `npm run skills:update`              | Updates every skill to its source's latest, rewrites the lock and relinks.                                    |
| `npm run skills:add -- <owner/repo>` | Installs every skill from a new source (universal, plus the Claude Code links).                               |
| `npm run skills -- <args>`           | Runs any other `skills` command (`remove`, `find`, `--help`) without `npx`.                                   |

`skills:install` leaves skills that are already present as they are and fails in CI when a skill's content does not match the lock.

## Plugins that duplicate the skills

If you also have the `mattpocock-skills`, `netsuite-suitecloud`, `netsuite-ai-companion` or `netsuite-finance-analyst` Claude plugins installed, their skills load next to the committed ones as `/<plugin>:<skill>`. The repo's copy takes priority, so `.claude/settings.json` denies the plugin copy of every skill that this repo also carries. Plugin skills the repo does not carry (for example `mattpocock-skills:resolving-merge-conflicts` and the whole `netsuite-suiteskills` plugin) stay available. Disabling a whole plugin per machine (`enabledPlugins` in `.claude/settings.local.json`) is no longer needed.

When a source adds a skill and a plugin carries it too, add a matching `Skill(<plugin>:<skill>)` deny entry.

## Updates

`.github/workflows/sync-skills.yml` runs `npm run skills:update` every Monday and opens a pull request when anything changed. Do not edit files in `.agents/skills/` by hand: the next update overwrites them, and the lock hash stops matching.

Two things make the update and the lock file reproducible across machines, and `scripts/skills.ts` (behind every `npm run skills*` command) handles both:

- **Line endings.** `skills-lock.json` holds a hash of each skill's files, taken from a git clone of the source. A clone with `core.autocrlf=true` (the Windows default) has CRLF endings and a different hash from CI's, so every skill reads as outdated. The script forces `core.autocrlf=false` for the CLI's git calls only, leaving your git config alone. Run the CLI through `npm run skills -- <args>`, never as a bare `skills` or `npx skills`, or a Windows run writes CRLF hashes into the lock.
- **Agent detection.** A CI runner has no agent, and without one `skills update` targets every supported agent, including Eve, and writes a second copy of every skill to `agent/skills/` (pull request #107). The script sets `AI_AGENT=claude` unless the environment names an agent, and the workflow sets it too. A step after the update fails the job when anything outside `.agents/skills/` and `skills-lock.json` changed.

Biome ignores `skills-lock.json` (`biome.jsonc`): the CLI generates it, and its key order (`version` first) fails `useSortedKeys`.

The update pull request is opened with the default token, so GitHub does not start the required checks on it. A maintainer has to start them (approve the workflow runs, or push to the branch) and approve the pull request as code owner before it merges.
