# suitescript-verify

[![npm version](https://img.shields.io/npm/v/suitescript-verify)](https://www.npmjs.com/package/suitescript-verify)
[![CI](https://img.shields.io/github/actions/workflow/status/nemchik/suitescript-verify/ci.yml?branch=main&label=CI)](https://github.com/nemchik/suitescript-verify/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/suitescript-verify)](LICENSE)

Run probes in a NetSuite **sandbox** to verify what SuiteScript modules do, from a CLI that is safe to hand to an agent: sandbox only, a person approves every write at a terminal, and output is scrubbed of identifiers.

**Note:** this package never accepts Oracle's SuiteCloud license. Install `@oracle/suitecloud-cli` in your project and accept the license yourself.

```sh
npm install --save-dev suitescript-verify @oracle/suitecloud-cli
npx suitescript-verify help
```

Quick start, at your own terminal: `init` scaffolds the folders and offers to continue into the guided `setup`, which ends with the first deploy and `doctor`. Then write a probe and run it.

```sh
npx suitescript-verify init
npx suitescript-verify run <probe>
```

This README is the whole guide and ships with each published version. Read the copy installed with the package, which matches the version you use: `suitescript-verify init` prints its path (it is in `node_modules/suitescript-verify/` under npm and pnpm).

## Contents

- [Verification method](#verification-method): when to verify, how, and how to record it
- [Setup](#setup): `init`, then the guided `setup`, or each step by hand
- [Deploy](#deploy): put the runner in the sandbox
- [Probes](#probes): write and run them
- [Settings](#settings): every `SUITESCRIPT_VERIFY_` key
- [Upgrading from 1.x](#upgrading-from-1x): turn the old runner off first, then the role
- [Troubleshooting](#troubleshooting): by symptom
- [Adding a lesson](#adding-a-lesson)
- [Development](#development)

## Verification method

Oracle's skills, type definitions and documentation disagree with each other and sometimes with the platform. A verification is a test run in a NetSuite account that shows what the platform actually does. Where a source's claim about platform behavior and the verified behavior differ, the verified behavior wins.

### When to verify

Verify, or mark the claim **unverified**, whenever you depend on what the platform accepts, rejects or returns, research how a module, method or script type behaves, or find a source that contradicts itself or another. An unverified claim stays marked unverified until a results page settles it. Do not guess a result, and do not mark a claim verified from a paraphrase of documentation: verified means a test ran.

### For agents

- If you can run the test yourself, do: a **probe** runs in a sandbox through the runner, RESTlet and Suitelet probes alike. Run `suitescript-verify doctor` first, and again after every deploy: its last step asks the deployed runner for its self-check. It only reads, so it is always safe to run.
- Setup is mostly the person's (browser login, role, certificate). Ask the person to run `suitescript-verify setup` in their own terminal: it refuses to run without one, so you never handle a credential or a typed confirmation. When a `doctor` check fails, relay its next step and wait.
- Never add a permission to the runner's role by hand: declare it with `@permission` (see [Permissions](#permissions)). No deploy removes a hand-added one.
- Never run anything in production, never create credentials, and never run a real deploy or cleanup yourself: both need a person at a terminal.
- Never tell the person to remap or reuse a certificate mapping: a machine-to-machine mapping cannot be changed, and a certificate cannot be used again. Any role change needs new key pairs and new mappings (see [Changing a certificate's role](#changing-a-certificates-role)).
- Prompt the person to run a snippet by hand (the methods below) only when a probe cannot run: setup cannot pass, or the claim needs a person (see [Which method a claim needs](#which-method-a-claim-needs)). Give the exact snippet and say where to run it.
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

For a deployed script, a minimal Suitelet opened from its deployment URL is enough: wrap each check in its own `try/catch` and write the results as JSON (`THROWS: <name>: <message>` for a throw), so one throw does not hide the rest.

**Note:** do not put the account number in a verification, nor an account URL, user, token or the internal id of a real record. They identify a company's account, they are not needed to reproduce a result, and they are a security risk in a public repository. Replace ids with placeholders.

### Which method a claim needs

Oracle's [SuiteScript 2.x Modules](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_4220488571.html) table says where each module runs (unverified, and possibly wrong in places: it lists `N/error` as server only). By it, probes reach every server-side module function that only reads, and a person reaches the rest. No module runs only in a server script type other than RESTlet or Suitelet, so Map/Reduce, Scheduled, User Event and the others add behavior of their own (entry points, context objects, governance, `runtime.executionContext`), not modules. Client code runs only in a browser, which the runner cannot drive: a headless browser needs a UI login, and the package never creates or stores one.

| A claim about                                                                                                   | Method                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `N/scriptTypes/restlet`, or a server-side module function in no other row                                       | A RESTlet probe (or a Suitelet probe)                                                                          |
| `N/ui/serverWidget` pages, or the response, headers and cookies a Suitelet sets                                 | A [Suitelet probe](#suitelet-probes)                                                                           |
| A write (`record.save`, `task.submit`, `email.send`) or a redirect (`N/redirect`, `sendRedirect`)               | A deployed script, run by a person: probes only read, and a Suitelet probe [cannot redirect](#suitelet-probes) |
| `N/currentRecord`, `N/ui/dialog`, `N/ui/message`, `N/portlet`, or the client side of a module that runs on both | The browser console, or a deployed Client script for its entry points, run by a person                         |
| The behavior of Map/Reduce, Scheduled, User Event or any other type besides RESTlet and Suitelet                | A deployed script of that type, run by a person (the runner has no host for these types yet)                   |

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

```sh
suitescript-verify init    # scaffold the folders; at a terminal it offers to continue into setup
suitescript-verify setup   # the guided setup, at your own terminal
```

Install the SuiteCloud CLI and gitignore `verification/.env.local` first (steps 2 and 3 below). Then `setup` walks through the rest in order. It skips each step `doctor` already passes, so after a failure you fix the cause and run it again, and it picks up where it stopped. It refuses to run without a terminal, so an agent never handles a credential or a typed confirmation, and it needs the folders `init` creates.

1. **SuiteCloud CLI and Java.** If `doctor`'s CLI or Java check fails, `setup` prints the fix and stops. Installing the CLI and accepting Oracle's license stay yours.
2. **Certificate pairs.** It generates the missing pairs as `certificate` does and saves their key paths (`setup --keys-dir <path>` moves them).
3. **The sandbox checklist.** It prints the one-trip checklist (the integration record's flags and scopes, the role's name and id to assign to yourself, which public certificate file goes to which mapping, with its path, and the one-time browser login) and waits for Enter. Step 5 under [Doing it by hand](#doing-it-by-hand) explains each item. It is not skipped when step 2 generated a pair, since a new pair needs a new mapping.
4. **Account, client id and certificate ids.** It asks for each without echoing it (the terminal is in raw mode, so nothing typed appears on screen or in a terminal log) and writes it to `verification/.env.local` only, never printing it. Press Enter to keep a value that is already set, or type a new one to replace it. When step 2 generated a pair, this step is not skipped and asks for that pair's new certificate id, with no value to keep. An account that is not a sandbox (`digits_SBn`) is asked again.
5. **Passkey**, as `passkey` does.
6. **`setup-ci`**, which registers the SDF login.
7. **The first deploy.** Type `DEPLOY` to deploy now, which also takes over the runner's role; press Enter to skip it and deploy later with `deploy --approved`. It is skipped when the runner already passes its self-check.
8. **`doctor`**, with the self-check. Its exit code is `setup`'s.

`certificate`, `passkey`, `env set`, `setup-ci` and `deploy` keep working on their own, for a pipeline or a one-off fix.

### Doing it by hand

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
   - **The integration record** needs more than the machine-to-machine grant: also check **Token-based Authentication** and **TBA: issuetoken Endpoint** (both were checked in the working setup; whether the second is needed is not settled) and the RESTlets and REST Web Services scopes (see [Troubleshooting](#every-call-fails-with-401-invalid_login_attempt)). Copy its client id when you save it: it is shown only once.
   - **The runner's role:** create it with its name, its id and only the permission _Log in using OAuth 2.0 Access Tokens_ (Full), and assign it to yourself on your employee record (Access > Roles). A role without that permission is not in the mapping's role list. The id is `customrole_<runner id>` (`customrole_suitescript_verify` by default; `doctor` prints the one in use): type the part after `customrole` (`_suitescript_verify`) in the ID field, and NetSuite adds the prefix. The name is `ssv runner role <runner id>`. Every deploy writes the role as an SDF object, so the first deploy takes it over and gives it `ADMI_LOGIN_OAUTH2` (Log In Using OAuth 2.0 Access Tokens) and `ADMI_RESTWEBSERVICES` (REST Web Services), both at Full, plus each permission a probe declares with `@permission` (see [Permissions](#permissions)), on the Account center, with every other flag at its default. **Note:** a deploy adds and updates the permissions it declares and never removes others. A permission added by hand survives every deploy, and so does _Other Addresses_ (Full), which NetSuite adds itself to a role made in the UI, and, in a sandbox at 2026.2, to a role a deploy creates. So the role is least-privilege only while nobody adds to it. To remove a permission, edit the role (Setup > Users/Roles > Manage Roles), delete its line and save. `doctor` sees only missing permissions; an agent lists the role's permissions with SuiteQL: `SELECT rp.permkey, rp.permlevel FROM role r JOIN rolepermissions rp ON rp.role = r.id WHERE r.scriptid = '<role id>'`.
   - **The SDF certificate** maps to a role that can deploy, never the runner's role, since a deploy that rewrote its own login role would strip the permissions the next deploy needs. In a sandbox map it to Administrator; otherwise use a deploy role with SuiteScript, Documents and Files, Allow JS/HTML Uploads and Bulk Manage Roles. Deploying the runner's role needs Bulk Manage Roles, which Administrator has.
   - **The runner certificate** maps to the runner's role. A mapping cannot be changed later: to move a certificate to another role, see [Changing a certificate's role](#changing-a-certificates-role).
   - **Each project needs its own role.** A deploy rewrites the role, so two projects deploying one role would overwrite each other. The default id follows the runner id, so projects with their own runner id (see [Deploy](#deploy)) already have their own role. `SUITESCRIPT_VERIFY_ROLE_ID` sets another id and wins over the default; do not rely on changing an id later, since a custom role's id may be read-only after saving. The platform rejects a role id over 40 characters, `customrole_` included, so the id after the prefix is at most 29 characters; the package refuses a longer one before it reaches the sandbox.
   - **In a OneWorld account** the role gets every subsidiary: the generated role names none, so it deploys in any account.
6. **Save the settings.** `suitescript-verify passkey` generates the SuiteCloud passkey into `verification/.env.local`. `suitescript-verify env set NAME=value` saves any other key there (values are never printed; a different existing value is kept unless `--overwrite`). See [Settings](#settings) for the names.
7. **Run `suitescript-verify doctor`** until every step passes. It checks the SuiteCloud CLI, Java 17 or 21, the SuiteCloud SDK jar and login, account, sandbox, certificates, passkey and project files, says which failing steps are the maintainer's own, and exits 1 while any fails. Its last step calls the deployed runner's self-check (see [Deploy](#deploy)), so before the first deploy it fails with "Deploy first"; every other step should pass by then.
8. **`suitescript-verify setup-ci`** (for a pipeline) registers the SDF credentials (auth id `suitescript-verify`) with your project's SuiteCloud CLI, passing the passkey through the environment, never an argument. On success it prints the `SUITESCRIPT_VERIFY_` names the pipeline must supply as its own secrets, never a value. It writes no file, no credential variable and no license variable. Accepting Oracle's license in the pipeline is yours.

**Note:** projects on one machine that register the same SDF auth id (this package always uses `suitescript-verify`) share one stored credential entry. That is harmless while their values match. `setup-ci` for another role does not replace the entry: it is refused (see [Troubleshooting](#setup-ci-fails-with-this-authentication-id-is-already-in-use)).

**Note:** never put `SUITECLOUD_CI_PASSKEY` in your user-wide environment. It stops browser login in your other SuiteCloud projects. Keep the passkey in `.env.local`, where the package hands it to the CLI for its own child process only.

Every command that reaches the sandbox refuses an account that is not a sandbox (`digits_SBn`).

### Changing a certificate's role

A machine-to-machine mapping cannot be changed after it is created, only revoked, and a certificate that is active or revoked cannot be used for another entity, role or application. So any role change needs a new key pair and a new mapping: moving the runner to its own role, moving the SDF login to Administrator or a deploy role, or a 1.x project whose two certificates shared one role (both pairs).

1. **Generate the new pairs into a new folder**: `certificate --keys-dir <new folder>` (with `--only runner|sdf` for one). Keep the old keys until their mappings are revoked.
2. **Map each new public certificate** to its role, as in step 5 of [Doing it by hand](#doing-it-by-hand).
3. **Save the new certificate ids**: `env set SUITESCRIPT_VERIFY_CERTIFICATE_ID=<id> --overwrite` (and `SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID`). `setup` asks for them only when it generated the pair itself.
4. **For a new SDF role, register it again**: remove the old auth id first (see [Troubleshooting](#setup-ci-fails-with-this-authentication-id-is-already-in-use)), then run `setup-ci`.
5. **Revoke the old mappings** once `doctor` passes.

### Keeping the tooling in a subfolder

A project that publishes its own package from the repository root may keep the tooling in a subfolder that is an npm project of its own, with its own `package.json` and `node_modules` holding `suitescript-verify` and `@oracle/suitecloud-cli`. The package treats the folder it runs in as the project, so run it from the subfolder and pass `--dir .`, which makes the subfolder itself the verification folder (its `.env`, `.env.local`, `probes` and `sdf`):

Give it scripts such as `"verify:doctor": "suitescript-verify doctor --dir ."` and `"verify:run": "suitescript-verify run --dir ."`. A script at the repository root then calls one with `npm --prefix <subfolder> run verify:doctor --`. Give `init`, `deploy`, `cleanup` and the other commands the same `--dir .`. The subfolder's `.env.local` is checked against the repository's `.gitignore`. Without `--dir .`, `doctor` reads a nested `verification` folder that does not exist; when the folder already holds a `probes` folder or a `.env` with `SUITESCRIPT_VERIFY_` keys, it reports that alone and says to rerun with `--dir .` instead of running `init`, which would create that nested folder.

## Deploy

```sh
suitescript-verify deploy              # generate, then dry-run
suitescript-verify deploy --approved   # the real deploy: a person at a terminal types DEPLOY
suitescript-verify cleanup --approved  # turns the runner's and Suitelet host's deployments off: the person types CLEANUP
```

`deploy` generates the runner and an SDF project into `verification/sdf` (the generated `src/` there is yours to gitignore) from the RESTlet and Suitelet probes in `verification/probes`, then dry-runs it through your project's SuiteCloud CLI. `cleanup` does the same with the deployments switched off, and without `--approved` it is a dry run. Both write the runner's role (see [Setup](#setup)); `cleanup` leaves it unchanged, since switching it off would break its token mapping. Every script is named by its type, with Oracle's suggested abbreviation as the suffix: the runner (a RESTlet) has the script id `customscript_suitescript_verify_rl`, the deployment id `customdeploy_suitescript_verify_rl`, the file `restlet.js` and the name `ssv runner suitescript_verify`, all from the runner id (`SUITESCRIPT_VERIFY_RUNNER_ID`, default `suitescript_verify`). The [Suitelet host](#suitelet-probes) beside it has the script id `customscript_suitescript_verify_sl`, the deployment id `customdeploy_suitescript_verify_sl`, the file `suitelet.js` in the same folder and the name `ssv suitelet suitescript_verify`. Every deploy generates both, even with no Suitelet probes, and `cleanup` switches both deployments off.

- **Projects that share a sandbox need their own runner id.** A deploy replaces the runner's probe list, so two projects with the same runner id overwrite each other: whichever deployed last decides which probes exist, and the other's answer `unknown probe` until it deploys again. Set a different `SUITESCRIPT_VERIFY_RUNNER_ID` in each project's committed `.env` (for example `my_project`). The runner, its deployment, its name and its File Cabinet folder are named from it (`customscript_my_project_rl`, `ssv runner my_project`, `my-project`), and so is the runner's role (`customrole_my_project`), which needs its own token mapping. The id is at most 24 characters because the platform rejects a script or deployment id over 40 characters, prefix included (`The script ID must not exceed 40 characters.`): `customscript_` and `customdeploy_` take 13 and the type suffix (`_rl`, `_sl`) takes 3. The platform also caps a script's name at 40 characters (`The name field contains more than the maximum number (40) of characters allowed.`), and `ssv suitelet ` takes 13, so a 24-character id fits there too. Changing a project's id leaves its old runner deployed in the sandbox, because the SuiteCloud CLI cannot delete a script. The next `deploy` or `cleanup` removes the old runner and its Suitelet host from the generated SDF folder (so it is not deployed again) and warns with the old id; to turn the old runner off, run `cleanup --approved` once with `SUITESCRIPT_VERIFY_RUNNER_ID` set to the old id, then switch back. A runner generated by 1.x (`customscript_<id>_runner`) is removed and warned about the same way, whatever its id, because 2.0 names it differently and cannot turn it off; turn it off with 1.x before upgrading (see [Upgrading from 1.x](#upgrading-from-1x)). The warning only sees runners generated in this folder.
- **Every probe change needs a deploy.** The runner's probe list is generated into its dependency list, so a new, renamed or edited probe only exists in the sandbox after a deploy. Write and review **all** the probes of a batch first, dry-run once, and ask for one deploy. A deploy is the person's, in their own terminal, so a wasted one costs a person's time.
- **After every deploy, run `suitescript-verify doctor`.** Its last step gets a token the way `run` does and sends the runner a reserved self-check request (a `selfCheck` field, never a probe name, so it cannot clash with a probe). The runner answers without running a probe: whether the account is a sandbox, the role it runs as, the level it holds of each permission the deploy wrote to the role (read with `runtime.getCurrentUser().getPermission`), the package version, build fingerprint and probe list baked in at deploy (the fingerprint is a hash of the generated scripts and the probes, so it tells two builds of one version apart), and the Suitelet host's answer to its own self-check through `requestSuitelet`. `doctor` compares that with the project and passes, or says "Deploy first", "Redeploy" or "Drift" (see [Troubleshooting](#troubleshooting)). It prints no identifier and refuses to print an answer that looks like one. A project no longer needs a probe of its own that only proves the runner loads: if the self-check fails, no probe result means anything.
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
- A probe with an `<probe>.expect.json` is compared with it, and a difference exits 2 as drift, naming the keys that differ (such as `response.headers.x-sv-multi` or `result`). The expectation is the `result` object (or, for a Suitelet probe that writes its own response, the `response` object), not the whole output. No command writes it: copy it from a real run's output, which `run` prints with keys sorted and indented, never a guess, so a new probe has none until it has run once. Capture the output with `npx suitescript-verify run …` or `npm run --silent …`, or npm's own warnings land before the JSON. A probe whose output changes on every run (a row count, a timestamp) cannot have one: it would report drift every time, so say on the results page why there is none. After upgrading suitescript-verify, rewrite each own probe's expectation from a fresh `run`: what `run` reports can change between versions with no platform change.
- `run` stops waiting for a probe at its limit, because a probe cannot time itself out: its `@timeout` (see [Tags](#tags)), else 60 seconds for a RESTlet probe and 45 for a Suitelet probe. A timeout exits 1 (drift keeps exit 2), prints no result and writes no `--draft` page. At the most its script type allows (300 for a RESTlet probe, Oracle's documented RESTlet limit, which is **unverified**; 45 for a Suitelet probe) the CLI waits 15 seconds longer, so a Suitelet probe's `requestSuitelet` failure is reported as the runner's error, not a CLI timeout; a RESTlet probe got no answer within it. In a sandbox at 2026.2: `requestSuitelet` gave up on a Suitelet probe at about 45 seconds with `SSS_REQUEST_TIME_EXCEEDED`; a RESTlet probe spinning in a loop threw `Script Execution Statement Count Exceeded.` (reported as `THROWS`) after about 90 seconds; a RESTlet probe waiting on `N/https` calls got no answer by 315 seconds in two runs, and in one of them was still running at 331 seconds, at least 16 seconds after the CLI gave up; and `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout` and `queueMicrotask` were `undefined` in a RESTlet and in a Suitelet. **Note:** whether NetSuite stops a RESTlet at some limit, and with what answer, is **unverified**.
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

### Permissions

A probe that needs a record permission declares it in its leading JSDoc block, one tag per permission: `@permission <permkey> VIEW`.

```js
/**
 * @scriptType Restlet
 * @permission LIST_CUSTJOB VIEW
 */
```

- The key is an SDF permission key (`permkey`), such as `LIST_CUSTJOB` (Customers) or `TRAN_SALESORD` (Sales Order), exactly as Oracle's list of permission names and IDs gives it. The package keeps that list and refuses a key not on it, including a custom record's script id.
- The level must be `VIEW`: probes do not write, so `CREATE`, `EDIT` and `FULL` are refused.
- A malformed tag, an unknown key or level, a level above `VIEW` or a key declared twice in one probe stops `run` and `deploy`, naming the probe and the tag.
- Every deploy adds each declared permission to the runner's role once, however many probes declare it, after the token-login and REST web services permissions. A permission takes effect only after a deploy, so a new declaration needs one before `run` can use it.

### Probes that return a Promise

A probe whose `run()` returns a Promise (any value with a `then` method) is awaited, for a RESTlet or a Suitelet probe, and reports what it settles to. A synchronous probe and the self-check are unchanged.

```js
define(["N/search"], (search) => ({
    run: () =>
        search.lookupFields.promise({
            type: "customer",
            id: "1",
            columns: ["entityid"],
        }),
}));
```

- **A resolved value** is the `result`.
- **A rejection** is reported as `REJECTS: <name>: <message>` (or `REJECTS: <value>` when the rejection is not an error). A synchronous throw, including one before the Promise is returned, is still `THROWS: <name>: <message>`. Which errors surface synchronously and which as rejections is itself something a probe can verify.
- **A lost await is an error.** A result holding a nested Promise (checked for every result, synchronous or awaited) makes `run` fail with `the result holds a Promise that was not awaited at <path>`, because a nested Promise always serializes as `{}`. Await it, or return `typeof value?.then === "function"` to show that a value is a Promise. A fire-and-forget call (`search.lookupFields.promise(...); return "done"`) cannot be detected, so do not write one.
- Handle rejections you expect, and avoid `return await` (return the Promise itself): this is Oracle's advice.
- **What NetSuite did.** In a sandbox at 2026.2, NetSuite awaited a RESTlet `post` and a Suitelet `onRequest` that returned a Promise: resolved values, rejections and a response written after an `await` all arrived. An uncaught rejection from a Suitelet's own `onRequest` gave HTTP 500 and only `UNEXPECTED_ERROR` in the execution log, without the error's name, which is why the Suitelet host catches rejections itself. A Promise that never settles is not held until a time limit: see [Troubleshooting](#a-probe-that-returns-a-promise-fails-with-http-400-unexpected_error).

### Suitelet probes

A probe that declares `@scriptType Suitelet` runs in the **Suitelet host**, a Suitelet deployed beside the runner. It exports `run(params, context)`, with the same declared parameters as a RESTlet probe:

- `context.request` holds only `method` and `parameters` (the declared parameters). The request's headers, cookies and body are never shown, so a probe cannot return them.
- `context.response` records every write, page, file and header call (`write`, `writeLine`, `writePage`, `writeFile`, `renderPdf`, `setCdnCacheable`, `setHeader`, `addHeader`). Nothing reaches the real response until the probe returns. `getHeader` and `headers` answer from what it recorded. A header set after a write still arrives.
- `sendRedirect` is refused: `requestSuitelet` follows a redirect, so the runner would see the page it leads to (often the login page), never the redirect. A redirect cannot be probed this way.
- The host runs in the `SUITELET` execution context with the runner role's permissions, so `@permission` applies to Suitelet probes too.

When the probe returns, the host answers in one of two modes. `run` does not print the mode: a `result` means `wrapped`, a `response` means `own`.

| The probe                                   | Mode      | What `run` reports                                                                                            |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| Returns a value and makes no response calls | `wrapped` | `result`, like a RESTlet probe, compared with its expected output the same way                                |
| Makes response calls and returns nothing    | `own`     | `response`: `{ status, headers, body }` of the HTTP response the runner saw, with the calls replayed in order |
| Does both                                   | error     | `the probe both wrote a response and returned a value`                                                        |
| Throws, before or after writing             | `wrapped` | `result` is `THROWS: <name>: <message>`; nothing it wrote is replayed                                         |
| Makes a call the real response refuses      | `wrapped` | `THROWS: <name>: <message>` for the refused call, or an error when replayed output came first (see below)     |

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

A Suitelet probe that returns a Promise (see [Probes that return a Promise](#probes-that-return-a-promise)) is judged by the table once it settles: a resolved value is `wrapped`, response calls with `undefined` are `own`, and both is refused. A rejection is `wrapped` and the calls recorded before it are discarded, like a `THROWS`. The recorder is sealed when the Promise settles, so a response call a stray continuation makes later is ignored.

The host names the mode in an `X-SSV-Mode` header, and the runner reads the body as JSON only when it says `wrapped`. An answer without it is reported as an error, never read. The errors particular to Suitelet probes:

| Error                                                  | Raised by                            | Cause and fix                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SSV_RESERVED_HEADER`                                  | The probe's `setHeader`, `addHeader` | The probe set an `X-SSV-` header, such as `X-SSV-Mode` or `X-SSV-Headers` (in any case). Only the host sets them; reported as `THROWS`.                                                    |
| `SSV_REDIRECT_REFUSED`                                 | The probe's `sendRedirect`           | `requestSuitelet` follows redirects, so a redirect cannot be probed; reported as `THROWS`.                                                                                                 |
| `the probe both wrote a response and returned a value` | The host                             | A Suitelet probe writes its own response or returns a value, never both. Drop the return value or the response calls.                                                                      |
| `THROWS` from a replayed call                          | The real response, during replay     | A recorded call the real response refused. Replayed output cannot be taken back, so when some came first, `run` reports a `wrapped` body that is not JSON instead: an error, not a result. |
| `UNKNOWN_PARAM`                                        | `requestSuitelet`                    | Its answer to a `params` option. The runner never passes one: it sends the parameters in `urlParams`.                                                                                      |
| `UNEXPECTED_ERROR`                                     | `requestSuitelet`                    | The generic error it gives for a script that does not exist. See [Troubleshooting](#a-suitelet-probe-reports-that-the-suitelet-host-call-failed).                                          |

For an `own` response, the runner reports only headers that are safe to commit, since `run` output and expected outputs may be committed (the CLI applies the same value rules again):

- **Platform headers: only the content ones.** Of the headers NetSuite adds, only `Content-Type`, `Content-Disposition`, `Content-Language`, `Content-Encoding` and `Cache-Control` are kept. Every other one is dropped and never reported: per-call ids and routing (`Date`, `Akamai-GRN`, `X-N-OperationId`, `X-Cache`, `Via`, any other `X-NS…` header), the platform's `Set-Cookie` and its security headers (`X-Content-Type-Options`, `Strict-Transport-Security`, `Vary`, `Expires`). They are dropped on purpose, so their absence in the output says nothing about what NetSuite sends.
- **The probe's own headers: every one it set.** Through `requestSuitelet` the runner sees only the first value of each header name: in a sandbox run at NetSuite 2026.2, a second `addHeader` value and a probe's `Set-Cookie` never arrived, and only the platform's session cookie did. Whether NetSuite sends the later values to a browser is unverified. The host now also lists the probe's header calls in an `X-SSV-Headers` header (`setHeader` replacing a name's values, `addHeader` appending), and the runner reports each name from that list, replacing the platform's value (confirmed in a sandbox at NetSuite 2026.2). So a probe that needs to see the platform's value of a header must not set that header: a probe that sets `Content-Type: text/html` is reported with `text/html`, though NetSuite sent `text/html;charset=utf-8` at 2026.2. A missing or malformed list leaves only the platform's content headers. The host's `X-SSV-` headers are never reported.
- **Credential-like values are redacted.** A probe header named `Authorization`, `Proxy-Authorization` or `Cookie`, or whose name contains `token`, `secret`, `session`, `password`, `auth`, `key`, `csrf`, `sign`, `hmac`, `credential`, `nonce` or `jwt` (in any case), is reported as `<redacted>`, and so is the file name in a `Content-Disposition` (`filename=<redacted>`, `filename*=<redacted>`). The name pattern is a backstop, not a guarantee: a probe never sets a header holding a real credential or customer value.
- **Cookies are redacted.** Each `Set-Cookie` cookie the probe set becomes `<name>=<redacted>`, unless its name starts with `sv_`, which is reported whole: an `sv_` cookie never holds a real credential or customer value. A probe that needs to show a value writes it into the body or an `sv_` cookie.
- **One lower-cased key per header.** The runner saw two or three casings of each name from `requestSuitelet` at NetSuite 2026.2; values that differ are kept as a list.
- **NetSuite's HTML trailer is dropped.** The trailing `<!-- … -->` comments of a `text/html` body, which name the host, the account and the user's email, are removed before the body is cut at 64 KB (65,536 characters), when the response carries `"truncated": true`.
- **The scrubber still applies**, as for any probe: a header, an `sv_` cookie or a body that names the account is refused, not printed.

The runner stays the only entry point, because the machine-to-machine token reaches RESTlets and no Oracle page says it reaches Suitelets. For a Suitelet probe it checks the parameters, then calls the host from inside the account with `N/https.requestSuitelet` (10 governance units), passing `scriptId` and `deploymentId` (the host's `_sl` ids) and `urlParams` holding the probe name (`probe`) and the parameters as one JSON string (`params`); it rejects a `params` option and `external: true`.

- The host's deployment is never available without login (`isonline` F), its audience is only the runner's role (`allroles` F), and its status is released. Oracle says `requestSuitelet` works only for authenticated users in trusted contexts, so no anonymous URL is needed.
- Like the runner, the host refuses outside a sandbox, runs only the Suitelet probes generated into its own fixed list, checks the parameters again, and reports a throw as `THROWS: <name>: <message>`.
- A failed or unexpected answer from the host is reported, never thrown: `run` stops with `The runner reported an error:` and what the runner saw. See [Troubleshooting](#a-suitelet-probe-reports-that-the-suitelet-host-call-failed).

### Tags

The package validates the tags in a probe's leading JSDoc block: `@scriptType`, `@writes`, `@param`, `@permission`, `@timeout`, the NetSuite `@NApiVersion`, `@NScriptType` and `@NModuleScope`, and the ordinary `@see`, `@link`, `@example`, `@returns`, `@since` and `@deprecated`. Any other tag is reported and stops `run` and `deploy`, so a typo cannot pass silently. A project that keeps its own tags registers them with `SUITESCRIPT_VERIFY_EXTRA_TAGS`, a comma-separated list of tag names without the `@` (for example `flavor,other`). The package checks only that a registered tag is known; what a tag means is up to the project.

`@timeout <seconds>` sets how long `run` waits for the probe: a whole number from 1 to 300 for a RESTlet probe, and from 1 to 45 for a Suitelet probe, since `requestSuitelet` gave up at about 45 seconds in a sandbox at 2026.2 (see [Running one](#running-one)). Without it the limit is 60 seconds for a RESTlet probe and 45 for a Suitelet probe. A malformed or out-of-range value, or a repeated tag, stops `run` and `deploy`, naming the probe and the tag. See [Running one](#running-one) for what happens when the limit passes.

### Governance usage

`run` prints `usage` beside `result` (or `response`): for each script that ran the probe, `{ "before": n, "after": n }`, its remaining governance units just before `run()` and just after it (after a returned Promise settles), plus `"exceeded": true` when it ran out. A RESTlet probe has a `RESTlet` entry. A Suitelet probe has a `Suitelet` entry (the host, which sends it in the wrapped answer or, for an `own` response, in the reserved `X-SSV-Usage` header) and a `RESTlet` entry (the runner), which includes what `requestSuitelet` spends (10 units in a sandbox at 2026.2, also when the call failed). A request refused before the probe ran carries none. A draft page shows it in a separate Usage block.

- **Never compared.** Usage is not part of the expected output: copy an expectation from `result` or `response`, never from the whole printed output. A script is flagged `exceeded` when it caught an error named `SSS_USAGE_LIMIT_EXCEEDED` or its `after` is 0, even if the probe caught the error and returned normally, and `run` then prints a warning line.
- **What was measured** (sandbox, 2026.2, one run each, two checks for running out). A RESTlet started with 5,000 units and the Suitelet host with 1,000, so `before` shows a script's limit; the host's units are independent of the runner's. `SELECT 1 FROM DUAL` through `N/query.runSuiteQL` cost 10 units. Running out was exact (500 such calls used 5,000, 100 used 1,000), the probe, the runner and the host could each catch the error, and the remaining units read 0 afterwards. `search.lookupFields.promise` was charged when called, not when it settled; no other async call was measured.
- **Look-alike.** A slow RESTlet probe can end in a CLI timeout with no answer (see [Running one](#running-one)) or in a usage-limit error; read which one `run` printed before concluding. Do not estimate a call's duration from a few calls.

To check a governance claim in documentation, measure one call (`@scriptType Restlet`, no other tag needed):

```js
/**
 * @scriptType Restlet
 */
define(["N/runtime", "N/query"], (runtime, query) => ({
    run: () => {
        const script = runtime.getCurrentScript();
        const before = script.getRemainingUsage();
        query.runSuiteQL({ query: "SELECT 1 FROM DUAL" });
        return { spent: before - script.getRemainingUsage() };
    },
}));
```

### Writing probes that do not cost a deploy

- **Keep module-scope code rare and tiny.** The runner loads every probe as a dependency of its own `define()`. A probe whose top-level code fails in a way its own `try/catch` cannot capture takes the whole runner down. If you need one, make it one governed call, run it last and one per deploy, so a failure points at one call. Do not keep a probe that is expected to take the runner down; its results page carries the code.
- **The role is minimal.** The runner's role holds only the token-login and REST web services permissions plus what probes declare (and _Other Addresses_, which NetSuite adds, and anything added by hand, which no deploy removes). A probe that searches or loads a record without the record's permission gets `INSUFFICIENT_PERMISSION`. That error comes after type validation, which is often still evidence. A probe that needs a record permission declares it with `@permission <permkey> VIEW` (see [Permissions](#permissions)); never add it to the role by hand. A transaction search also needs Find Transaction (`@permission TRAN_FIND VIEW`). Prefer objects that need no permission (`runtime`, `search.createColumn`).
- **Check how an API is chained before relying on it.** `crypto.createHash(...).update(...)` returns nothing, so chaining `.digest()` threw `Cannot read property 'digest' of undefined` and cost a deploy. Read the method page for the return type.
- **Outbound calls rate-limit.** A public echo service answered four requests in a row and failed the fifth with a body that had no `headers`. Keep a probe to four requests or fewer and put the status code in the failure, not just a `TypeError`.
- **Read the execution log with SuiteQL.** A probe can read `scriptnote`, the script execution log, with `query.runSuiteQL` (columns `date`, `type`, `title`, `detail`, `scripttype`; `type` is the log level, such as `ERROR`). `search.create({ type: "scriptnote" })` throws `INVALID_RCRD_TYPE`, and Oracle documents no such table. Return counts and levels rather than a log's title or detail: log text can carry identifiers, which makes `run` refuse the output. Under the runner's minimal role the query can fail with `Record 'scriptnote' was not found.`: a missing permission worded as a missing table (which permission is not yet identified).
- **`N/cache` cannot watch a running probe.** In a sandbox at 2026.2, a probe that `put` its progress in a `Scope.PRIVATE` cache after each call, read by a second probe while it ran, showed only its first `put` for minutes or for good, even with a new key per call; in one run all its writes appeared 7 to 9 minutes later. That cost a deploy; no channel is known yet for a probe that outlives the CLI.
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

## Upgrading from 1.x

2.0 renames the runner by script type, adds the Suitelet host and makes every deploy write the runner's role. Upgrade in this order:

1. **Turn the 1.x runner off before upgrading.** With 1.x still installed, dry-run `cleanup`, then the person runs `cleanup --approved` (once per runner id the project used). 2.0 names the runner `customscript_<id>_rl` instead of `customscript_<id>_runner`, and the SuiteCloud CLI cannot delete a script, so 2.0 cannot turn the old one off: its first `deploy` or `cleanup` only removes the old object from the generated SDF folder and warns with its id. If you upgraded first, reinstall 1.x and delete `customrole_*.xml`, `customscript_*_rl.xml` and `customscript_*_sl.xml` from the generated `Objects` folder before its `cleanup`, or 1.x fails with `The file reference … restlet.js is missing`. 1.x `cleanup` then sets the old deployment's audience to 2.0's default role id when the project relies on the default.
2. **Upgrade the package** (`npm install --save-dev suitescript-verify@2`). The generated runner file is now `restlet.js`, beside the host's `suitelet.js`, and the runner id may be up to 24 characters.
3. **Declare the permissions your probes need.** From 2.0 the deploy writes the role: `ADMI_LOGIN_OAUTH2` and `ADMI_RESTWEBSERVICES` at Full plus what probes declare, under the name `ssv runner role <runner id>`. Add `@permission <permkey> VIEW` to each probe that relied on a hand-added permission (see [Permissions](#permissions)), so the project carries every permission it needs. A deploy never removes a hand-added permission: remove it by hand once a probe declares it (see the note in step 5 of [Doing it by hand](#doing-it-by-hand)).
4. **Check the role id.** It now defaults to `customrole_<runner id>` instead of `customrole_suitescript_verify`. A project with the default runner id, or an explicit `SUITESCRIPT_VERIFY_ROLE_ID`, keeps its role. A project with its own runner id and no explicit role id gets a new default role, so create that role and map a new runner certificate to it (see [Changing a certificate's role](#changing-a-certificates-role)), or set `SUITESCRIPT_VERIFY_ROLE_ID` to the old id if no other project deploys it. Projects that shared one role in 1.x each need their own now.
5. **Give the SDF login a role that can deploy the runner's role**, never the runner's role itself, since a deploy rewrites it. It needs Bulk Manage Roles: Administrator has it, and a 1.x SDF role usually lacks it. A mapping cannot move to another role, so this takes a new SDF pair, a new mapping and `setup-ci` again (see [Changing a certificate's role](#changing-a-certificates-role)); a 1.x project whose two certificates shared one role regenerates both pairs.
6. **Deploy, then run `doctor`.** Dry-run `deploy`, then the person runs `deploy --approved`. `doctor` now exits 1 until the deployed runner passes its self-check, which replaces a probe that only proved the runner loads; delete such a probe. Then rewrite each own probe's expectation from a fresh `run`.

## Troubleshooting

### `doctor` says "Deploy first"

The self-check got no answer and this project's generated SDF folder holds no deployed runner: nothing is deployed yet, or the runner is deployed from another checkout (a fresh git worktree has no generated `src/`). Before the first deploy the call fails, and `doctor` reports Deploy first. Dry-run `deploy`, then the person runs `deploy --approved`, and run `doctor` again. If the runner was deployed elsewhere, the reason in parentheses says why it did not answer.

### `doctor` says "Redeploy"

The deployed runner differs from the project: another package version or build fingerprint (the templates or a probe's code changed since the deploy), another probe list or role permission list (a probe was added, removed or given a new `@permission` since the last deploy), a Suitelet host that does not answer its self-check or holds other probes, or a runner too old to have a self-check or a build fingerprint ("no build fingerprint (deployed by an older build)"). The message names each difference. Dry-run `deploy`, then ask the person for a redeploy. A host that still does not answer after a redeploy is covered under [the Suitelet host call failed](#a-suitelet-probe-reports-that-the-suitelet-host-call-failed). If the runner did not answer at all after a deploy from this folder, `cleanup` may have switched it off, or the deploy failed.

### `doctor` says "Drift"

The runner's role holds less than the deploy wrote: someone changed the role in the account by hand. The message names each permission with the level the deploy wrote and the level the role holds. A redeploy writes the role again; add a permission a probe needs with `@permission` instead (see [Permissions](#permissions)). A level reported as `UNREADABLE` means `getPermission` could not read that key.

### `doctor` says the runner runs as another role

The runner certificate is mapped to a role other than `SUITESCRIPT_VERIFY_ROLE_ID` (`doctor` prints the one in use). Map it to the runner's role in the sandbox (Setup > Integration > Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup).

### After `cleanup`, the deployments are missing from the Script Deployments list

They are still in the account. `cleanup` switches them off, and in a sandbox at 2026.2 the list (Customization > Scripting > Script Deployments) did not show them until **Show Inactives** was checked. Check it to find them, for example to delete them by hand.

### Every probe returns HTTP 400 and names no probe

The message looks like `com.netsuite.suitescript.scriptobject.ScriptNullObjectAdapter@...`. One probe's top-level code failed in a way its own `try/catch` cannot capture, so the runner never loaded.

`doctor`'s self-check fails the same way, since the runner cannot load to answer it.

1. Move the suspect probe out of the probes folder.
2. Dry-run, then ask the person for a redeploy.
3. Run `doctor` until its self-check passes.

### A Suitelet probe reports that the Suitelet host call failed

`run` says `The runner reported an error: the Suitelet host call failed`, `answered HTTP`, `without its X-SSV-Mode header` or `answer was not JSON`. The runner reached `requestSuitelet`, but the host did not answer with a result. A generic `UNEXPECTED_ERROR` is what `requestSuitelet` gives for a script that does not exist: deploy again (every deploy includes the host), and check that a `cleanup` has not switched it off. `SSS_REQUEST_TIME_EXCEEDED` after about 45 seconds is what a Suitelet probe running longer got in a sandbox at 2026.2 (see [Running one](#running-one)). Another status, an answer without the `X-SSV-Mode` header, or a body that is not JSON, means the host did not run the probe (an HTTP 200 without the header is usually a login or error page, which a redirect followed by `requestSuitelet` also gives), and the start of the body says why. A RESTlet probe that still runs shows the runner itself loads.

### `run` says a probe timed out

`run` exits 1 with `<probe> timed out after N seconds`. The runner did not answer within the probe's limit (its `@timeout`, else 60 seconds for a RESTlet probe and 45 for a Suitelet probe; 15 seconds more when that is the most its type allows), so the CLI stopped waiting and printed no result. If the probe is only slow, raise or drop its `@timeout` (a RESTlet probe may declare up to 300; a Suitelet probe's most, 45, is its default) and run again; `@timeout` needs no redeploy for `run`, but `deploy` must see a valid tag. A probe already at its type's most: split it, or narrow what it reads.

### A probe that returns a Promise fails with HTTP 400 `UNEXPECTED_ERROR`

`run` says `The runner call failed: HTTP 400` with `UNEXPECTED_ERROR` in the body, within seconds. In a sandbox at 2026.2, a probe returning a Promise that never settles (`new Promise(() => {})`, or a lost `resolve`) ended the request this way in about 2 seconds, before the runner could answer, whatever its `@timeout`. Make sure every path of the probe resolves or rejects its Promise.

### A probe returns `INSUFFICIENT_PERMISSION`

The runner's role holds only the token-login and REST web services permissions plus what probes declare with `@permission`, so a probe that reads a record its role cannot view gets this error. It comes after type validation, which is often still evidence. Declare the permission in the probe (see [Permissions](#permissions)) and redeploy; a probe that creates or edits a record cannot get the permission, since only `VIEW` is accepted.

### Every call fails with `401 INVALID_LOGIN_ATTEMPT`

With the machine-to-machine grant alone, the token endpoint issues a token but every call fails. On the integration record, also check **Token-based Authentication** and **TBA: issuetoken Endpoint**, and the RESTlets and REST Web Services scopes.

### `setup-ci` fails with "an error with the private key"

The full message is "There was an error with the private key used to authenticate". The SDF pair is not RSA. Oracle's SDK signs the SDF login with PS256 and only parses an RSA key. Use an RSA-4096 key with an RSA-PSS certificate for the SDF pair, and an EC P-256 pair for the runner. They cannot share a pair (see [Setup](#setup)).

### `setup-ci` fails with "This authentication ID is already in use"

The SuiteCloud CLI already holds the auth id `suitescript-verify` for another role, typically the old SDF role after a role change, and `setup-ci` does not replace it. The person removes it, with `SUITECLOUD_CI_PASSKEY` set to the project's passkey: `npx suitecloud account:manageauth --remove suitescript-verify`. Then run `setup-ci` (or `setup`) again.

### `deploy` fails with "You need the 'Bulk Manage Roles' permission"

The full message is `PermissionViolationError: Permission Violation: You need the 'Bulk Manage Roles' permission to access this page.`, on the role object. The SDF login's role cannot deploy a role: give it Bulk Manage Roles, or use Administrator. The deploy runs as the role behind the auth id `setup-ci` registered, so after moving the SDF login to a new role (with a new pair, see [Changing a certificate's role](#changing-a-certificates-role)), run `setup-ci` again.

### `doctor` fails with `Token request failed: HTTP 400 invalid_grant` after new certificates

The saved certificate ids still name the old mappings. Save the new ids with `env set … --overwrite` (step 3 of [Changing a certificate's role](#changing-a-certificates-role)).

### The runner's role is not in the mapping's role list

A role without _Log in using OAuth 2.0 Access Tokens_ does not appear in the machine-to-machine mapping's role list. Give the role that permission at Full; the first deploy takes the role over.

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

You need the Node.js and npm versions in `package.json` `devEngines`. On any other Node version every npm command in this repository fails with `EBADDEVENGINES`, `npm ci` and `npm run build` included.

```sh
npm install
npm run skills:install   # optional: restores the agent skills for Claude Code
npm test                 # builds, then runs the CLI tests against a fake SuiteCloud CLI
npm run format           # type-checks, then applies Biome's fixes
```

Git hooks (lefthook) run Biome on staged files before each commit.

## License

MIT
