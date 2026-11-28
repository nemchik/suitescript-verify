// Notices `N/` modules the package has not classified (#92).
//
// Reads three sources, combines the modules they name and compares the result with `moduleClasses` in
// `src/modules.ts`:
//   - Oracle's SuiteScript 2.x Modules help page,
//   - the module stubs of the latest `@oracle/suitecloud-unit-testing`,
//   - the modules the latest `@hitc/netsuite-types` imports in `N.d.ts`.
//
// Without `--open-issues` it only writes what it found to stdout and `$GITHUB_STEP_SUMMARY`. With it, it also
// opens one issue per unclassified module and per unreadable source, skipping any whose issue is already open.
// A finding never fails the run; only a bug in this script does.
//
// `--help-page <file>`, `--unit-testing <dir>` and `--types <dir>` read a stored copy of a source instead of
// the live one (the tests use them). `MODULE_TRACKING_GH` is a JSON array holding the `gh` command to run.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { moduleClasses } from "../src/modules.ts";

const helpPageUrl =
  "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_4220488571.html";

/** Namespaces that group modules but are not modules themselves. */
const namespaces = new Set(["N/ui", "N/commerce"]);

interface Source {
  /** Names the source in issues and the summary. */
  label: string;
  read: () => Promise<string[]>;
}

/** The module names on the help page: the link text `N/<name> Module` (plural `Modules` heads a namespace). */
function parseHelpPage(html: string): string[] {
  const text = html.replaceAll("<wbr>", "");
  return [...text.matchAll(/<a\b[^>]*>\s*(N\/[\w/]+) Module\s*<\/a>/g)].map(
    (m) => m[1] as string,
  );
}

/** The module names the stubs declare with `@module N/<name>`, across every `.js` file under `stubs/`. */
function parseStubs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".js")) {
        for (const m of readFileSync(path, "utf8").matchAll(
          /@module\s+(N\/[\w/]+)/g,
        )) {
          found.push(m[1] as string);
        }
      }
    }
  };
  walk(join(root, "stubs"));
  return found;
}

/** The modules `N.d.ts` imports from `./N/...`, commented-out imports included (the types skip those on purpose). */
function parseTypes(root: string): string[] {
  const text = readFileSync(join(root, "N.d.ts"), "utf8");
  return [...text.matchAll(/from\s+['"]\.\/(N\/[\w/]+)['"]/g)].map(
    (m) => m[1] as string,
  );
}

/** Downloads the latest version of an npm package into a new temporary folder and returns its `package` folder. */
function fetchPackage(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "track-modules-"));
  const out = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", `${name}@latest`, "--silent", "--pack-destination", dir],
    { cwd: dir, encoding: "utf8" },
  );
  const tarball = out.trim().split("\n").pop() as string;
  execFileSync("tar", ["-xzf", tarball], { cwd: dir });
  return join(dir, "package");
}

function nonEmpty(names: string[], what: string): string[] {
  if (names.length === 0) throw new Error(`${what} named no modules`);
  return names;
}

const { values } = parseArgs({
  options: {
    "help-page": { type: "string" },
    "open-issues": { default: false, type: "boolean" },
    types: { type: "string" },
    "unit-testing": { type: "string" },
  },
});

const sources: Source[] = [
  {
    label: "Oracle's SuiteScript 2.x Modules help page",
    read: async () => {
      let html: string;
      if (values["help-page"]) html = readFileSync(values["help-page"], "utf8");
      else {
        const response = await fetch(helpPageUrl, {
          headers: { "user-agent": "suitescript-verify-module-tracking" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        html = await response.text();
      }
      return nonEmpty(parseHelpPage(html), "the page");
    },
  },
  {
    label: "@oracle/suitecloud-unit-testing",
    read: async () =>
      nonEmpty(
        parseStubs(
          values["unit-testing"] ??
            fetchPackage("@oracle/suitecloud-unit-testing"),
        ),
        "the package",
      ),
  },
  {
    label: "@hitc/netsuite-types",
    read: async () =>
      nonEmpty(
        parseTypes(values.types ?? fetchPackage("@hitc/netsuite-types")),
        "the package",
      ),
  },
];

const modules = new Map<string, string[]>();
const unreadable: { label: string; reason: string }[] = [];
for (const source of sources) {
  try {
    for (const name of await source.read()) {
      if (namespaces.has(name)) continue;
      const seen = modules.get(name) ?? [];
      if (!seen.includes(source.label)) seen.push(source.label);
      modules.set(name, seen);
    }
  } catch (error) {
    unreadable.push({
      label: source.label,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

const unclassified = [...modules]
  .filter(([name]) => !Object.hasOwn(moduleClasses, name))
  .sort(([a], [b]) => a.localeCompare(b));

interface Finding {
  title: string;
  body: string;
}
const findings: Finding[] = [
  ...unreadable.map(({ label, reason }) => ({
    body: `The module-tracking workflow could not read ${label} (${reason}). Modules it names may be going unnoticed. Check whether the source moved or changed shape, and fix \`scripts/track-modules.ts\`.`,
    title: `Module source unreadable: ${label}`,
  })),
  ...unclassified.map(([name, from]) => ({
    body: `The module-tracking workflow found \`${name}\` in ${from.join(", ")}, and \`moduleClasses\` in \`src/modules.ts\` does not list it. A module not listed counts as writing. Classify it as described in \`docs/maintaining.md\`.`,
    title: `Classify module ${name}`,
  })),
];

const lines = ["## Module tracking", ""];
if (unreadable.length > 0) {
  lines.push("### Unreadable source", "");
  for (const { label, reason } of unreadable)
    lines.push(`- ${label}: ${reason}`);
  lines.push("");
}
lines.push("### Unclassified modules", "");
if (unclassified.length === 0) lines.push("None.");
for (const [name, from] of unclassified)
  lines.push(`- \`${name}\` (${from.join(", ")})`);
lines.push("");
lines.push(
  values["open-issues"]
    ? "Opening an issue for each finding that has none open:"
    : "Pull-request mode, so no issues are opened. A scheduled run would open:",
);
for (const { title } of findings) lines.push(`- ${title}`);
const report = `${lines.join("\n")}\n`;
process.stdout.write(report);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);

if (values["open-issues"] && findings.length > 0) {
  const [gh, ...ghArgs] = JSON.parse(
    process.env.MODULE_TRACKING_GH ?? '["gh"]',
  ) as string[];
  const run = (args: string[]) =>
    execFileSync(gh as string, [...ghArgs, ...args], { encoding: "utf8" });
  const open = new Set(
    (
      JSON.parse(
        run([
          "issue",
          "list",
          "--state",
          "open",
          "--limit",
          "1000",
          "--json",
          "title",
        ]),
      ) as { title: string }[]
    ).map((issue) => issue.title),
  );
  for (const { title, body } of findings) {
    if (open.has(title)) continue;
    run([
      "issue",
      "create",
      "--title",
      title,
      "--body",
      body,
      "--label",
      "needs-triage",
    ]);
  }
}
