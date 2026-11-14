## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`nemchik/suitescript-verify`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Workflow

When asked to address an issue or to run a flow step (`/implement`, `/code-review` and the rest), read `docs/agents/workflow.md`.

### Skills

Oracle's and Matt Pocock's skills are committed in `.agents/skills/` and managed with `npm run skills:*`. See `docs/agents/skills.md`; run `npm run skills:install` after cloning.

## GitHub Actions

Pin each action to its latest stable release (`gh api repos/<owner>/<repo>/releases/latest`) by commit SHA, with the semver in a trailing comment. Tool versions come from `package.json` `devEngines` (Node, npm), mirrored in `.nvmrc` and `.tool-versions`; change them in all three.

Accepting Oracle's SuiteCloud SDK license is the maintainer's act, never an agent's, and never this package's: do not set `SUITECLOUD_CLI_ACCEPT_LICENSE` in a shell, a file, a workflow or the code. CI installs with `--ignore-scripts` and tests against a fake SuiteCloud CLI.

## Code

Source is TypeScript in `src/` and compiles to `dist/` (gitignored, published). Run `npm run format` before committing; CI runs `biome ci --error-on-warnings` and `tsc`. Build features test-first (`tdd`), through the CLI: `test/cli.test.ts` runs the built bin in a temporary project with a fake `@oracle/suitecloud-cli`.

## Verification

This package is the verification tooling, and the README is the whole guide that ships with each version: the method, setup, deploy, probes, settings and troubleshooting. Read it before changing the runner or a probe flow. Everything a downstream project needs must be in the published package, so do not move guidance into a file the package does not ship. When you hit a runner, deploy, probe or sandbox problem the README does not describe, add it to the matching README section in the same pull request, and correct an entry that proves wrong. A release or toolchain lesson goes in `docs/maintaining.md`. Never run a real deploy or cleanup yourself, never create credentials, never touch production, and never put an account number, URL, user, token or real record id in the repository.

## Releases

Publishing uses npm trusted publishing (OIDC) from `.github/workflows/release.yml`; do not add an `NPM_TOKEN`.
