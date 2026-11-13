# suitescript-verify

Run probes in a NetSuite **sandbox** to verify what SuiteScript modules do, from a CLI that is safe to hand to an agent: sandbox only, a person approves every write at a terminal, and output is scrubbed of identifiers.

> This package never accepts Oracle's SuiteCloud license. Install `@oracle/suitecloud-cli` in your project and accept the license yourself.

Early version: `help`, `init`, `doctor` and `deploy` exist. The rest of the CLI (`certificate`, `passkey`, `env`, `setup-ci`, `run`, `cleanup`) is being extracted from an existing project.

```sh
npm install --save-dev suitescript-verify @oracle/suitecloud-cli
npx suitescript-verify help
```

`init` scaffolds `verification/probes`, `verification/sdf`, `docs/verification/results` and a committed `verification/.env` of layout keys, then prints a to-do list. It creates no credentials. `doctor` checks the SuiteCloud CLI, account, sandbox, certificates, passkey and project files, and says which failing steps are the maintainer's own; it exits 1 while any fails.

`deploy` dry-runs the runner deployment through your project's SuiteCloud CLI from `verification/sdf` (`--dir <path>` moves `verification/`). A real deploy needs `--approved` and a person at a terminal who types `DEPLOY`.

See [docs/verification/README.md](docs/verification/README.md) and [docs/verification/lessons.md](docs/verification/lessons.md).

## Development

You need the Node.js and npm versions in `package.json` `devEngines`.

```sh
npm install
npm run skills:install   # optional: restores the agent skills for Claude Code
npm test                 # builds, then runs the CLI tests against a fake SuiteCloud CLI
npm run format           # type-checks, then applies Biome's fixes
```

Git hooks (lefthook) run Biome on staged files before each commit.

## License

MIT
