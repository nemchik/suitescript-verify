# suitescript-verify

Run probes in a NetSuite sandbox to learn what SuiteScript actually does, with guardrails that make it safe for an agent to drive.

## Language

**Probe**:
A version-controlled module that exercises one platform behavior and returns the result as data.
_Avoid_: Test (a probe verifies the platform, not your code)

**Runner**:
The one RESTlet deployed to a sandbox: the entry point for every probe, which runs a probe by name from a fixed list and never runs code from a request.
_Avoid_: Harness

**Script host**:
A script of another type, deployed beside the runner, that runs that type's probes when the runner asks for one and is never reachable without a login.
_Avoid_: Second runner, probe Suitelet

**Suitelet host**:
The script host for Suitelet probes.

**Writing probe**:
A probe that declares it may change the sandbox. The person accepts writing probes when they deploy.
_Avoid_: Write test, unsafe probe

**Runner's role**:
The role the runner's token logs in with. It holds what logging in and calling the runner need, plus Other Addresses, which NetSuite adds. From 3.0 it never holds a probe's permissions.

**Execution role**:
A role the deploy writes for one set of permissions that probes declare. Every probe declaring exactly that set runs under it, and no token ever logs in with it.
_Avoid_: Write role, probe role

**Self-check**:
The runner's reserved, read-only answer about its own deployment: whether the account is a sandbox, the role it runs as and what that role holds, the package version and probes it was deployed with, and whether its script hosts answer. It proves the whole chain without a probe.
_Avoid_: Probe-zero, health check

**Scratch area**:
The place in the sandbox, owned by the package, where writing probes keep what they create so that it can be cleaned up.
_Avoid_: Test data, sandbox folder

**Results page**:
The document in a downstream project that records one verification: the test, the NetSuite version, the output, the explanation and the decision.

**Results folder**:
The folder in a downstream project where its results pages live, named by `SUITESCRIPT_VERIFY_RESULTS_DIR` in the committed `.env`. The package has no default: the project chooses it, and `init` only suggests `docs/verification/results`.

**Lesson**:
A short, generic account of a runner, deploy, probe or sandbox problem: what happened, what it cost and how to avoid it. It holds no account identifiers and no findings about NetSuite itself, which belong on a results page.

**Usage**:
The governance units a probe's run spent, reported for each script that ran it as the units remaining before and after. Each script's limit is its own: the runner and a script host do not share one.
_Avoid_: Cost

**Expected output**:
The `<probe>.expect.json` file holding the result a probe produced when it was verified, so a later run can report drift.

**Downstream project**:
A project that installs this package and keeps its own probes and results pages.

**Verification package**:
This package, `suitescript-verify`: the runner template, the CLI and the guardrails.
