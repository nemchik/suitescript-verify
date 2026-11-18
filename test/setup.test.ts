import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { fakeTerminal } from "./fixtures/terminal.ts";

const root = join(import.meta.dirname, "..");
const bin = join(root, "dist", "bin", "suitescript-verify.js");
const fakeNetsuite = `--import=${pathToFileURL(join(import.meta.dirname, "fixtures", "fake-netsuite.mjs")).href}`;
const packageVersion = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { force: true, recursive: true });
});

const temp = (prefix = "suitescript-verify-") => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

/** The values a person types at the hidden prompts; none is a real account. */
const typed = {
  account: "7654321_SB2",
  certificateId: "typed-runner-cert",
  clientId: "typed-client-id",
  sdfCertificateId: "typed-sdf-cert",
};

/** The fake NetSuite's answers once the runner is deployed: a token and a passing self-check. */
const deployed = JSON.stringify({
  restlet: {
    body: {
      selfCheck: {
        host: { packageVersion, probes: [], sandbox: true },
        packageVersion,
        permissions: {
          ADMI_LOGIN_OAUTH2: "FULL",
          ADMI_RESTWEBSERVICES: "FULL",
        },
        probes: [],
        role: "customrole_suitescript_verify",
        sandbox: true,
      },
    },
    status: 200,
  },
  token: { body: { access_token: "tok-abc" }, status: 200 },
});

/**
 * The fake SuiteCloud CLI: logs only the command it was given (never an
 * argument, which can hold the account) and acts as the real one does for
 * setup: account:setup:ci stores a CI login and the project's default auth id,
 * and a real deploy makes the fake NetSuite's runner answer its self-check,
 * with the build fingerprint the deploy baked into the generated runner.
 */
const fakeCli = (log: string, script: string) => `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const command = process.argv[2];
fs.appendFileSync(${JSON.stringify(log)}, command + (process.argv.includes("--dryrun") ? " --dryrun" : "") + (process.env.SUITECLOUD_CLI_ACCEPT_LICENSE === undefined ? "" : " LICENSE") + "\\n");
const fails = JSON.parse(process.env.FAKE_SUITECLOUD_FAILS ?? "{}")[command];
if (fails) {
  console.error(fails);
  process.exit(1);
}
if (command === "account:setup:ci") {
  fs.mkdirSync(path.join(os.homedir(), ".suitecloud-sdk"), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), ".suitecloud-sdk", "credentials_ci.p12"), "x");
  fs.writeFileSync("project.json", JSON.stringify({ defaultAuthId: "suitescript-verify" }));
}
if (command === "project:deploy" && !process.argv.includes("--dryrun")) {
  const cabinet = path.join("src", "FileCabinet");
  const runner = fs
    .readdirSync(cabinet, { recursive: true })
    .map(String)
    .find((file) => file.endsWith("restlet.js"));
  const build = /build: "([0-9a-f]{12})"/.exec(
    fs.readFileSync(path.join(cabinet, runner), "utf8"),
  )[1];
  const answer = JSON.parse(${JSON.stringify(deployed)});
  answer.restlet.body.selfCheck.build = build;
  answer.restlet.body.selfCheck.host.build = build;
  fs.writeFileSync(${JSON.stringify(script)}, JSON.stringify(answer));
}`;

/** A folder on the PATH with a `java` that prints `version`, as the real one does; on Windows, the machine's own Java. */
const java = (version: string) => {
  if (process.platform === "win32") return {};
  const dir = temp();
  write(dir, "java", `#!/bin/sh\necho '${version}' 1>&2\n`);
  chmodSync(join(dir, "java"), 0o755);
  return { PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };
};
const goodJava = java('openjdk version "21.0.1" 2023-10-17');
const machineJava = /version "(17|21)[".]/.test(
  spawnSync("java", ["-version"], { encoding: "utf8" }).stderr ?? "",
);
const hasOpenssl =
  spawnSync("openssl", ["version"]).status === 0 ||
  existsSync("C:\\Program Files\\Git\\usr\\bin\\openssl.exe");
const needsJava =
  process.platform === "win32" && !machineJava
    ? "needs Java 17 or 21 on Windows"
    : false;

