# Contributing

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

```sh
npm install
npm run skills:install   # optional unless you use agents
npm test
```

`npm run format` type-checks and applies Biome's fixes. Write features test-first through the CLI (`test/cli.test.ts`, against a fake SuiteCloud CLI). Use Conventional Commits. Never set `SUITECLOUD_CLI_ACCEPT_LICENSE`; accepting Oracle's license is each project maintainer's act.
