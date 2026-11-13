# suitescript-verify

Run probes in a NetSuite **sandbox** to verify what SuiteScript modules do, from a CLI that is safe to hand to an agent: sandbox only, a person approves every write at a terminal, and output is scrubbed of identifiers.

> This package never accepts Oracle's SuiteCloud license. Install `@oracle/suitecloud-cli` in your project and accept the license yourself.

```sh
npm install --save-dev suitescript-verify @oracle/suitecloud-cli
npx suitescript-verify help
```

`init` scaffolds `verification/probes`, `verification/sdf`, `docs/verification/results` and a committed `verification/.env` of layout keys, then prints a to-do list. It creates no credentials. `doctor` checks the SuiteCloud CLI, account, sandbox, certificates, passkey and project files, and says which failing steps are the maintainer's own; it exits 1 while any fails.

`certificate` generates the runner key pair (EC P-256) and the SDF key pair (RSA-4096) outside the project with `openssl` (`--keys-dir`, default `~/.suitescript-verify`), `passkey` and `env set NAME=value` save settings in the gitignored `verification/.env.local` (values are never printed; a different existing value is kept unless `--overwrite`), and `setup-ci` registers the SDF credentials with the SuiteCloud CLI.

`setup-ci` prepares a pipeline: it registers the SDF credentials (auth id `suitescript-verify`) with your project's SuiteCloud CLI and passes the passkey to it through the environment, never an argument. On success it prints the `SUITESCRIPT_VERIFY_` names the pipeline must supply as its own secrets (account, client id, both certificate ids, both private key paths, passkey), never a value. It writes no file, no credential variable and no license variable, and it holds no credential itself: the pipeline provides them. Accepting Oracle's SuiteCloud license in the pipeline is yours.

`deploy` generates the runner and an SDF project into `verification/sdf` (the generated `src/` and `package.json` there are yours to gitignore) from the RESTlet probes in `verification/probes`, then dry-runs it through your project's SuiteCloud CLI. A real deploy needs `--approved` and a person at a terminal who types `DEPLOY`. `cleanup` does the same with the runner's deployment switched off and needs `CLEANUP`. `--dir <path>` moves `verification/`.

`run <probe> [--draft]` runs one probe by name through the deployed runner. The name must be one of the probes in the folder: the runner only runs the fixed list generated into it and never code from a request. Output is scrubbed of the account, client and certificate ids, and refused if it still looks like an identifier. A probe with an `<probe>.expect.json` is compared with it and a difference exits 2 as drift. `--draft` writes `docs/verification/results/<probe>.md` (never over an existing page) with the test, NetSuite version and results, and empty explanation and decision sections. Probes must declare `@scriptType Restlet` and no `@writes`.

A probe takes data by declaring parameters in its leading JSDoc block, one tag per parameter: `@param <name> <pattern>`. The name is lowercase-initial letters and digits (`recordType`); the pattern is a JavaScript regular expression (Unicode mode) that the whole value must match, so `[a-z_]+` cannot match `a;b`. Pass each value with `run <probe> --param name=value`. Every declared parameter is required and its value is always a string. The runner validates the parameters against the declarations before any request, rejecting an invalid, undeclared, missing or repeated one, and a probe that declares none takes none; the generated runner checks them again and hands the probe only declared strings in `run(params)`. A value goes in the JSON request body and is never evaluated or turned into code. A bad `@param` tag (no pattern, an invalid pattern, a duplicate name) stops `run` and `deploy`.

The package validates the tags in a probe's leading JSDoc block: `@scriptType`, `@writes`, `@param`, the NetSuite `@NApiVersion`, `@NScriptType` and `@NModuleScope`, and the ordinary `@see`, `@link`, `@example`, `@returns`, `@since` and `@deprecated`. Any other tag is reported and stops `run` and `deploy`, so a typo cannot pass silently. A project that keeps its own tags registers them with `SUITESCRIPT_VERIFY_EXTRA_TAGS`, a comma-separated list of tag names without the `@` (for example `SUITESCRIPT_VERIFY_EXTRA_TAGS=flavor,other`). Like every `SUITESCRIPT_VERIFY_` setting it layers from the committed `verification/.env`, the gitignored `.env.local` and the process environment. In the committed file the value must be a list of tag names and must not look like a secret. The package checks only that a registered tag is known; what a tag means is up to the project.

```js
/**
 * @scriptType Restlet
 * @param recordType ^[a-z_]+$
 */
define(["N/record"], (record) => ({
  run: ({ recordType }) => /* ... */,
}));
```

Every command that reaches the sandbox refuses an account that is not a sandbox (`digits_SBn`). The runner uses the script id `customscript_suitescript_verify_runner` and is limited to a role with the ID `customrole_suitescript_verify`, which you create in the sandbox.

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
