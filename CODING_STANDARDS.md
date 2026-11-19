# Coding standards

Read during review. These are judgement calls that no linter can make. Biome, `tsc`, the tests and CodeQL enforce the mechanical rules, so a review skips anything they already catch.

## Committed output fails closed

A downstream project commits what this package writes: `expect.json`, run results and drafts. Anything secret in them ends up in someone's repository.

- **Every path from a NetSuite response to a written file goes through the scrubber or an allowlist.** That covers bodies, headers, cookies, file names, error messages and HTML trailers. Trace each new field the diff writes back to the point where it is scrubbed. If it is never scrubbed, flag it as a hard violation.
- **New data defaults to dropped or redacted.** A header, cookie or field the code does not know is left out or written as `<redacted>`. It is never passed through because it looked harmless in a test. Allowlists name what may pass; a denylist on its own is a violation.
- **The runner and the CLI agree.** Redaction in `templates/*.js` (which runs in NetSuite) and in `src/` (which re-checks locally) apply the same rules. A change to one side without the other is a violation.
- **Fakes model the real platform.** When the sandbox has shown how NetSuite behaves (a followed redirect, header casing, first-value headers, trailing HTML comments), the fake in `test/` reproduces it. A test that passes only because the fake is kinder than NetSuite is a violation.

The same rule binds the repository itself: no account number, URL, user, token or real record id in code, tests, fixtures or docs (see `AGENTS.md`).
