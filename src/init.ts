import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Config } from "./config.ts";

/**
 * Scaffolds the folders and a committed `.env` of layout keys, then returns
 * the to-do list for the person. Creates no credential and installs nothing.
 */
export function init(project: string, config: Config): string {
  const rel = (path: string) => relative(project, path).replaceAll("\\", "/");
  const dirs = [config.probesDir, config.resultsDir, config.sdfDir];
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
        `SUITESCRIPT_VERIFY_RESULTS_DIR=${rel(config.resultsDir)}`,
        `SUITESCRIPT_VERIFY_SDF_DIR=${rel(config.sdfDir)}`,
        "",
      ].join("\n"),
    );
  }
  const local = rel(join(config.root, ".env.local"));
  return [
    `${created ? "Created" : "Kept"} ${rel(envFile)} and the folders ${dirs.map(rel).join(", ")}. No credentials were created.`,
    "",
    "To do (each step is yours, the maintainer's):",
    "1. Install the SuiteCloud CLI: npm install --save-dev @oracle/suitecloud-cli. Read Oracle's license and accept it yourself; this package never does.",
    `2. Add ${local} to .gitignore before saving any value: it holds credentials.`,
    "3. In a sandbox, create the integration record, the role and the certificate mappings, and generate the private keys outside the repository.",
    `4. Save the account, client id, certificate ids, key paths and a passkey in ${local} (see docs/verification/README.md).`,
    "5. Run suitescript-verify doctor until every step passes.",
  ].join("\n");
}
