import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type Config, resultsDirKey } from "./config.ts";

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
  const rel = (path: string) => relative(project, path).replaceAll("\\", "/");
  const resultsDir =
    config.resultsDir ??
    (chosenResultsDir === undefined
      ? undefined
      : resolve(project, chosenResultsDir));
  if (resultsDir === undefined) {
    throw new Error("init needs a results folder; the caller must choose one.");
  }
  const dirs = [config.probesDir, resultsDir, config.sdfDir];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const envFile = join(config.root, ".env");
  const created = !existsSync(envFile);
  if (created) {
    mkdirSync(dirname(envFile), { recursive: true });
    writeFileSync(
      envFile,
      [
        "# Layout only: this file is committed. Credentials go in .env.local, which is gitignored.",
        `SUITESCRIPT_VERIFY_PROBES_DIR=${rel(config.probesDir)}`,
        `${resultsDirKey}=${rel(resultsDir)}`,
        `SUITESCRIPT_VERIFY_SDF_DIR=${rel(config.sdfDir)}`,
        "",
      ].join("\n"),
    );
  } else if (config.resultsDir === undefined) {
    appendFileSync(envFile, `${resultsDirKey}=${rel(resultsDir)}\n`);
  }
  const local = rel(join(config.root, ".env.local"));
  return [
    `${created ? "Created" : "Kept"} ${rel(envFile)} and the folders ${dirs.map(rel).join(", ")}. No credentials were created.`,
    "",
    "To do (each step is yours, the maintainer's):",
    "1. Install the SuiteCloud CLI: npm install --save-dev @oracle/suitecloud-cli. Read Oracle's license and accept it yourself; this package never does.",
    `2. Add ${local} to .gitignore before saving any value: it holds credentials.`,
    "3. In a sandbox, create the integration record, the role and the certificate mappings, and generate the private keys outside the repository.",
    `4. Save the account, client id, certificate ids, key paths and a passkey in ${local}. Setup is described in the package README: https://github.com/nemchik/suitescript-verify#readme`,
    "5. Run suitescript-verify doctor until every step passes.",
  ].join("\n");
}
