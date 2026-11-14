# suitescript-verify

Run probes in a NetSuite sandbox to learn what SuiteScript actually does, with guardrails that make it safe for an agent to drive.

## Language

**Probe**:
A version-controlled module that exercises one platform behavior and returns the result as data.
_Avoid_: Test (a probe verifies the platform, not your code)

**Runner**:
The one RESTlet deployed to a sandbox that runs a probe by name from a fixed list and never runs code from a request.
_Avoid_: Harness

**Results page**:
The document in a downstream project that records one verification: the test, the NetSuite version, the output, the explanation and the decision.

**Results folder**:
The folder in a downstream project where its results pages live, named by `SUITESCRIPT_VERIFY_RESULTS_DIR` in the committed `.env`. The package has no default: the project chooses it, and `init` only suggests `docs/verification/results`.

**Lesson**:
A short, generic account of a runner, deploy, probe or sandbox problem: what happened, what it cost and how to avoid it. It holds no account identifiers and no findings about NetSuite itself, which belong on a results page.

**Expected output**:
The `<probe>.expect.json` file holding the result a probe produced when it was verified, so a later run can report drift.

**Downstream project**:
A project that installs this package and keeps its own probes and results pages.

**Verification package**:
This package, `suitescript-verify`: the runner template, the CLI and the guardrails.
