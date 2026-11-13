import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const root = new URL("..", import.meta.url);

/** The files `npm pack` would publish, from a dry run (nothing is written or sent). */
function packedFiles(): string[] {
  const result = spawnSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: root,
    encoding: "utf8",
    shell: true,
  });
  assert.equal(result.status, 0, result.stderr);
  // npm 11 prints an array of packages; npm 12 prints an object keyed by name.
  type Pack = { files: { path: string }[] };
  const parsed = JSON.parse(result.stdout) as Pack[] | Record<string, Pack>;
  const [pack] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.ok(pack, "npm pack reported no package");
  return pack.files.map((file) => file.path);
}

/** What a published version must hold; a build that is missing fails here instead of passing the stray check on an empty list. */
const required = [
  "LICENSE",
  "README.md",
  "dist/bin/suitescript-verify.js",
  "dist/cli.js",
  "package.json",
  "templates/runner.template.js",
  "templates/sdf/manifest.xml",
];

describe("the published package", () => {
  const files = packedFiles();

  it("holds the built CLI, its templates, the README, the license and package.json", () => {
    assert.deepEqual(
      required.filter((file) => !files.includes(file)),
      [],
    );
  });

  it("holds nothing else", () => {
    const allowed = [
      /^dist\//,
      /^templates\//,
      /^README\.md$/,
      /^LICENSE$/,
      /^package\.json$/,
    ];
    const stray = files.filter((file) => !allowed.some((a) => a.test(file)));
    assert.deepEqual(stray, []);
  });

  it("carries no verification results, credentials or the repository's own docs and tests", () => {
    for (const file of files) {
      assert.doesNotMatch(
        file,
        /(^|\/)(docs|test|verification|results)\/|\.env|\.pem$|\.key$/,
        file,
      );
    }
  });
});
