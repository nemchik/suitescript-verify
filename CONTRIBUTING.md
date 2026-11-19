# Contributing

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

Use the Node.js version in `.nvmrc` (mirrored in `package.json` `devEngines`). npm refuses a different version.

```sh
npm install
npm run skills:install   # optional unless you use agents
npm test
```

`npm run format` type-checks and applies Biome's fixes. Write features test-first through the CLI (`test/cli.test.ts`, against a fake SuiteCloud CLI). Use Conventional Commits. A lesson about using the package goes where the README's "Adding a lesson" section says. A release, build or toolchain problem in this repository goes in `docs/maintaining.md` instead, which does not ship because it does not apply to anyone using the package. Never set `SUITECLOUD_CLI_ACCEPT_LICENSE`; accepting Oracle's license is each project maintainer's act.

## Writing the README

The README is the whole guide for a project that uses the package. People and agents read the copy installed with their version in `node_modules`, not this repository, so:

- **Everything a consumer needs ships in the README.** Never point it at a file the package does not publish (this repository's docs, ADRs, tests or config). `npm test` fails when the README names one.
- **Order:** the pitch, install and a quick start, then the contents list, then the sections.
- **Steps are numbered**, with at most one code block each.
- **Settings and errors go in tables.**
- **Troubleshooting is by symptom:** each heading is what the person sees (the message or the failure), and the body gives the cause and the fix.
- **Exactly three badges:** npm version, CI and license.
- **Notes are plain bold lines** starting `**Note:**`, not blockquotes or GitHub alerts.
- **A platform fact is settled only once a sandbox run showed it.** Write what the run observed, not the cause you infer from it ("the runner sees only the first value", not "`requestSuitelet` keeps only the first value"). Anything a run has not shown carries one sentence saying it is not yet confirmed; the pull request whose run settles it removes that sentence and names the NetSuite version.
- **Past about 500 lines, stop.** Bring the maintainer a plan to split the README into shipped files before splitting it.
