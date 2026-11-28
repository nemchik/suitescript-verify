import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const script = join(import.meta.dirname, "..", "scripts", "track-modules.ts");
const sources = join(import.meta.dirname, "fixtures", "module-sources");
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { force: true, recursive: true });
});

/** The fake `gh`: logs each call as a JSON line and answers `issue list` from `open.json`. */
const fakeGh = String.raw`
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
appendFileSync(dir + "/calls.jsonl", JSON.stringify(args) + "\n");
if (args[0] === "issue" && args[1] === "list") {
  const file = dir + "/open.json";
  process.stdout.write(existsSync(file) ? readFileSync(file, "utf8") : "[]");
}
`;

function run(
  args: string[],
  options: { open?: string[]; brokenSource?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "track-modules-"));
  temps.push(dir);
  writeFileSync(join(dir, "gh.mjs"), fakeGh);
  writeFileSync(
    join(dir, "open.json"),
    JSON.stringify((options.open ?? []).map((title) => ({ title }))),
  );
  const summary = join(dir, "summary.md");
  const flags = [
    "--help-page",
    join(sources, "help.html"),
    "--unit-testing",
    join(sources, "unit-testing"),
    "--types",
    join(sources, "types"),
  ];
  if (options.brokenSource) {
    const at = flags.indexOf(`--${options.brokenSource}`);
    flags[at + 1] = join(dir, "missing");
  }
  const result = spawnSync(process.execPath, [script, ...flags, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_GH_DIR: dir,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_STEP_SUMMARY: summary,
      MODULE_TRACKING_GH: JSON.stringify([
        process.execPath,
        join(dir, "gh.mjs"),
      ]),
    },
  });
  const callsFile = join(dir, "calls.jsonl");
  const calls = existsSync(callsFile)
    ? readFileSync(callsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    : [];
  return {
    calls,
    status: result.status,
    stderr: result.stderr,
    summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
  };
}

const creates = (calls: string[][]) =>
  calls.filter((c) => c[0] === "issue" && c[1] === "create");
const titleOf = (call: string[]) => call[call.indexOf("--title") + 1] ?? "";

describe("track-modules", () => {
  it("reports each unclassified module once, combining all three sources", () => {
    const { status, summary, calls, stderr } = run([]);
    assert.equal(status, 0, stderr);
    for (const name of [
      "N/pgp",
      "N/manufacturing/productionCharges",
      "N/newunit",
      "N/typesonly",
    ]) {
      assert.equal(
        summary.split(`\`${name}\``).length - 1,
        1,
        `${name} listed once`,
      );
    }
    assert.doesNotMatch(summary, /`N\/log`/);
    assert.doesNotMatch(summary, /`N\/ui`/);
    assert.doesNotMatch(summary, /`N\/commerce`/);
    assert.equal(calls.length, 0, "pull-request mode never calls gh");
  });

  it("opens one issue per finding in scheduled mode and skips open duplicates", () => {
    const { status, calls, stderr } = run(["--open-issues"], {
      open: ["Classify module N/pgp"],
    });
    assert.equal(status, 0, stderr);
    const titles = creates(calls).map(titleOf);
    assert.ok(titles.includes("Classify module N/newunit"));
    assert.ok(!titles.includes("Classify module N/pgp"));
    assert.equal(new Set(titles).size, titles.length);
  });

  it("reports an unreadable source as a finding and still exits 0", () => {
    const { status, summary, calls, stderr } = run(["--open-issues"], {
      brokenSource: "types",
    });
    assert.equal(status, 0, stderr);
    assert.match(summary, /Unreadable source/);
    const titles = creates(calls).map(titleOf);
    assert.ok(
      titles.includes("Module source unreadable: @hitc/netsuite-types"),
    );
    assert.ok(titles.includes("Classify module N/newunit"));
  });

  it("does not open a second issue for an unreadable source", () => {
    const { calls } = run(["--open-issues"], {
      brokenSource: "help-page",
      open: [
        "Module source unreadable: Oracle's SuiteScript 2.x Modules help page",
      ],
    });
    assert.ok(
      !creates(calls)
        .map(titleOf)
        .some((t) => t.startsWith("Module source unreadable")),
    );
  });

  it("opens nothing in pull-request mode even with an unreadable source", () => {
    const { status, calls, summary, stderr } = run([], {
      brokenSource: "unit-testing",
    });
    assert.equal(status, 0, stderr);
    assert.equal(calls.length, 0);
    assert.match(summary, /Unreadable source/);
  });
});
