# Sandbox check of a pull request

A pull request that changes what runs in NetSuite (the runner, the Suitelet host, the role, the deploy, `setup`) is checked in a real sandbox before it merges. The check runs in a downstream project's Claude session, with the maintainer at the keyboard for every change to the account. That session only confirms and reports; fixes happen here.

## Hand-off

1. On the pull request, post a comment ending in a `### Still to check in a sandbox` checklist: one box per behavior the fakes cannot show, each naming the expected output. A later comment's list replaces the earlier one.
2. Give the maintainer the prompt below with `<PR>` and `<SHA>` filled in, plus any probes the checklist needs that the downstream project does not have yet.
3. When the maintainer says the comment is posted, read it. Each failure, package lesson and platform finding becomes a fix on a branch here.
4. `/code-review` the fix branch before it merges into the pull request's branch. Four unreviewed fix passes on #46 let a wrong README claim through.
5. Reply on the pull request, mapping each finding to its change.

## Prompt

```text
Check suitescript-verify PR #<PR> at commit <SHA> in this project, then post one comment on that PR.

1. Build the commit: in a clone of nemchik/suitescript-verify outside this project, check out <SHA>, then run `npm ci`, `npm run build` and `npm pack` (dist/ is not committed, so a git install has no built code). Install the .tgz as a dev dependency here. Before any commit in this project, restore package.json and the lock file, since the install writes a `file:` path to a temporary tarball.
2. Read the README at that commit and the pull request's latest "Still to check in a sandbox" list (`gh pr view <PR> --repo nemchik/suitescript-verify --comments`). Work through every box. Run `doctor` before and after each deploy.

Rules:
- Only the sandbox. Read-only checks (SuiteQL on a role's permissions, for example) use the maintainer's NetSuite connector for that sandbox; ask which one if it is unclear. Never production or its connector.
- I run everything that changes the account: `deploy --approved`, `cleanup`, `setup` / `setup-ci`, key pairs, certificates, mappings, roles and their permissions. Give me the exact command or screen steps, then wait for my result. You run dry runs, `doctor` and `run`.
- Never set SUITECLOUD_CLI_ACCEPT_LICENSE.
- No account number, URL, email, user, token, certificate id or record id in the comment: use placeholders such as `<account>`.

The comment, posted with `gh pr comment <PR> --repo nemchik/suitescript-verify --body-file <file>` after I approve its text:
- A table: one row per box, Pass or Fail, one line of redacted evidence.
- Package lessons: each runner, deploy, probe or setup problem, with the symptom, how to reproduce it, and what the README or code should say.
- Platform findings: how NetSuite itself behaved where it differs from the README, with the NetSuite version and the evidence.
- Problems the README does not describe, even ones you worked around.
Leave the merge decision to the maintainer and this repository's session.
```
