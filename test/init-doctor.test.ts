import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const root = join(import.meta.dirname, "..");
const bin = join(
  import.meta.dirname,
  "..",
  "dist",
  "bin",
  "suitescript-verify.js",
);
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { force: true, recursive: true });
});

function cli(args: string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SUITECLOUD_CLI_ACCEPT_LICENSE;
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("SUITESCRIPT_VERIFY_") ||
      name.startsWith("SUITECLOUD_")
    ) {
      delete env[name];
    }
  }
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input: "",
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

const empty = () => {
  const project = mkdtempSync(join(tmpdir(), "suitescript-verify-"));
  temps.push(project);
  return project;
};
const write = (project: string, file: string, text: string) => {
  mkdirSync(dirname(join(project, file)), { recursive: true });
  writeFileSync(join(project, file), text);
};
/** A project with a fake SuiteCloud CLI installed. */
const withCli = (project: string) => {
  write(
    project,
    "node_modules/@oracle/suitecloud-cli/src/suitecloud.js",
    "process.exit(0);",
  );
  return project;
};
const setLocal = (project: string, values: Record<string, string>) =>
  write(
    project,
    "verification/.env.local",
    Object.entries(values)
      .map(([k, v]) => `SUITESCRIPT_VERIFY_${k}=${v}`)
      .join("\n"),
  );
const pem = (key: KeyObject) =>
  key.export({ format: "pem", type: "pkcs8" }).toString();

const suggested = ["--results-dir", "docs/verification/results"];
/** The one sentence every command gives when the results folder is not chosen. */
const resultsGuidance =
  "Choose where results pages live in your project, then run suitescript-verify init --results-dir <path> (docs/verification/results is the suggested value) or set SUITESCRIPT_VERIFY_RESULTS_DIR in the committed .env.";

