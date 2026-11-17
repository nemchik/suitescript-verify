# suitescript-verify

[![npm version](https://img.shields.io/npm/v/suitescript-verify)](https://www.npmjs.com/package/suitescript-verify)
[![CI](https://img.shields.io/github/actions/workflow/status/nemchik/suitescript-verify/ci.yml?branch=main&label=CI)](https://github.com/nemchik/suitescript-verify/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/suitescript-verify)](LICENSE)

Run probes in a NetSuite **sandbox** to verify what SuiteScript modules do, from a CLI that is safe to hand to an agent: sandbox only, a person approves every write at a terminal, and output is scrubbed of identifiers.

> This package never accepts Oracle's SuiteCloud license. Install `@oracle/suitecloud-cli` in your project and accept the license yourself.

```sh
npm install --save-dev suitescript-verify @oracle/suitecloud-cli
npx suitescript-verify help
```

This README is the whole guide and ships with each published version. Read the copy installed with the package, which matches the version you use: `suitescript-verify init` prints its path (it is in `node_modules/suitescript-verify/` under npm and pnpm).

## Contents

- [Verification method](#verification-method): when to verify, how, and how to record it
- [Setup](#setup): `init`, credentials, the role and `doctor`
- [Deploy](#deploy): put the runner in the sandbox
- [Probes](#probes): write and run them
- [Settings](#settings): every `SUITESCRIPT_VERIFY_` key
- [Troubleshooting](#troubleshooting): by symptom
- [Adding a lesson](#adding-a-lesson)
- [Development](#development)

## Verification method

Oracle's skills, type definitions and documentation disagree with each other and sometimes with the platform. A verification is a test run in a NetSuite account that shows what the platform actually does. Where a source's claim about platform behavior and the verified behavior differ, the verified behavior wins.

### When to verify

Verify, or mark the claim **unverified**, whenever you depend on what the platform accepts, rejects or returns, research how a module, method or script type behaves, or find a source that contradicts itself or another. An unverified claim stays marked unverified until a results page settles it. Do not guess a result, and do not mark a claim verified from a paraphrase of documentation: verified means a test ran.

### For agents

- If you can run the test yourself, do: a **probe** runs in a sandbox through the runner, RESTlet and Suitelet probes alike. Run `suitescript-verify doctor` first.
- Setup is mostly the person's (browser login, role, certificate). When a check fails, relay its next step and wait.
- Never run anything in production, never create credentials, and never run a real deploy or cleanup yourself: both need a person at a terminal.
- Prompt the person to run a snippet by hand (the methods below) only when a probe cannot run: setup cannot pass, the claim depends on a script type the runner does not cover (anything but a RESTlet or a Suitelet), or the probe would write to the account. Give the exact snippet and say where to run it.
- Before you write a batch of probes, read [Probes](#probes) and [Troubleshooting](#troubleshooting): each probe change costs a deploy, and one bad probe can take the whole runner down.

### Methods

Record the method, the NetSuite version (for example `2026.2`; Help > About), and whether the account is a sandbox or production.

| Method                          | Use it for                                                        | Limits                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The runner (a deployed RESTlet) | RESTlet and Suitelet behavior                                     | Sandbox only; RESTlet and Suitelet probes only (a Suitelet probe runs in the Suitelet host, which the runner calls)                                                                                   |
| Browser console                 | Client scripts                                                    | Runs in the browser's engine, so it says nothing about server-only behavior (`typeof performance` differs between the two)                                                                            |
| Script debugger                 | Quick server checks (Customization > Scripting > Script Debugger) | Behaves differently from a deployed script in places (`util.nanoTime` throws there); confirm a surprising result with a deployed script                                                               |
| A deployed script               | The authoritative server result                                   | Upload a script, create the Script record and a Deployment (status Testing, audience yourself) and call it; other script types can behave differently from a RESTlet, so test the type you care about |

In the browser console, open any record page, open the developer tools, load modules with `require` and print the results:

```js
require(["N/util"], function (u) {
    console.log(JSON.stringify({ isArray: u.isArray([]) }));
});
```

For a deployed script, record each check's result or error so one throw does not hide the rest. A minimal Suitelet, opened from its deployment URL:

```js
/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([], () => ({
    onRequest({ response }) {
        const r = {};
        const t = (k, f) => {
            try {
                r[k] = f();
            } catch (e) {
                r[k] = "THROWS: " + e.name + ": " + e.message;
            }
        };
        t("example", () => typeof util.isArray);
        response.write(JSON.stringify(r, null, 1));
    },
}));
```

**Note:** do not put the account number in a verification, nor an account URL, user, token or the internal id of a real record. They identify a company's account, they are not needed to reproduce a result, and they are a security risk in a public repository. Replace ids with placeholders.

### Documenting a verification

Write one page per verification (lowercase, hyphens, for example `util-each.md`) in your project's results folder. Every section is required: a verification without its test, results and decision is not a verification. `run <probe> --draft` writes the page with the test, NetSuite version and results filled in.

```markdown
# <What was verified>

- **NetSuite version:** 2026.2
- **Account type:** sandbox
- **Date:** YYYY-MM-DD
- **Method:** browser console | script debugger | deployed <script type> | deployed RESTlet (the runner) | deployed Suitelet (the Suitelet host, called by the runner)
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

## Setup

Every step that creates a credential or accepts a license is the person's. `init` creates none.

1. **Scaffold.** `suitescript-verify init` creates `verification/probes`, `verification/sdf`, your results folder and a committed `verification/.env` of layout keys, then prints a to-do list. `--dir <path>` moves `verification/`.
   - The package imposes no layout for results. Where results pages live is your choice, set as `SUITESCRIPT_VERIFY_RESULTS_DIR` in the committed `.env` (a path inside the project).
   - `init` will not pick it for you: at a terminal it asks (suggesting `docs/verification/results`), and without one it needs `--results-dir <path>`, for example `init --results-dir docs/verification/results`.
   - A project that already sets the key is not asked again, and a command that needs the folder without the key stops and names it.
2. **Install the SuiteCloud CLI** (`@oracle/suitecloud-cli`) in your project and accept Oracle's license yourself. On a desktop machine its postinstall opens the license. A headless machine needs the maintainer to accept it first, or an install with `--ignore-scripts` (see [Troubleshooting](#the-suitecloud-cli-postinstall-exits-3)).
3. **Gitignore `verification/.env.local`** before saving any value: it holds credentials.
4. **Create the certificate pairs.** `suitescript-verify certificate` generates both key pairs outside the project with `openssl` (`--keys-dir`, default `~/.suitescript-verify`; `--only runner|sdf`; `--overwrite` or `--keep`).

   | Pair   | Key type                             | Used for                                                 |
   | ------ | ------------------------------------ | -------------------------------------------------------- |
   | Runner | EC P-256, signed ES256               | The token for calls to the runner                        |
   | SDF    | RSA-4096 with an RSA-PSS certificate | Oracle's SDK login (PS256), which only parses an RSA key |

   Oracle allows one certificate per integration, role and entity, so the two pairs cannot be shared, and an EC key fails the SDF login (see [Troubleshooting](#setup-ci-fails-with-an-error-with-the-private-key)).
5. **In the sandbox, in one visit, create the integration record, the runner's role and both certificate mappings.**
   - **The integration record** needs more than the machine-to-machine grant: also enable the token-based authentication flags and the RESTlets and REST Web Services scopes (see [Troubleshooting](#every-call-fails-with-401-invalid_login_attempt)).
   - **The runner's role:** create it with only its name and id, and assign it to yourself. The id is `customrole_<runner id>` (`customrole_suitescript_verify` by default; `doctor` prints the one in use), and the name `ssv runner role <runner id>`. Leave its permissions empty: every deploy writes the role as an SDF object, so the first deploy takes it over and gives it exactly `ADMI_LOGIN_OAUTH2` (Log In Using OAuth 2.0 Access Tokens) and `ADMI_RESTWEBSERVICES` (REST Web Services), both at Full, on the Account center, with every other flag at its default. A permission added by hand does not survive the next deploy.
   - **The SDF certificate** maps to a role that can deploy, never the runner's role, since a deploy that rewrote its own login role would strip the permissions the next deploy needs. In a sandbox that can be Administrator; otherwise use a deploy role with SuiteScript, Documents and Files, Allow JS/HTML Uploads and Bulk Manage Roles.
   - **The runner certificate** maps to the runner's role.
   - **Each project needs its own role.** A deploy rewrites the role, so two projects deploying one role would overwrite each other. The default id follows the runner id, so projects with their own runner id (see [Deploy](#deploy)) already have their own role. `SUITESCRIPT_VERIFY_ROLE_ID` sets another id and wins over the default; do not rely on changing an id later, since a custom role's id may be read-only after saving. The platform rejects a role id over 40 characters, `customrole_` included, so the id after the prefix is at most 29 characters; the package refuses a longer one before it reaches the sandbox.
   - **In a OneWorld account** the role gets every subsidiary: the generated role names none, so it deploys in any account.
6. **Save the settings.** `suitescript-verify passkey` generates the SuiteCloud passkey into `verification/.env.local`. `suitescript-verify env set NAME=value` saves any other key there (values are never printed; a different existing value is kept unless `--overwrite`). See [Settings](#settings) for the names.
7. **Run `suitescript-verify doctor`** until every step passes. It checks the SuiteCloud CLI, Java 17 or 21, the SuiteCloud SDK jar and login, account, sandbox, certificates, passkey and project files, says which failing steps are the maintainer's own, and exits 1 while any fails.
8. **`suitescript-verify setup-ci`** (for a pipeline) registers the SDF credentials (auth id `suitescript-verify`) with your project's SuiteCloud CLI, passing the passkey through the environment, never an argument. On success it prints the `SUITESCRIPT_VERIFY_` names the pipeline must supply as its own secrets, never a value. It writes no file, no credential variable and no license variable. Accepting Oracle's license in the pipeline is yours.

**Note:** projects on one machine that register the same SDF auth id (this package always uses `suitescript-verify`) share one stored credential entry. That is harmless while their certificate and passkey values match; when they differ, the later `setup-ci` replaces the earlier entry.

**Note:** never put `SUITECLOUD_CI_PASSKEY` in your user-wide environment. It stops browser login in your other SuiteCloud projects. Keep the passkey in `.env.local`, where the package hands it to the CLI for its own child process only.

Every command that reaches the sandbox refuses an account that is not a sandbox (`digits_SBn`).

### Keeping the tooling in a subfolder

A project that publishes its own package from the repository root may keep the tooling in a subfolder that is an npm project of its own, with its own `package.json` and `node_modules` holding `suitescript-verify` and `@oracle/suitecloud-cli`. The package treats the folder it runs in as the project, so run it from the subfolder and pass `--dir .`, which makes the subfolder itself the verification folder (its `.env`, `.env.local`, `probes` and `sdf`):

```json
{
    "scripts": {
        "verify:doctor": "suitescript-verify doctor --dir .",
        "verify:run": "suitescript-verify run --dir ."
    }
}
```

A script at the repository root then calls it with `npm --prefix <subfolder> run verify:doctor --`. Give `init`, `deploy`, `cleanup` and the other commands the same `--dir .`. The subfolder's `.env.local` is checked against the repository's `.gitignore`.

## Deploy

```sh
suitescript-verify deploy              # generate, then dry-run
suitescript-verify deploy --approved   # the real deploy: a person at a terminal types DEPLOY
suitescript-verify cleanup --approved  # turns the runner's and Suitelet host's deployments off: the person types CLEANUP
```

`deploy` generates the runner and an SDF project into `verification/sdf` (the generated `src/` there is yours to gitignore) from the RESTlet and Suitelet probes in `verification/probes`, then dry-runs it through your project's SuiteCloud CLI. `cleanup` does the same with the deployments switched off, and without `--approved` it is a dry run. Both write the runner's role (see [Setup](#setup)); `cleanup` leaves it unchanged, since switching it off would break its token mapping. Every script is named by its type, with Oracle's suggested abbreviation as the suffix: the runner (a RESTlet) has the script id `customscript_suitescript_verify_rl`, the deployment id `customdeploy_suitescript_verify_rl`, the file `restlet.js` and the name `ssv runner suitescript_verify`, all from the runner id (`SUITESCRIPT_VERIFY_RUNNER_ID`, default `suitescript_verify`). The [Suitelet host](#suitelet-probes) beside it has the script id `customscript_suitescript_verify_sl`, the deployment id `customdeploy_suitescript_verify_sl`, the file `suitelet.js` in the same folder and the name `ssv suitelet suitescript_verify`. Every deploy generates both, even with no Suitelet probes, and `cleanup` switches both deployments off.

- **Projects that share a sandbox need their own runner id.** A deploy replaces the runner's probe list, so two projects with the same runner id overwrite each other: whichever deployed last decides which probes exist, and the other's answer `unknown probe` until it deploys again. Set a different `SUITESCRIPT_VERIFY_RUNNER_ID` in each project's committed `.env` (for example `my_project`). The runner, its deployment, its name and its File Cabinet folder are named from it (`customscript_my_project_rl`, `ssv runner my_project`, `my-project`), and so is the runner's role (`customrole_my_project`), which needs its own token mapping. The id is at most 24 characters because the platform rejects a script or deployment id over 40 characters, prefix included (`The script ID must not exceed 40 characters.`): `customscript_` and `customdeploy_` take 13 and the type suffix (`_rl`, `_sl`) takes 3. The platform also caps a script's name at 40 characters (`The name field contains more than the maximum number (40) of characters allowed.`), and `ssv suitelet ` takes 13, so a 24-character id fits there too. Changing a project's id leaves its old runner deployed in the sandbox, because the SuiteCloud CLI cannot delete a script. The next `deploy` or `cleanup` removes the old runner and its Suitelet host from the generated SDF folder (so it is not deployed again) and warns with the old id; to turn the old runner off, run `cleanup --approved` once with `SUITESCRIPT_VERIFY_RUNNER_ID` set to the old id, then switch back. A runner generated by 1.x (`customscript_<id>_runner`) is removed and warned about the same way, whatever its id, because 2.0 names it differently and cannot turn it off; run `cleanup --approved` with 1.x and that id to turn it off. The warning only sees runners generated in this folder.
- **Every probe change needs a deploy.** The runner's probe list is generated into its dependency list, so a new, renamed or edited probe only exists in the sandbox after a deploy. Write and review **all** the probes of a batch first, dry-run once, and ask for one deploy. A deploy is the person's, in their own terminal, so a wasted one costs a person's time.
- **After every deploy, run the chain-proving probe first** (a trivial probe, for example `probe-zero`, that only proves the runner loads). If it fails, the runner is broken and no other result means anything (see [Troubleshooting](#every-probe-returns-http-400-and-names-no-probe)).
- **A sandbox refresh clears the token mappings and, presumably, the deployed runner.** After one, redo the role, mapping and deploy steps.

## Probes

A probe is a version-controlled module that exercises one platform behavior and returns the result as data. It must declare `@scriptType Restlet` or `@scriptType Suitelet`, and no `@writes`. Any other script type is refused by `run` and left out of `deploy`.

```js
/**
 * @scriptType Restlet
 * @param recordType ^[a-z_]+$
 */
define(["N/record"], (record) => ({
  run: ({ recordType }) => /* ... */,
}));
```

### Running one

```sh
suitescript-verify run <probe> [--param name=value ...] [--draft]
```

- The name must be one of the probes in the folder: the runner only runs the fixed list generated into it and never code from a request.
- Output is scrubbed of the account, client and certificate ids, and refused if it still looks like an identifier.
- A probe with an `<probe>.expect.json` is compared with it, and a difference exits 2 as drift. The expectation is the `result` object (or, for a Suitelet probe that writes its own response, the `response` object), sorted and indented, not the whole output. Write it from a real run's output, never a guess, so a new probe has none until it has run once. A probe whose output changes on every run (a row count, a timestamp) cannot have one: it would report drift every time, so say on the results page why there is none.
- The output says which script type ran the probe: `"scriptType": "RESTlet"` or `"scriptType": "Suitelet"`.
- `--draft` writes `<probe>.md` into your results folder, never over an existing page. A draft goes stale: after a probe changes, refresh the page's Test and Results sections from the probe and its expected output.

### Parameters

Declare each parameter in the probe's leading JSDoc block, one tag per parameter: `@param <name> <pattern>`.

- The name is lowercase-initial letters and digits (`recordType`).
- The pattern is a JavaScript regular expression (Unicode mode) that the whole value must match, so `[a-z_]+` cannot match `a;b`.
- Pass each value with `run <probe> --param name=value`. Every declared parameter is required and its value is always a string.
- The runner validates the parameters against the declarations before any request, rejecting an invalid, undeclared, missing or repeated one. A probe that declares none takes none.
- The generated runner checks them again (and the Suitelet host a third time, for a Suitelet probe) and hands the probe only declared strings in `run(params)` (`run(params, context)` for a Suitelet probe). A value goes in the JSON request body and is never evaluated or turned into code.
- A bad `@param` tag (no pattern, an invalid pattern, a duplicate name) stops `run` and `deploy`.

### Suitelet probes

A probe that declares `@scriptType Suitelet` runs in the **Suitelet host**, a Suitelet deployed beside the runner. It exports `run(params, context)`, with the same declared parameters as a RESTlet probe:

- `context.request` holds only `method` and `parameters` (the declared parameters). The request's headers, cookies and body are never shown, so a probe cannot return them.
- `context.response` records every write, page, file, redirect and header call (`write`, `writeLine`, `writePage`, `writeFile`, `renderPdf`, `sendRedirect`, `setCdnCacheable`, `setHeader`, `addHeader`). Nothing reaches the real response until the probe returns. `getHeader` and `headers` answer from what it recorded.

When the probe returns, the host answers in one of two modes:

| The probe                                   | Mode      | What `run` reports                                                                                            |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| Returns a value and makes no response calls | `wrapped` | `result`, like a RESTlet probe, compared with its expected output the same way                                |
| Makes response calls and returns nothing    | `own`     | `response`: `{ status, headers, body }` of the HTTP response the runner saw, with the calls replayed in order |
| Does both                                   | error     | `the probe both wrote a response and returned a value`                                                        |
| Throws, before or after writing             | `wrapped` | `result` is `THROWS: <name>: <message>`; nothing it wrote is replayed                                         |

```js
/**
 * @scriptType Suitelet
 */
define([], () => ({
    run: (params, { response }) => {
        response.addHeader({
            name: "Set-Cookie",
            value: "sv_flavor=sweet; Path=/",
        });
        response.write({ output: "<p>hello</p>" });
    },
}));
```

The host names the mode in an `X-SSV-Mode` header, and the runner reads the body as JSON only when it says `wrapped`. A probe cannot set that header: `setHeader` or `addHeader` with its name, in any case, throws `SSV_RESERVED_HEADER`. An answer without it is reported as an error, never read.

For an `own` response, the runner reports every header but the marker, with these limits (the CLI applies them again):

- **Cookies are redacted.** Each `Set-Cookie` cookie becomes `<name>=<redacted>`, unless its name starts with `sv_`. Name a cookie a probe sets `sv_<something>` to see it whole; the platform's session cookies are never shown.
- **The body is cut at 64 KB** (65,536 characters), and the response then carries `"truncated": true`.
- **The scrubber still applies.** The whole output goes through the same scrubber and identifier refusal as any probe, so a redirect whose `Location` names the account's host is refused, not printed.

The expected output of an `own` probe is the `response` object (`{ status, headers, body }`). The comparison ignores the case of header names and leaves out headers that change on every call: `Date`.

The runner stays the only entry point, because the machine-to-machine token reaches RESTlets and no Oracle page says it reaches Suitelets. For a Suitelet probe, the runner checks the parameters, then calls the host from inside the account with `N/https.requestSuitelet`:

- The options are `scriptId` and `deploymentId` (the host's `_sl` ids) and `urlParams`, which carries the probe name (`probe`) and the parameters as one JSON string (`params`). `requestSuitelet` rejects a `params` option (`UNKNOWN_PARAM`) and `external: true`, gives only a generic `UNEXPECTED_ERROR` for a script that does not exist, and costs 10 governance units.
- The host's deployment is never available without login (`isonline` F), its audience is only the runner's role (`allroles` F), and its status is released. Oracle says `requestSuitelet` works only for authenticated users in trusted contexts, so no anonymous URL is needed.
- Like the runner, the host refuses outside a sandbox, runs only the Suitelet probes generated into its own fixed list, checks the parameters again against the declarations, and reports a throw as `THROWS: <name>: <message>`.
- A failed or unexpected answer from the host is reported, never thrown: `run` stops with `The runner reported an error:` and what the runner saw (the error the call threw, the HTTP status and the start of the body, an answer without the `X-SSV-Mode` header, a `wrapped` body that is not JSON, or the host's own refusal). See [Troubleshooting](#a-suitelet-probe-reports-that-the-suitelet-host-call-failed).

### Tags

The package validates the tags in a probe's leading JSDoc block: `@scriptType`, `@writes`, `@param`, the NetSuite `@NApiVersion`, `@NScriptType` and `@NModuleScope`, and the ordinary `@see`, `@link`, `@example`, `@returns`, `@since` and `@deprecated`. Any other tag is reported and stops `run` and `deploy`, so a typo cannot pass silently. A project that keeps its own tags registers them with `SUITESCRIPT_VERIFY_EXTRA_TAGS`, a comma-separated list of tag names without the `@` (for example `flavor,other`). The package checks only that a registered tag is known; what a tag means is up to the project.

### Writing probes that do not cost a deploy

- **Keep module-scope code rare and tiny.** The runner loads every probe as a dependency of its own `define()`. A probe whose top-level code fails in a way its own `try/catch` cannot capture takes the whole runner down. If you need one, make it one governed call, run it last and one per deploy, so a failure points at one call. Do not keep a probe that is expected to take the runner down; its results page carries the code.
- **The role is minimal.** The runner's role holds only the token-login and REST web services permissions, and a deploy replaces any permission added by hand. A probe that searches transactions or creates a record gets `INSUFFICIENT_PERMISSION`. That error comes after type validation, which is often still evidence, but a probe that needs a record permission should say so in its header. Prefer objects that need no permission (`runtime`, `search.createColumn`).
- **Check how an API is chained before relying on it.** `crypto.createHash(...).update(...)` returns nothing, so chaining `.digest()` threw `Cannot read property 'digest' of undefined` and cost a deploy. Read the method page for the return type.
- **Outbound calls rate-limit.** A public echo service answered four requests in a row and failed the fifth with a body that had no `headers`. Keep a probe to four requests or fewer and put the status code in the failure, not just a `TypeError`.
- **Read the execution log with SuiteQL.** A probe can read `scriptnote`, the script execution log, with `query.runSuiteQL` (columns `date`, `type`, `title`, `detail`, `scripttype`; `type` is the log level, such as `ERROR`). `search.create({ type: "scriptnote" })` throws `INVALID_RCRD_TYPE`, and Oracle documents no such table. Return counts and levels rather than a log's title or detail: log text can carry identifiers, which makes `run` refuse the output.
- **Write probes with your editor or file tools, not a shell heredoc.** Backticks, `${}` and quotes in a probe broke a shell heredoc on Windows.
- **An agent's tool can refuse the deploy command.** An auto-mode classifier blocked a deploy dry run chained in one shell line with other commands. Run the dry run alone and say so if it is still refused; the real deploy is the person's anyway.

## Settings

Every setting is a `SUITESCRIPT_VERIFY_` key. They layer from the committed `verification/.env`, the gitignored `verification/.env.local` and the process environment, in that order. The committed file may hold only the keys marked "committed", and its values must not look like a secret. A bad value stops every command that reaches the sandbox, and the error names the key, never the value.

| Key                                       | Where     | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUITESCRIPT_VERIFY_PROBES_DIR`           | committed | Folder of probes (a path in the project)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SUITESCRIPT_VERIFY_RESULTS_DIR`          | committed | Folder of results pages (a path in the project). No default: you choose                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SUITESCRIPT_VERIFY_SDF_DIR`              | committed | Folder for the generated SDF project (a path in the project)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `SUITESCRIPT_VERIFY_ROLE_ID`              | committed | The runner's role id, matching `^customrole_[a-z0-9_]{1,29}$` (40 characters at most in all); default `customrole_<runner id>`, so each project has its own role. An explicit value wins. Names the role object every deploy writes and the runner's audience, and is reported by `doctor`                                                                                                                                                                                                          |
| `SUITESCRIPT_VERIFY_RUNNER_ID`            | committed | The runner's name: 1 to 24 lowercase letters, digits and underscores, starting with a letter; default `suitescript_verify`. Names the scripts (`customscript_<id>_rl`, and `customscript_<id>_sl` for the Suitelet host), the deployments (`customdeploy_<id>_rl`, `customdeploy_<id>_sl`), the display names (`ssv runner <id>`, `ssv suitelet <id>`) and the File Cabinet folder, so projects sharing a sandbox can each have their own runner; 24 keeps each within the platform's 40 characters |
| `SUITESCRIPT_VERIFY_EXTRA_TAGS`           | committed | Extra probe tag names, comma-separated, without the `@`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SUITESCRIPT_VERIFY_ACCOUNT`              | local     | The sandbox account (`digits_SBn`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SUITESCRIPT_VERIFY_CLIENT_ID`            | local     | The integration's client id                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SUITESCRIPT_VERIFY_CERTIFICATE_ID`       | local     | Certificate id of the runner pair                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH`     | local     | Path to the runner pair's private key (outside the project)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID`   | local     | Certificate id of the SDF pair                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH` | local     | Path to the SDF pair's private key (outside the project)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SUITESCRIPT_VERIFY_PASSKEY`              | local     | The SuiteCloud passkey, saved by `passkey`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `SUITESCRIPT_VERIFY_DOMAIN`               | local     | Optional NetSuite domain passed to the SuiteCloud CLI                                                                                                                                                                                                                                                                                                                                                                                                                                               |

"Local" keys go in `.env.local` or the process environment (a pipeline's secrets), never in the committed file.

## Troubleshooting

### Every probe returns HTTP 400 and names no probe

The message looks like `com.netsuite.suitescript.scriptobject.ScriptNullObjectAdapter@...`. One probe's top-level code failed in a way its own `try/catch` cannot capture, so the runner never loaded.

1. Move the suspect probe out of the probes folder.
2. Dry-run, then ask the person for a redeploy.

### A Suitelet probe reports that the Suitelet host call failed

`run` says `The runner reported an error: the Suitelet host call failed`, `answered HTTP`, `without its X-SSV-Mode header` or `answer was not JSON`. The runner reached `requestSuitelet`, but the host did not answer with a result. A generic `UNEXPECTED_ERROR` is what `requestSuitelet` gives for a script that does not exist: deploy again (every deploy includes the host), and check that a `cleanup` has not switched it off. Another status, an answer without the `X-SSV-Mode` header, or a body that is not JSON, means the host did not run the probe (an HTTP 200 without the header is usually a login or error page), and the start of the body says why. A RESTlet probe that still runs shows the runner itself loads.

### A probe returns `INSUFFICIENT_PERMISSION`

The runner's role holds only the token-login and REST web services permissions, and a deploy replaces any permission added by hand, so a probe that searches transactions or creates a record gets this error. It comes after type validation, which is often still evidence. See [Probes](#writing-probes-that-do-not-cost-a-deploy) for how to write around it.

### Every call fails with `401 INVALID_LOGIN_ATTEMPT`

With the machine-to-machine grant alone, the token endpoint issues a token but every call fails. On the integration record, also enable the token-based authentication flags and the RESTlets and REST Web Services scopes.

### `setup-ci` fails with "an error with the private key"

The full message is "There was an error with the private key used to authenticate". The SDF pair is not RSA. Oracle's SDK signs the SDF login with PS256 and only parses an RSA key. Use an RSA-4096 key with an RSA-PSS certificate for the SDF pair, and an EC P-256 pair for the runner. They cannot share a pair (see [Setup](#setup)).

### An authentication or "not found" error after a sandbox refresh

A refresh clears the token mappings and, presumably, the deployed runner. Redo the role, mapping and deploy steps.

### The SuiteCloud CLI postinstall exits 3

On a headless machine, with `SUITECLOUD_CLI_ACCEPT_LICENSE` unset, the postinstall opens the license with `start`, `open` or `xdg-open`, which fails without a desktop. A desktop install is fine. A headless job needs the maintainer to accept the license, or an install with `--ignore-scripts`.

### `doctor`, `deploy` and `run` fail in a git worktree but pass in the main checkout

`verification/.env.local` is gitignored, so a fresh git worktree does not have it, and every command that needs a credential fails there. Run those commands from the main checkout (merge the probes into the branch checked out there first), or copy `.env.local` into the worktree yourself. A probe added after the last deploy still needs a new deploy before `run` finds it.

### SuiteCloud browser login stopped working in another project

A user-wide `SUITECLOUD_CI_PASSKEY` stops browser login in your other SuiteCloud projects. Remove it from the environment and keep the passkey in `verification/.env.local`.

## Adding a lesson

A **lesson** is a short, generic account of a runner, deploy, probe or sandbox problem: what happened, what it cost and how to avoid it. Keep it concrete (the message, the cause, the fix), and never put an account number, id, token or real record id in it. Fix an entry that proves wrong instead of adding a second one that contradicts it.

- **A generic problem with this package or its flow:** open an issue or pull request at [nemchik/suitescript-verify](https://github.com/nemchik/suitescript-verify). It is added in the same pull request to the matching section above (setup, deploy, probes or troubleshooting), so it ships with the next version.
- **A finding about NetSuite itself:** write a [results page](#documenting-a-verification) in your own project. It is not a lesson.

## Development

You need the Node.js and npm versions in `package.json` `devEngines`. `npm pack` and `npm test` refuse any other Node version.

```sh
npm install
npm run skills:install   # optional: restores the agent skills for Claude Code
npm test                 # builds, then runs the CLI tests against a fake SuiteCloud CLI
npm run format           # type-checks, then applies Biome's fixes
```

Git hooks (lefthook) run Biome on staged files before each commit.

## License

MIT
