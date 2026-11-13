# Verification

Oracle's skills, type definitions and documentation disagree with each other and sometimes with the platform. A verification is a test run in a NetSuite account that shows what the platform actually does. Where a source's claim about platform behavior and the verified behavior differ, the verified behavior wins.

## When to verify

Verify, or mark the claim **unverified**, whenever you depend on what the platform accepts, rejects or returns, research how a module, method or script type behaves, or find a source that contradicts itself or another. An unverified claim stays marked unverified until a results page settles it. Do not mark a claim verified from a paraphrase of documentation: verified means a test ran.

## For agents

If you can run the test yourself, do: a **probe** runs in a sandbox through the runner. Setup is mostly the person's (browser login, role, certificate), so when a check fails, relay its next step and wait. Run `suitescript-verify doctor` first. Before you write a batch of probes read [`lessons.md`](lessons.md): each probe change costs a deploy, and one bad probe can take the whole runner down. When you hit a runner, deploy, probe or sandbox problem that page does not describe, add it there in the same pull request (what happened, what it cost, how to avoid it), and correct any entry that proves wrong.

Prompt the person to run a snippet by hand (the methods below) only when a probe cannot run: setup cannot pass, the claim depends on a script type the runner does not cover (anything but a RESTlet), or the probe would write to the account. Give the exact snippet and say where to run it. Never run anything in production.

## Methods

Record the method, the NetSuite version (for example `2026.2`; Help > About), and whether the account is a sandbox or production.

**Do not put the account number in a verification**, nor an account URL, user, token or the internal id of a real record. They identify a company's account, they are not needed to reproduce a result, and they are a security risk in a public repository. Replace ids with placeholders.

### Client scripts: browser console

Open any record page, open the developer tools console, load modules with `require` and print the results:

```js
require(["N/util"], function (u) {
    console.log(JSON.stringify({ isArray: u.isArray([]) }));
});
```

This runs in the browser's engine, not the server's, so it says nothing about server-only behavior.

### Server scripts, quick: script debugger

Customization > Scripting > Script Debugger. It runs on the server but behaves differently from a deployed script in places. Confirm a surprising result with a deployed script.

### Server scripts, authoritative: a deployed script

Upload a script, create the Script record and a Deployment (status Testing, audience yourself) and call it. Other script types can behave differently from a RESTlet: test the script type you care about.

## Documenting a verification

Write one page per verification (lowercase, hyphens, for example `util-each.md`) in your project's results folder. Every section is required: a verification without its test, results and decision is not a verification.

```markdown
# <What was verified>

- **NetSuite version:** 2026.2
- **Account type:** sandbox
- **Date:** YYYY-MM-DD
- **Method:** browser console | script debugger | deployed <script type> | deployed RESTlet (the runner)
- **Probe:** the path to the probe, when there is one

## Test

The script, verbatim, so anyone can run it again.

## Results

The raw output, including error messages.

## Explanation

What the results mean, and how they relate to what each source claims.

## Decision

What was decided because of the results.
```