describe("init", () => {
  it("will not choose the results folder for the project", () => {
    const project = empty();
    const result = cli(["init"], project);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SUITESCRIPT_VERIFY_RESULTS_DIR/);
    assert.match(result.stderr, /--results-dir/);
    assert.match(result.stderr, /docs\/verification\/results/);
    assert.equal(existsSync(join(project, "verification")), false);
    assert.equal(existsSync(join(project, "docs")), false);
  });

  it("gives init and doctor the same results folder guidance", () => {
    const project = empty();
    const fromInit = cli(["init"], project).stderr;
    const fromDoctor = cli(["doctor"], project).stdout;
    for (const text of [fromInit, fromDoctor]) {
      assert.ok(text.includes(resultsGuidance), text);
    }
  });

  it("writes the chosen results folder to the committed .env and creates it", () => {
    const project = empty();
    const result = cli(["init", "--results-dir", "notes/checks"], project);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(join(project, "verification", ".env"), "utf8"),
      /^SUITESCRIPT_VERIFY_RESULTS_DIR=notes\/checks$/m,
    );
    assert.ok(existsSync(join(project, "notes", "checks")));
    assert.equal(existsSync(join(project, "docs")), false);
  });

  it("refuses a results folder outside the project before creating anything", () => {
    const project = empty();
    const outside = join(project, "..", `${basename(project)}-outside`);
    for (const path of [`../${basename(project)}-outside`, outside]) {
      const result = cli(["init", "--results-dir", path], project);
      assert.equal(result.status, 1, path);
      assert.match(result.stderr, /SUITESCRIPT_VERIFY_RESULTS_DIR/);
      assert.match(result.stderr, /inside the project/);
      assert.equal(existsSync(outside), false);
      assert.equal(existsSync(join(project, "verification")), false);
    }
  });

  it("starts its line on a new line when the existing .env has no trailing newline", () => {
    const project = empty();
    write(project, "verification/.env", "SUITESCRIPT_VERIFY_SDF_DIR=mine");
    assert.equal(cli(["init", ...suggested], project).status, 0);
    const lines = readFileSync(join(project, "verification", ".env"), "utf8")
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(lines, [
      "SUITESCRIPT_VERIFY_SDF_DIR=mine",
      "SUITESCRIPT_VERIFY_RESULTS_DIR=docs/verification/results",
    ]);
  });

  it("says when --results-dir is ignored because the project already sets the key", () => {
    const project = empty();
    write(
      project,
      "verification/.env",
      "SUITESCRIPT_VERIFY_RESULTS_DIR=kept/here\n",
    );
    const result = cli(["init", "--results-dir", "other/place"], project);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SUITESCRIPT_VERIFY_RESULTS_DIR/);
    assert.match(result.stdout, /ignored/i);
    assert.equal(existsSync(join(project, "other")), false);
    assert.ok(existsSync(join(project, "kept", "here")));
  });

  it("asks for the results folder only when the .env does not already set it", () => {
    const project = empty();
    write(
      project,
      "verification/.env",
      "SUITESCRIPT_VERIFY_SDF_DIR=mine\nSUITESCRIPT_VERIFY_RESULTS_DIR=kept/here\n",
    );
    assert.equal(cli(["init"], project).status, 0);
    assert.ok(existsSync(join(project, "kept", "here")));
    const bare = empty();
    write(bare, "verification/.env", "SUITESCRIPT_VERIFY_SDF_DIR=mine\n");
    assert.equal(cli(["init"], bare).status, 1);
    assert.equal(cli(["init", ...suggested], bare).status, 0);
    const env = readFileSync(join(bare, "verification", ".env"), "utf8");
    assert.match(env, /^SUITESCRIPT_VERIFY_SDF_DIR=mine$/m);
    assert.match(
      env,
      /^SUITESCRIPT_VERIFY_RESULTS_DIR=docs\/verification\/results$/m,
    );
  });

  it("scaffolds the probe, results and SDF folders and a committed .env with layout keys only", () => {
    const project = empty();
    const result = cli(["init", ...suggested], project);
    assert.equal(result.status, 0, result.stderr);
    for (const dir of [
      "verification/probes",
      "verification/sdf",
      "docs/verification/results",
    ]) {
      assert.ok(existsSync(join(project, dir)), dir);
    }
    const env = readFileSync(join(project, "verification", ".env"), "utf8");
    assert.match(env, /SUITESCRIPT_VERIFY_PROBES_DIR=verification\/probes/);
    assert.match(env, /SUITESCRIPT_VERIFY_SDF_DIR=verification\/sdf/);
    assert.doesNotMatch(env, /ACCOUNT|PASSKEY|CERTIFICATE|CLIENT/);
  });

  it("creates no credentials", () => {
    const project = empty();
    cli(["init", ...suggested], project);
    assert.equal(
      existsSync(join(project, "verification", ".env.local")),
      false,
    );
    const files = readdirSync(project, { encoding: "utf8", recursive: true });
    assert.equal(
      files.some((f) => /\.(pem|p12|key|crt)$/.test(f)),
      false,
    );
  });

  it("prints a to-do list for the person", () => {
    const out = cli(["init", ...suggested], empty()).stdout;
    assert.match(out, /To do/);
    assert.match(out, /@oracle\/suitecloud-cli/);
    assert.match(out, /license/i);
    assert.match(out, /\.env\.local/);
    assert.match(out, /doctor/);
  });

  it("points at the README of the running package, wherever it is installed", () => {
    const project = empty();
    const out = cli(["init", ...suggested], project).stdout;
    const printed = /installed package README: (\S+)/.exec(out)?.[1];
    assert.ok(printed, "the to-do list names the README");
    assert.equal(
      realpathSync(resolve(project, printed)),
      realpathSync(join(root, "README.md")),
    );
    assert.doesNotMatch(out, /github\.com/);
  });

  it("keeps an existing .env and moves with --dir", () => {
    const project = empty();
    const mine =
      "SUITESCRIPT_VERIFY_SDF_DIR=mine\nSUITESCRIPT_VERIFY_RESULTS_DIR=out\n";
    write(project, "verification/.env", mine);
    cli(["init"], project);
    assert.equal(
      readFileSync(join(project, "verification", ".env"), "utf8"),
      mine,
    );
    cli(["init", "--dir", "elsewhere", ...suggested], project);
    assert.ok(existsSync(join(project, "elsewhere", ".env")));
    assert.ok(existsSync(join(project, "elsewhere", "sdf")));
  });
});

