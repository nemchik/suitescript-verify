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
  const [pack] = JSON.parse(result.stdout) as { files: { path: string }[] }[];
  return (pack?.files ?? []).map((file) => file.path);
}

describe("the published package", () => {
  const files = packedFiles();

  it("holds only the compiled code, the templates, the README, the license and package.json", () => {
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

  it("ships the built CLI and its templates", () => {
    assert.ok(files.includes("dist/bin/suitescript-verify.js"));
    assert.ok(files.includes("templates/runner.template.js"));
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
