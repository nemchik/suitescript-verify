import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const prefix = "SUITESCRIPT_VERIFY_";

/** Layout keys: the only ones the committed `.env` may hold. Each is a path in the project. */
export const layoutKeys = [
  "SUITESCRIPT_VERIFY_PROBES_DIR",
  "SUITESCRIPT_VERIFY_RESULTS_DIR",
  "SUITESCRIPT_VERIFY_SDF_DIR",
] as const;

export const resultsDirKey = "SUITESCRIPT_VERIFY_RESULTS_DIR";
/** What `init` suggests for the results folder; it is never applied without the project's say-so. */
export const suggestedResultsDir = "docs/verification/results";

/** What every command says when the results folder is not chosen: one sentence, so the commands cannot drift apart. */
export const resultsDirGuidance = `Choose where results pages live in your project, then run suitescript-verify init --results-dir <path> (${suggestedResultsDir} is the suggested value) or set ${resultsDirKey} in the committed .env.`;

/** The committed `.env` may also register extra probe tags: a comma-separated list of tag names, not a path. */
export const extraTagsKey = "SUITESCRIPT_VERIFY_EXTRA_TAGS";

/** The committed `.env` may also name the runner role: a NetSuite custom role id. */
export const roleIdKey = "SUITESCRIPT_VERIFY_ROLE_ID";
export const defaultRoleId = "customrole_suitescript_verify";
const roleIdPattern = /^customrole_[a-z0-9_]+$/;

const tagName = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The tag names in a registration value, without the `@`; blank entries are dropped. */
export const parseTagList = (value: string) =>
  value
    .split(",")
    .map((name) => name.trim().replace(/^@/, ""))
    .filter((name) => name !== "");

/** One thing wrong with the configuration. The message names a key or file and never holds a value. */
export interface Problem {
  message: string;
}

export interface Config {
  /** The folder holding `.env` and `.env.local` (default `verification`, moved with `--dir`). */
  root: string;
  probesDir: string;
  /** Where results pages go, from SUITESCRIPT_VERIFY_RESULTS_DIR. No default: the project chooses. */
  resultsDir: string | undefined;
  sdfDir: string;
  /** The runner's role id, from SUITESCRIPT_VERIFY_ROLE_ID (default `customrole_suitescript_verify`). */
  roleId: string;
  /** Probe tags registered beyond the package's own, from SUITESCRIPT_VERIFY_EXTRA_TAGS. */
  extraTags: string[];
  /** Every SUITESCRIPT_VERIFY_ value after layering, for the commands that need one. */
  values: Record<string, string>;
  problems: Problem[];
}

const unquote = (raw: string) => {
  const value = raw.trim();
  const quote = value[0];
  if (
    value.length >= 2 &&
    (quote === '"' || quote === "'") &&
    value.endsWith(quote)
  ) {
    return value.slice(1, -1);
  }
  return value;
};

/** Reads `NAME=value` lines; comments and other lines are ignored. */
export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(
      line,
    );
    if (match) values.set(match[1] ?? "", unquote(match[2] ?? ""));
  }
  return values;
}

function readEnvFile(path: string): Map<string, string> {
  return existsSync(path)
    ? parseEnv(readFileSync(path, "utf8"))
    : new Map<string, string>();
}

export const insideProject = (project: string, path: string) => {
  const rel = relative(project, resolve(project, path));
  return !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..";
};

/** A value a person would not write as a folder: a PEM block, a JWT or a long token. */
const looksSecret = (value: string) =>
  /-----BEGIN /.test(value) ||
  /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value) ||
  /^[A-Za-z0-9+_=-]{32,}$/.test(value);

const roleIdProblem = (file: string) => ({
  message: `${roleIdKey} in ${file} is not a NetSuite custom role id like customrole_suitescript_verify (lowercase letters, digits and underscores after customrole_).`,
});

