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

/** Runs the built CLI in `cwd`, with the SuiteCloud license variable removed from the environment. */
function cli(args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.SUITECLOUD_CLI_ACCEPT_LICENSE;
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