interface Project {
  dir: string;
  home: string;
  commands: () => string[];
  healthy: () => void;
}

/**
 * A project after `init`, with the fake SuiteCloud CLI and its SDK jar in an
 * empty home folder. NetSuite is the fake fetch: unreachable until `healthy`
 * makes the runner answer a passing self-check.
 */
function project(): Project {
  const dir = temp();
  const home = temp("suitescript-verify-home-");
  const log = join(dir, "suitecloud.log");
  const script = join(dir, "fake-netsuite.json");
  write(
    dir,
    "node_modules/@oracle/suitecloud-cli/src/suitecloud.js",
    fakeCli(log, script),
  );
  write(
    dir,
    "node_modules/@oracle/suitecloud-cli/package.json",
    '{"name":"@oracle/suitecloud-cli","version":"0.0.0","sdkFilename":"cli-9.9.9.jar"}',
  );
  write(home, ".suitecloud-sdk/cli/cli-9.9.9.jar", "x");
  write(
    dir,
    "verification/.env",
    "SUITESCRIPT_VERIFY_RESULTS_DIR=docs/verification/results\n",
  );
  for (const sub of [
    "verification/probes",
    "verification/sdf",
    "docs/verification/results",
  ]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  write(dir, ".gitignore", "verification/.env.local\n");
  return {
    commands: () =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    dir,
    healthy: () => writeFileSync(script, deployed),
    home,
  };
}

/** Runs the built CLI in the project with its own home folder and no inherited settings. */
function cli(p: Project, args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, ...goodJava };
  delete base.SUITECLOUD_CLI_ACCEPT_LICENSE;
  for (const name of Object.keys(base)) {
    if (
      name.startsWith("SUITESCRIPT_VERIFY_") ||
      name.startsWith("SUITECLOUD_")
    ) {
      delete base[name];
    }
  }
  const script = join(p.dir, "fake-netsuite.json");
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: p.dir,
    encoding: "utf8",
    env: {
      ...base,
      FAKE_NETSUITE_SCRIPT: script,
      HOME: p.home,
      USERPROFILE: p.home,
      ...env,
      NODE_OPTIONS: [fakeNetsuite, env.NODE_OPTIONS].filter(Boolean).join(" "),
    },
    input: "",
  });
  return {
    all: `${result.stdout}${result.stderr}`,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

/** Every file under `dir`, recursively, as text. */
const filesUnder = (dir: string) =>
  readdirSync(dir, { encoding: "utf8", recursive: true })
    .map((file) => join(dir, file))
    .filter((file) => {
      try {
        return readFileSync(file) !== undefined;
      } catch {
        return false;
      }
    });

const localEnv = (p: Project) =>
  readFileSync(join(p.dir, "verification", ".env.local"), "utf8");

describe("setup", () => {
  it("refuses without a terminal and changes nothing", () => {
    const p = project();
    const result = cli(p, ["setup"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs the user at a terminal/);
    assert.match(result.stderr, /suitescript-verify setup/);
    assert.equal(existsSync(join(p.dir, "verification", ".env.local")), false);
    assert.deepEqual(p.commands(), []);
  });

  /** The answers of a first run: Enter after the checklist, the four hidden values, then DEPLOY. */
  const firstRun = [
    "",
    typed.account,
    typed.clientId,
    typed.certificateId,
    typed.sdfCertificateId,
    "DEPLOY",
  ];

  it("walks a first run through every step, in order, and ends with a passing doctor", {
    skip: !hasOpenssl ? "needs openssl" : needsJava,
  }, () => {
    const p = project();
    const result = cli(p, ["setup"], fakeTerminal(firstRun));
    assert.equal(result.status, 0, result.all);
    const order = [
      /Step 1 of 8: SuiteCloud CLI and Java: already passes/,
      /Step 2 of 8: Certificate pairs:/,
      /Step 3 of 8: Sandbox checklist:/,
      /Step 4 of 8: Account, client id and certificate ids:/,
      /Step 5 of 8: Passkey:/,
      /Step 6 of 8: Register the SDF login/,
      /Step 7 of 8: First deploy/,
      /Step 8 of 8: doctor/,
      /All checks passed\./,
    ].map((pattern) => {
      const at = result.stdout.search(pattern);
      assert.ok(at >= 0, `${pattern} in\n${result.stdout}`);
      return at;
    });
    assert.deepEqual(
      order,
      [...order].sort((a, b) => a - b),
    );
    // The deploy is the confirmed one, not a dry run, and no license was accepted.
    assert.deepEqual(p.commands(), ["account:setup:ci", "project:deploy"]);
    const env = localEnv(p);
    assert.match(env, /^SUITESCRIPT_VERIFY_ACCOUNT=7654321_SB2$/m);
    assert.match(env, /^SUITESCRIPT_VERIFY_CLIENT_ID=typed-client-id$/m);
    assert.match(env, /^SUITESCRIPT_VERIFY_CERTIFICATE_ID=typed-runner-cert$/m);
    assert.match(
      env,
      /^SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID=typed-sdf-cert$/m,
    );
    assert.match(
      env,
      /^SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH=.*runner-private\.pem$/m,
    );
    assert.match(
      env,
      /^SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH=.*sdf-private\.pem$/m,
    );
    assert.match(env, /^SUITESCRIPT_VERIFY_PASSKEY=[a-f0-9]{60}$/m);
  });

  it("prints the one-trip sandbox checklist with the role and each public certificate's path", {
    skip: !hasOpenssl ? "needs openssl" : needsJava,
  }, () => {
    const p = project();
    const out = cli(p, ["setup"], fakeTerminal(firstRun)).stdout;
    for (const pattern of [
      /integration record/i,
      /Client Credentials \(Machine To Machine\) Grant/,
      /Token-based Authentication and TBA: issuetoken Endpoint/,
      /RESTlets and REST Web Services scopes/,
      /Copy its client id now; it is shown only once, at creation, and setup asks for it later/,
      /ssv runner role suitescript_verify/,
      /type _suitescript_verify in the ID field \(NetSuite adds customrole\)/,
      /assign it to yourself on your employee record \(Access > Roles\)/,
      /only the permission Log in using OAuth 2\.0 Access Tokens \(Full\)/,
      /A role without the permission is not in the mapping's role list/,
      /runner certificate \S*runner-public\.pem -> the role customrole_suitescript_verify/,
      /SDF certificate \S*sdf-public\.pem -> a role that can deploy/,
      /account:setup/,
      /Press Enter when the sandbox steps are done/,
    ]) {
      assert.match(out, pattern);
    }
  });

  it("never echoes, prints or writes a typed value anywhere but .env.local", {
    skip: !hasOpenssl ? "needs openssl" : needsJava,
  }, () => {
    const p = project();
    const log = join(temp(), "typed.log");
    const result = cli(p, ["setup"], fakeTerminal(firstRun, {}, log));
    assert.equal(result.status, 0, result.all);
    // Each value was typed with raw mode on, so the terminal echoed nothing.
    assert.deepEqual(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).raw),
      [false, true, true, true, true, false],
    );
    const secrets = Object.values(typed).concat("7654321");
    for (const secret of secrets) {
      assert.equal(result.all.includes(secret), false, secret);
    }
    const env = join(p.dir, "verification", ".env.local");
    for (const file of [...filesUnder(p.dir), ...filesUnder(p.home)]) {
      if (file === env || file === log) continue;
      const text = readFileSync(file, "latin1");
      for (const secret of secrets) {
        assert.equal(text.includes(secret), false, `${secret} in ${file}`);
      }
    }
  });

  it("skips every step doctor already passes on a rerun, asking nothing", {
    skip: !hasOpenssl ? "needs openssl" : needsJava,
  }, () => {
    const p = project();
    assert.equal(cli(p, ["setup"], fakeTerminal(firstRun)).status, 0);
    const before = localEnv(p);
    const result = cli(p, ["setup"], fakeTerminal([]));
    assert.equal(result.status, 0, result.all);
    for (let step = 1; step <= 7; step++) {
      assert.match(
        result.stdout,
        new RegExp(`Step ${step} of 8: [^\\n]*: already passes, skipped\\.`),
      );
    }
    assert.match(result.stdout, /All checks passed\./);
    assert.deepEqual(p.commands(), ["account:setup:ci", "project:deploy"]);
    assert.equal(localEnv(p), before);
  });

  it("keeps an existing value on Enter, replaces one typed anew, and goes on to doctor when the deploy is declined", {
    skip: !hasOpenssl ? "needs openssl" : needsJava,
  }, () => {
    const p = project();
    write(
      p.dir,
      "verification/.env.local",
      "SUITESCRIPT_VERIFY_ACCOUNT=1111111_SB1\nSUITESCRIPT_VERIFY_CLIENT_ID=old-client-id\n",
    );
    const result = cli(
      p,
      ["setup"],
      fakeTerminal([
        "",
        "",
        typed.clientId,
        typed.certificateId,
        typed.sdfCertificateId,
        "",
      ]),
    );
    assert.match(
      result.stdout,
      /SUITESCRIPT_VERIFY_ACCOUNT is set; press Enter to keep it/,
    );
    assert.match(
      result.stdout,
      /Kept the existing SUITESCRIPT_VERIFY_ACCOUNT\./,
    );
    const env = localEnv(p);
    assert.match(env, /^SUITESCRIPT_VERIFY_ACCOUNT=1111111_SB1$/m);
    assert.match(env, /^SUITESCRIPT_VERIFY_CLIENT_ID=typed-client-id$/m);
    assert.doesNotMatch(env, /old-client-id/);
    for (const secret of ["1111111", "old-client-id", typed.clientId]) {
      assert.equal(result.all.includes(secret), false, secret);
    }
    // Declined: no deploy, and doctor still runs and says to deploy first.
    assert.match(result.stdout, /Skipped the deploy\./);
    assert.deepEqual(p.commands(), ["account:setup:ci"]);
    assert.match(result.stdout, /Step 8 of 8: doctor/);
    assert.match(result.stdout, /Deploy first/);
    assert.equal(result.status, 1);
  });

  it("asks for the new certificate ids after generating new pairs, even when ids are already set", {
    skip: !hasOpenssl ? "needs openssl" : needsJava,
  }, () => {
    const p = project();
    write(
      p.dir,
      "verification/.env.local",
      [
        "SUITESCRIPT_VERIFY_ACCOUNT=1111111_SB1",
        "SUITESCRIPT_VERIFY_CLIENT_ID=old-client-id",
        "SUITESCRIPT_VERIFY_CERTIFICATE_ID=old-runner-cert",
        "SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID=old-sdf-cert",
        "",
      ].join("\n"),
    );
    const result = cli(
      p,
      ["setup"],
      fakeTerminal([
        "",
        "",
        "",
        "",
        typed.certificateId,
        typed.sdfCertificateId,
        "",
      ]),
    );
    assert.match(result.stdout, /Step 2 of 8: Certificate pairs:/);
    assert.match(
      result.stdout,
      /Step 4 of 8: Account, client id and certificate ids:/,
    );
    assert.match(
      result.stdout,
      /Kept the existing SUITESCRIPT_VERIFY_CLIENT_ID\./,
    );
    // An Enter at a renewed certificate id keeps nothing: the old mapping's id is wrong now.
    assert.match(
      result.stdout,
      /Runner certificate id \(SUITESCRIPT_VERIFY_CERTIFICATE_ID, new pair: the id of its new mapping, hidden\)/,
    );
    assert.match(
      result.stdout,
      /SUITESCRIPT_VERIFY_CERTIFICATE_ID is needed\./,
    );
    const env = localEnv(p);
    assert.match(env, /^SUITESCRIPT_VERIFY_ACCOUNT=1111111_SB1$/m);
    assert.match(env, /^SUITESCRIPT_VERIFY_CLIENT_ID=old-client-id$/m);
    assert.match(env, /^SUITESCRIPT_VERIFY_CERTIFICATE_ID=typed-runner-cert$/m);
    assert.match(
      env,
      /^SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID=typed-sdf-cert$/m,
    );
  });

  it("prints the fix when setup-ci finds the auth id in use, and removes nothing itself", {
    skip: !hasOpenssl ? "needs openssl" : needsJava,
  }, () => {
    const p = project();
    const result = cli(
      p,
      ["setup"],
      fakeTerminal(firstRun, {
        FAKE_SUITECLOUD_FAILS: JSON.stringify({
          "account:setup:ci":
            "This authentication ID is already in use. Choose a different authentication ID for this account-role combination.",
        }),
      }),
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /suitecloud account:manageauth --remove suitescript-verify[^\n]*passkey/i,
    );
    assert.match(result.stdout, /then run [^\n]*setup[^\n]* again/);
    assert.deepEqual(p.commands(), ["account:setup:ci"]);
  });

  it("names the missing Bulk Manage Roles permission when the deploy is refused for it", {
    skip: !hasOpenssl ? "needs openssl" : needsJava,
  }, () => {
    const p = project();
    const result = cli(
      p,
      ["setup"],
      fakeTerminal(firstRun, {
        FAKE_SUITECLOUD_FAILS: JSON.stringify({
          "project:deploy":
            "ERROR: com.netledger.app.accesscontrol.PermissionViolationError: Permission Violation: You need  the 'Bulk Manage Roles' permission to access this page.",
        }),
      }),
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /The SDF login's role needs Bulk Manage Roles \(or Administrator\)[^\n]*setup-ci must have registered that role/,
    );
  });

  it("stops with the fix when the SuiteCloud CLI is not installed, before anything else", () => {
    const p = project();
    rmSync(join(p.dir, "node_modules"), { force: true, recursive: true });
    const result = cli(p, ["setup"], fakeTerminal([]));
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /npm install --save-dev @oracle\/suitecloud-cli/,
    );
    assert.match(result.stdout, /accept it yourself/);
    assert.doesNotMatch(result.stdout, /Step 2 of 8/);
    assert.equal(existsSync(join(p.dir, "verification", ".env.local")), false);
  });

  it("stops with the fix when Java 17 or 21 is not on the PATH", () => {
    const p = project();
    const result = cli(p, ["setup"], fakeTerminal([], { PATH: temp() }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Install Java 17 or 21/);
    assert.doesNotMatch(result.stdout, /Step 2 of 8/);
    assert.equal(existsSync(join(p.dir, "verification", ".env.local")), false);
  });

  it("refuses before init has made the folders", () => {
    const p = project();
    rmSync(join(p.dir, "verification", "sdf"), { recursive: true });
    const result = cli(p, ["setup"], fakeTerminal([]));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Run suitescript-verify init first/);
  });
});

