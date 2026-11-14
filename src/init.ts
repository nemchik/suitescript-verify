import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type Config, insideProject, resultsDirKey } from "./config.ts";
import { UsageError } from "./shared.ts";

/** A path relative to the project, with forward slashes, for messages and the committed `.env`. */
const shown = (project: string, path: string) =>
  relative(project, path).replaceAll("\\", "/");

/**
 * Which folder holds results: the one the configuration already sets, else the
 * one the project just chose. `ignoredNote` is non-empty when a choice was
 * given but the key was already set. Refuses a choice outside the project
 * before anything is created.
 */
function pickResultsDir(
  project: string,
  config: Config,
  chosenResultsDir: string | undefined,
): { dir: string; alreadySet: boolean; ignoredNote: string } {
  const chosen =
    chosenResultsDir === undefined
      ? undefined
      : resolve(project, chosenResultsDir);
  if (chosen !== undefined && !insideProject(project, chosen)) {
    throw new UsageError(
      `${resultsDirKey} must be a path inside the project, because the committed .env holds layout only. Nothing was created.`,
    );
  }
  if (config.resultsDir !== undefined) {
    const ignoredNote =
      chosen !== undefined && chosen !== config.resultsDir
        ? `${resultsDirKey} is already set to ${shown(project, config.resultsDir)}, so --results-dir ${shown(project, chosen)} was ignored. Change the key itself to move the results folder.\n\n`
        : "";
    return { alreadySet: true, dir: config.resultsDir, ignoredNote };
  }
  if (chosen === undefined) {
    throw new Error("init needs a results folder; the caller must choose one.");
  }
  return { alreadySet: false, dir: chosen, ignoredNote: "" };
}

/**
 * Writes the layout keys to the committed `.env`: a new file with all of them,
 * or, for an existing one, only the results key when it is missing. Returns
 * whether the file was created.
 */
function writeLayoutEnv(
  project: string,
  config: Config,
  resultsDir: { dir: string; alreadySet: boolean },
): boolean {
  const envFile = join(config.root, ".env");
  const results = `${resultsDirKey}=${shown(project, resultsDir.dir)}`;
  if (!existsSync(envFile)) {
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(
      envFile,
      [
        "# Layout only: this file is committed. Credentials go in .env.local, which is gitignored.",
        `SUITESCRIPT_VERIFY_PROBES_DIR=${shown(project, config.probesDir)}`,
        results,
        `SUITESCRIPT_VERIFY_SDF_DIR=${shown(project, config.sdfDir)}`,
        "",
      ].join("\n"),
    );
    return true;
  }
  if (!resultsDir.alreadySet) {
    const text = readFileSync(envFile, "utf8");
    const lead = text === "" || text.endsWith("\n") ? "" : "\n";
    appendFileSync(envFile, `${lead}${results}\n`);
  }
  return false;
}

/**
 * Scaffolds the folders and a committed `.env` of layout keys, then returns
 * the to-do list for the person. Creates no credential and installs nothing.
 * `chosenResultsDir` is the project's own choice for the results folder; it is
 * used only when the configuration does not already set one.
 */
export function init(
  project: string,
  config: Config,
  chosenResultsDir?: string,
): string {
  const results = pickResultsDir(project, config, chosenResultsDir);
  const dirs = [config.probesDir, results.dir, config.sdfDir];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const created = writeLayoutEnv(project, config, results);
  const envFile = shown(project, join(config.root, ".env"));
  const local = shown(project, join(config.root, ".env.local"));
  return [
    `${results.ignoredNote}${created ? "Created" : "Kept"} ${envFile} and the folders ${dirs.map((dir) => shown(project, dir)).join(", ")}. No credentials were created.`,
    "",
    "To do (each step is yours, the maintainer's):",
    "1. Install the SuiteCloud CLI: npm install --save-dev @oracle/suitecloud-cli. Read Oracle's license and accept it yourself; this package never does.",
    `2. Add ${local} to .gitignore before saving any value: it holds credentials.`,
    "3. In a sandbox, create the integration record, the role and the certificate mappings, and generate the private keys outside the repository.",
    `4. Save the account, client id, certificate ids, key paths and a passkey in ${local}. Setup is described in the installed package README: node_modules/suitescript-verify/README.md`,
    "5. Run suitescript-verify doctor until every step passes.",
  ].join("\n");
}