describe("doctor", () => {
  const steps = (out: string) =>
    out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const status = (out: string, name: RegExp) =>
    steps(out)
      .find((l) => name.test(l))
      ?.slice(0, 4)
      .trim();
  const creds = {
    ACCOUNT: "1234567_SB1",
    CERTIFICATE_ID: "cert-one",
    CLIENT_ID: "client-id",
    PASSKEY: "A".repeat(40),
    SDF_CERTIFICATE_ID: "cert-two",
  };

  it("fails every step on an empty project and says which are the maintainer's own", () => {
    const result = cli(["doctor"], empty());
    assert.equal(result.status, 1);
    for (const name of [
      /SuiteCloud CLI/,
      /account/i,
      /certificate/i,
      /passkey/i,
      /sandbox/i,
      /project files/i,
    ]) {
      assert.equal(status(result.stdout, name), "FAIL", String(name));
    }
    assert.match(result.stdout, /Maintainer's own/);
  });

  it("passes the CLI step when the CLI is installed", () => {
    const out = cli(["doctor"], withCli(empty())).stdout;
    assert.equal(status(out, /SuiteCloud CLI/), "ok");
  });

  it("checks the account is a sandbox and never prints it", () => {
    const project = empty();
    setLocal(project, creds);
    const out = cli(["doctor"], project).stdout;
    assert.equal(status(out, /account is a sandbox/i), "ok");
    assert.equal(out.includes("1234567"), false);
    setLocal(project, { ACCOUNT: "1234567" });
    assert.equal(
      status(cli(["doctor"], project).stdout, /account is a sandbox/i),
      "FAIL",
    );
  });

  it("checks the passkey shape without printing it", () => {
    const project = empty();
    setLocal(project, { PASSKEY: "short-secret" });
    const out = cli(["doctor"], project).stdout;
    assert.equal(status(out, /passkey/i), "FAIL");
    assert.equal(out.includes("short-secret"), false);
    setLocal(project, creds);
    assert.equal(status(cli(["doctor"], project).stdout, /passkey/i), "ok");
  });

  it("checks each private key exists and has the right type", () => {
    const project = empty();
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 3072 });
    write(project, "keys/runner.pem", pem(ec.privateKey));
    write(project, "keys/sdf.pem", pem(ec.privateKey));
    const keys = {
      PRIVATE_KEY_PATH: join(project, "keys", "runner.pem"),
      SDF_PRIVATE_KEY_PATH: join(project, "keys", "sdf.pem"),
    };
    setLocal(project, { ...creds, ...keys });
    const out = cli(["doctor"], project).stdout;
    assert.equal(status(out, /runner private key is an EC/), "ok");
    assert.equal(status(out, /SDF private key is an RSA/), "FAIL");
    write(project, "keys/sdf.pem", pem(rsa.privateKey));
    assert.equal(
      status(cli(["doctor"], project).stdout, /SDF private key is an RSA/),
      "ok",
    );
    setLocal(project, {
      ...creds,
      PRIVATE_KEY_PATH: join(project, "keys", "missing.pem"),
    });
    assert.equal(
      status(cli(["doctor"], project).stdout, /runner private key exists/),
      "FAIL",
    );
  });

  it("fails a results step naming the key until the project sets the results folder", () => {
    const project = empty();
    const before = cli(["doctor"], project).stdout;
    assert.equal(status(before, /results folder/i), "FAIL");
    assert.match(before, /SUITESCRIPT_VERIFY_RESULTS_DIR/);
    cli(["init", ...suggested], project);
    assert.equal(
      status(cli(["doctor"], project).stdout, /results folder/i),
      "ok",
    );
  });

  it("fails the results step when the key points outside the project", () => {
    const project = empty();
    write(
      project,
      "verification/.env",
      "SUITESCRIPT_VERIFY_RESULTS_DIR=../elsewhere\n",
    );
    assert.equal(
      status(cli(["doctor"], project).stdout, /results folder/i),
      "FAIL",
    );
  });

  it("checks the project files", () => {
    const project = empty();
    cli(["init", ...suggested], project);
    const before = cli(["doctor"], project).stdout;
    assert.equal(status(before, /project files/i), "FAIL");
    write(project, "verification/sdf/project.json", '{"defaultAuthId":"x"}');
    assert.equal(
      status(cli(["doctor"], project).stdout, /project files/i),
      "ok",
    );
  });

  it("leaves the failing steps as the maintainer's own, and runs nothing", () => {
    const project = withCli(empty());
    write(
      project,
      "node_modules/@oracle/suitecloud-cli/src/suitecloud.js",
      `require("node:fs").writeFileSync(${JSON.stringify(join(project, "ran"))}, "x");`,
    );
    const out = cli(["doctor"], project).stdout;
    assert.match(out, /Maintainer's own/);
    assert.equal(existsSync(join(project, "ran")), false);
  });
});