describe("init offers setup", () => {
  const fresh = () => {
    const p = project();
    rmSync(join(p.dir, "verification"), { force: true, recursive: true });
    return p;
  };
  const offer =
    /Continue into guided setup now \(suitescript-verify setup\)\? \[y\/N\]/;

  it("does not offer setup without a terminal", () => {
    const p = fresh();
    const result = cli(p, [
      "init",
      "--results-dir",
      "docs/verification/results",
    ]);
    assert.equal(result.status, 0, result.all);
    assert.doesNotMatch(result.stdout, offer);
    assert.doesNotMatch(result.stdout, /Step 1 of 8/);
  });

  it("offers setup at a terminal and leaves it on no", () => {
    const p = fresh();
    const result = cli(
      p,
      ["init", "--results-dir", "docs/verification/results"],
      fakeTerminal(["n"]),
    );
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, offer);
    assert.doesNotMatch(result.stdout, /Step 1 of 8/);
  });

  it("continues into setup on yes", () => {
    const p = fresh();
    rmSync(join(p.dir, "node_modules"), { force: true, recursive: true });
    const result = cli(
      p,
      ["init", "--results-dir", "docs/verification/results"],
      fakeTerminal(["y"]),
    );
    assert.match(result.stdout, offer);
    assert.match(result.stdout, /Step 1 of 8: SuiteCloud CLI and Java/);
    // Setup stopped at the missing CLI, with its fix.
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /npm install --save-dev @oracle\/suitecloud-cli/,
    );
  });
});
