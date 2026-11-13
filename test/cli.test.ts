import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

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

/** Settings every command that reaches the sandbox needs; none is a real account. */
const sandboxEnv = {
  SUITESCRIPT_VERIFY_ACCOUNT: "1234567_SB1",
  SUITESCRIPT_VERIFY_CERTIFICATE_ID: "cert-runner-id",
  SUITESCRIPT_VERIFY_CLIENT_ID: "client-id-value",
  SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH: "unused.pem",
  SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID: "cert-sdf-id",
  SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH: "unused-sdf.pem",
};

/** Runs the built CLI in `cwd`, with the SuiteCloud license variable removed from the environment. */
function cli(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SUITECLOUD_CLI_ACCEPT_LICENSE;
  for (const name of Object.keys(env)) {
    if (name.startsWith("SUITESCRIPT_VERIFY_")) delete env[name];
  }
  Object.assign(env, sandboxEnv, extraEnv);
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

/**
 * A temporary project whose `@oracle/suitecloud-cli` is a fake that records
 * how it was called (arguments, working folder and whether the license variable
 * was set) to `calls.json` in the project, instead of touching NetSuite.
 */
function fakeProject({ withCli = true } = {}) {
  const project = mkdtempSync(join(tmpdir(), "suitescript-verify-"));
  temps.push(project);
  mkdirSync(join(project, "verification", "sdf"), { recursive: true });
  if (withCli) {
    const dir = join(
      project,
      "node_modules",
      "@oracle",
      "suitecloud-cli",
      "src",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(
        project,
        "node_modules",
        "@oracle",
        "suitecloud-cli",
        "package.json",
      ),
      '{"name":"@oracle/suitecloud-cli","version":"0.0.0"}',
    );
    writeFileSync(
      join(dir, "suitecloud.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(join(project, "calls.json"))}, JSON.stringify({
        args: process.argv.slice(2),
        cwd: process.cwd(),
        license: process.env.SUITECLOUD_CLI_ACCEPT_LICENSE ?? null,
        passkey: process.env.SUITECLOUD_CI_PASSKEY ?? null,
      }));`,
    );
  }
  return project;
}

const calls = (project: string) =>
  JSON.parse(readFileSync(join(project, "calls.json"), "utf8")) as {
    args: string[];
    cwd: string;
    license: string | null;
    passkey: string | null;
  };

describe("help", () => {
  it("lists the commands", () => {
    const result = cli(["help"], tmpdir());
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: suitescript-verify/);
    assert.match(result.stdout, /deploy/);
  });

  it("is what a bare run and --help show", () => {
    assert.equal(cli([], tmpdir()).stdout, cli(["--help"], tmpdir()).stdout);
  });

  it("rejects an unknown command", () => {
    const result = cli(["frobnicate"], tmpdir());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command "frobnicate"/);
  });
});

describe("deploy", () => {
  it("dry-runs through the project's SuiteCloud CLI, from the SDF folder, without the license variable", () => {
    const project = fakeProject();
    const result = cli(["deploy"], project);
    assert.equal(result.status, 0, result.stderr);
    const call = calls(project);
    assert.deepEqual(call.args, ["project:deploy", "--dryrun"]);
    assert.match(call.cwd.replaceAll("\\", "/"), /verification\/sdf$/);
    assert.equal(call.license, null);
  });

  it("moves the verification folder with --dir", () => {
    const project = fakeProject();
    mkdirSync(join(project, "elsewhere", "sdf"), { recursive: true });
    const result = cli(["deploy", "--dir", "elsewhere"], project);
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls(project).cwd.replaceAll("\\", "/"), /elsewhere\/sdf$/);
  });

  it("refuses a real deploy without a terminal and never calls the CLI", () => {
    const project = fakeProject();
    const result = cli(["deploy", "--approved"], project);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs the user at a terminal/);
    assert.equal(existsSync(join(project, "calls.json")), false);
  });

  it("says what to install when the SuiteCloud CLI is missing", () => {
    const result = cli(["deploy"], fakeProject({ withCli: false }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@oracle\/suitecloud-cli/);
  });
});

const norm = (path: string) => path.replaceAll("\\", "/");
const git = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });
const write = (project: string, file: string, text: string) => {
  mkdirSync(join(project, file, ".."), { recursive: true });
  writeFileSync(join(project, file), text);
};
const sdfKey = "SUITESCRIPT_VERIFY_SDF_DIR";

describe("layered configuration", () => {
  it("falls back to the default SDF folder, then each layer overrides the last", () => {
    const project = fakeProject();
    for (const dir of ["one", "two", "three"]) {
      mkdirSync(join(project, dir), { recursive: true });
    }
    const cwdAfter = (env: Record<string, string> = {}) => {
      assert.equal(cli(["deploy"], project, env).status, 0);
      return norm(calls(project).cwd);
    };
    assert.match(cwdAfter(), /verification\/sdf$/);
    write(project, "verification/.env", `${sdfKey}=one\n`);
    assert.match(cwdAfter(), /\/one$/);
    write(project, "verification/.env.local", `${sdfKey}=two\n`);
    assert.match(cwdAfter(), /\/two$/);
    assert.match(cwdAfter({ [sdfKey]: "three" }), /\/three$/);
  });

  it("hands a passkey from .env.local to the SuiteCloud CLI for the child only", () => {
    const project = fakeProject();
    write(
      project,
      "verification/.env.local",
      "SUITESCRIPT_VERIFY_PASSKEY=local-pass\n",
    );
    assert.equal(cli(["deploy"], project).status, 0);
    assert.equal(calls(project).passkey, "local-pass");
  });

  it("moves the env files with --dir", () => {
    const project = fakeProject();
    mkdirSync(join(project, "elsewhere", "custom"), { recursive: true });
    write(project, "elsewhere/.env", `${sdfKey}=elsewhere/custom\n`);
    write(project, "verification/.env", `${sdfKey}=nowhere\n`);
    const result = cli(["deploy", "--dir", "elsewhere"], project);
    assert.equal(result.status, 0, result.stderr);
    assert.match(norm(calls(project).cwd), /elsewhere\/custom$/);
  });
});

describe("the committed .env allowlist", () => {
  const secret = "s3cr3t-VALUE-0123456789abcdef0123456789abcdef";
  const bad: Record<string, [string, string]> = {
    "a credential key": [
      "SUITESCRIPT_VERIFY_PASSKEY",
      `SUITESCRIPT_VERIFY_PASSKEY=${secret}`,
    ],
    "a path outside the project": [sdfKey, `${sdfKey}=../${secret}`],
    "a secret-looking value": [
      "SUITESCRIPT_VERIFY_PROBES_DIR",
      `SUITESCRIPT_VERIFY_PROBES_DIR=${secret}`,
    ],
    "an unknown key": [
      "SUITESCRIPT_VERIFY_MYSTERY",
      `SUITESCRIPT_VERIFY_MYSTERY=${secret}`,
    ],
  };
  for (const [name, [key, line]] of Object.entries(bad)) {
    it(`refuses ${name}, names the key and never prints the value`, () => {
      const project = fakeProject();
      write(project, "verification/.env", `${line}\n`);
      const result = cli(["deploy"], project);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(key), result.stderr);
      assert.equal((result.stdout + result.stderr).includes(secret), false);
      assert.equal(existsSync(join(project, "calls.json")), false);
    });
  }

  it("accepts the layout keys", () => {
    const project = fakeProject();
    write(
      project,
      "verification/.env",
      "SUITESCRIPT_VERIFY_PROBES_DIR=verification/probes\nSUITESCRIPT_VERIFY_RESULTS_DIR=docs/verification/results\n",
    );
    assert.equal(cli(["deploy"], project).status, 0);
  });

  for (const command of ["doctor", "init"]) {
    it(`${command} reports a bad key instead of refusing`, () => {
      const project = fakeProject();
      write(
        project,
        "verification/.env",
        `SUITESCRIPT_VERIFY_MYSTERY=${secret}\n`,
      );
      const result = cli([command], project);
      assert.equal(result.status, command === "doctor" ? 1 : 0);
      assert.match(result.stdout, /SUITESCRIPT_VERIFY_MYSTERY/);
      assert.equal((result.stdout + result.stderr).includes(secret), false);
    });
  }
});

describe(".env.local must be gitignored", () => {
  const repo = () => {
    const project = fakeProject();
    git(project, ["init", "-q"]);
    return project;
  };

  it("flags a .env.local that is not ignored, in every command", () => {
    const project = repo();
    write(project, "verification/.env.local", "SUITESCRIPT_VERIFY_ACCOUNT=1\n");
    const result = cli(["deploy"], project);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.local/);
    assert.match(result.stderr, /gitignore/);
    assert.match(cli(["doctor"], project).stdout, /\.env\.local/);
  });

  it("flags a tracked .env.local even when it is ignored", () => {
    const project = repo();
    write(project, "verification/.env.local", "SUITESCRIPT_VERIFY_ACCOUNT=1\n");
    git(project, ["add", "-f", "verification/.env.local"]);
    write(project, ".gitignore", "verification/.env.local\n");
    const result = cli(["deploy"], project);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tracked/);
  });

  it("passes when .env.local is ignored", () => {
    const project = repo();
    write(project, ".gitignore", "verification/.env.local\n");
    write(project, "verification/.env.local", "SUITESCRIPT_VERIFY_ACCOUNT=1\n");
    assert.equal(cli(["deploy"], project).status, 0);
  });
});