/** Checks the committed `.env` against the allowlist. Messages name the key, never the value. */
function checkCommitted(
  project: string,
  committed: Map<string, string>,
  file: string,
): Problem[] {
  const problems: Problem[] = [];
  for (const [key, value] of committed) {
    if (key === roleIdKey) {
      // The pattern is the whole check: a valid id may be long enough to look like a token.
      if (!roleIdPattern.test(value)) problems.push(roleIdProblem(file));
    } else if (key === extraTagsKey) {
      if (!parseTagList(value).every((name) => tagName.test(name))) {
        problems.push({
          message: `${key} in ${file} is not a comma-separated list of tag names like flavor,other.`,
        });
      } else if (looksSecret(value)) {
        problems.push({
          message: `${key} in ${file} looks like a secret, not a list of tag names. The committed file is public: move a secret to .env.local.`,
        });
      }
    } else if (!(layoutKeys as readonly string[]).includes(key)) {
      problems.push({
        message: `${key} in ${file} is not a layout key. The committed file holds layout only (${[...layoutKeys, extraTagsKey, roleIdKey].join(", ")}); put anything else in .env.local or the process environment.`,
      });
    } else if (!insideProject(project, value)) {
      problems.push({
        message: `${key} in ${file} points outside the project. Use a path inside the project.`,
      });
    } else if (looksSecret(value)) {
      problems.push({
        message: `${key} in ${file} looks like a secret, not a path. The committed file is public: move a secret to .env.local.`,
      });
    }
  }
  return problems;
}

/** `.env.local` holds credentials: it must be gitignored and never tracked. */
function checkLocalIgnored(project: string, localFile: string): Problem[] {
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: project, encoding: "utf8" });
  const rel = relative(project, localFile).replaceAll("\\", "/");
  if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) return [];
  const problems: Problem[] = [];
  if (git(["ls-files", "--error-unmatch", "--", rel]).status === 0) {
    problems.push({
      message: `${rel} is tracked by git, so its credentials are in the repository. Run git rm --cached ${rel} and rotate what it held.`,
    });
  }
  if (git(["check-ignore", "-q", "--", rel]).status !== 0) {
    problems.push({
      message: `${rel} is not gitignored. Add it to .gitignore before saving any value: it holds credentials.`,
    });
  }
  return problems;
}

/**
 * Layers defaults, the committed `.env`, the gitignored `.env.local` and the
 * process environment (later wins). The root of the env files is `dir`
 * (default `verification`), relative to the project.
 */
export function loadConfig(
  project: string,
  dir: string | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): Config {
  const root = resolve(project, dir ?? "verification");
  const envFile = join(root, ".env");
  const localFile = join(root, ".env.local");
  const committed = readEnvFile(envFile);
  const values: Record<string, string> = {};
  const layers: Iterable<[string, string | undefined]>[] = [
    committed,
    readEnvFile(localFile),
    Object.entries(processEnv),
  ];
  for (const layer of layers) {
    for (const [key, value] of layer) {
      if (key.startsWith(prefix) && value !== undefined) values[key] = value;
    }
  }
  const path = (key: string, fallback: string) =>
    resolve(project, values[key] || fallback);
  const roleId = values[roleIdKey] || defaultRoleId;
  // The committed file reports its own bad value; this covers .env.local and the environment.
  const committedRole = committed.get(roleIdKey);
  const roleProblems =
    roleIdPattern.test(roleId) ||
    (committedRole !== undefined && !roleIdPattern.test(committedRole))
      ? []
      : [roleIdProblem(".env.local or the environment")];
  const shown = relative(project, envFile).replaceAll("\\", "/");
  return {
    extraTags: parseTagList(values[extraTagsKey] ?? ""),
    probesDir: path("SUITESCRIPT_VERIFY_PROBES_DIR", join(root, "probes")),
    problems: [
      ...checkCommitted(project, committed, shown),
      ...checkLocalIgnored(project, localFile),
      ...roleProblems,
    ],
    resultsDir: values[resultsDirKey]
      ? resolve(project, values[resultsDirKey])
      : undefined,
    roleId,
    root,
    sdfDir: path("SUITESCRIPT_VERIFY_SDF_DIR", join(root, "sdf")),
    values,
  };
}
