import { spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  insideProject,
  resultsDirGuidance,
  resultsDirKey,
} from "./config.ts";

/** Who does the next step. The maintainer's own steps are never an agent's. */
export type Owner = "maintainer" | "agent";

export interface Check {
  name: string;
  ok: boolean;
  next?: string;
  owner?: Owner;
}

export const names = {
  account: "SUITESCRIPT_VERIFY_ACCOUNT",
  certificateId: "SUITESCRIPT_VERIFY_CERTIFICATE_ID",
  clientId: "SUITESCRIPT_VERIFY_CLIENT_ID",
  passkey: "SUITESCRIPT_VERIFY_PASSKEY",
  privateKeyPath: "SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH",
  sdfCertificateId: "SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID",
  sdfPrivateKeyPath: "SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH",
} as const;

/**
 * The Java versions Oracle's SDK runs on: the SuiteCloud CLI's own
 * `SDK_COMPATIBLE_JAVA_VERSIONS`, which refuses to run on any other.
 */
const javaVersions = ["17", "21"];

/** The installed Java's version, read the way the SuiteCloud CLI reads it (`java -version`, no shell); empty when there is none. */
function installedJavaVersion(): string {
  const result = spawnSync("java", ["-version"], {
    encoding: "utf8",
    shell: false,
  });
  const match = /(?:\bjava version\b|\bopenjdk version\b) "([\d.]+)"/.exec(
    result.stderr ?? "",
  );
  return match?.[1] ?? "";
}

/** The SDK jar the installed SuiteCloud CLI downloads, from its package.json; empty when unknown. */
function sdkFilename(project: string): string {
  try {
    const manifest = JSON.parse(
      readFileSync(
        join(
          project,
          "node_modules",
          "@oracle",
          "suitecloud-cli",
          "package.json",
        ),
        "utf8",
      ),
    ) as { sdkFilename?: string };
    return manifest.sdkFilename ?? "";
  } catch {
    return "";
  }
}

/** `ec:<curve>`, `rsa:<bits>` or `other`, from a private key file. Never the key itself. */
function keyType(path: string): string {
  try {
    const key = createPrivateKey(readFileSync(path));
    const details = key.asymmetricKeyDetails;
    if (key.asymmetricKeyType === "ec") return `ec:${details?.namedCurve}`;
    if (key.asymmetricKeyType === "rsa") return `rsa:${details?.modulusLength}`;
  } catch {
    // Unreadable or not a private key.
  }
  return "other";
}

/** A sandbox account id looks like `1234567_SB1`. Verification never runs in production. */
export const isSandboxAccount = (account: string) =>
  /^\d{5,8}_SB\d+$/i.test(account);

/** Read-only checklist: each failing step says what to do next and who does it. */
export function runChecks(
  project: string,
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, owner: Owner, next: string) =>
    checks.push({ name, next, ok, owner });
  const v = config.values;

  add(
    "SuiteCloud CLI (@oracle/suitecloud-cli) is installed in the project",
    existsSync(
      join(
        project,
        "node_modules",
        "@oracle",
        "suitecloud-cli",
        "src",
        "suitecloud.js",
      ),
    ),
    "maintainer",
    "Run npm install --save-dev @oracle/suitecloud-cli, read Oracle's license and accept it yourself. This package never accepts it.",
  );

  const javaVersion = installedJavaVersion();
  add(
    `Java ${javaVersions.join(" or ")} is on the PATH`,
    javaVersions.some((version) => javaVersion.startsWith(version)),
    "maintainer",
    `Install Java ${javaVersions.join(" or ")} and make sure \`java -version\` works: the SuiteCloud SDK runs on no other version.`,
  );

  const sdkRoot = join(homedir(), ".suitecloud-sdk");
  const jarName = sdkFilename(project);
  add(
    "The SuiteCloud SDK jar is downloaded",
    jarName !== "" && existsSync(join(sdkRoot, "cli", jarName)),
    "maintainer",
    "Run the SuiteCloud CLI's postinstall script in your project (node node_modules/@oracle/suitecloud-cli/postinstall.js) and read and accept Oracle's license yourself when it asks. This package never accepts it. A headless machine needs a desktop install, or the maintainer to accept the license first.",
  );

  add(
    "SuiteCloud login is set up (browser-based once, or CI)",
    ["credentials_browser_based.p12", "credentials_ci.p12"].some((file) =>
      existsSync(join(sdkRoot, file)),
    ),
    "maintainer",
    "With SUITECLOUD_CI_PASSKEY unset, run the project's SuiteCloud CLI account:setup from the SDF folder, log in to the sandbox and choose a role. This one-time browser login installs Oracle's SuiteCloud Development Integration in the account.",
  );

  const missing = [
    names.account,
    names.clientId,
    names.certificateId,
    names.sdfCertificateId,
  ].filter((name) => !v[name]);
  add(
    "Account, client id and both certificate ids are set",
    missing.length === 0,
    "maintainer",
    `Missing: ${missing.join(", ")}. Create the integration record and mapping in your sandbox, then save the values in .env.local (never the committed .env).`,
  );

  add(
    "The account is a sandbox",
    isSandboxAccount(v[names.account] ?? ""),
    "maintainer",
    `${names.account} must look like digits_SBn. Verification never runs in production.`,
  );

  for (const [label, key, expected, accepts] of [
    [
      "runner",
      names.privateKeyPath,
      "an EC P-256 key",
      (t: string) => t === "ec:prime256v1",
    ],
    [
      "SDF",
      names.sdfPrivateKeyPath,
      "an RSA key of 3072 or 4096 bits",
      (t: string) => t === "rsa:3072" || t === "rsa:4096",
    ],
  ] as const) {
    const path = v[key] ?? "";
    const exists = path !== "" && existsSync(path);
    add(
      `The ${label} private key exists (${key})`,
      exists,
      "maintainer",
      `Generate the key pair outside the repository and set ${key} in .env.local.`,
    );
    if (exists) {
      add(
        `The ${label} private key is ${expected}`,
        accepts(keyType(path)),
        "maintainer",
        "Generate a key of that type and upload its new public certificate in a new mapping.",
      );
    }
  }

  const passkey = v[names.passkey] ?? env.SUITECLOUD_CI_PASSKEY ?? "";
  add(
    `${names.passkey} (or SUITECLOUD_CI_PASSKEY) is set, 32 to 100 letters and digits`,
    /^[A-Za-z0-9]{32,100}$/.test(passkey),
    "maintainer",
    `Generate a random passkey and save it as ${names.passkey} in .env.local. Keep a copy somewhere safe: it encrypts the stored credentials. Never set it user-wide.`,
  );
  add(
    "SUITECLOUD_FALLBACK_PASSKEY is not set",
    !env.SUITECLOUD_FALLBACK_PASSKEY,
    "maintainer",
    "Unset it: the CLI refuses to run with both passkeys.",
  );

  const projectJson = join(config.sdfDir, "project.json");
  let authId = "";
  if (existsSync(projectJson)) {
    try {
      authId =
        (
          JSON.parse(readFileSync(projectJson, "utf8")) as {
            defaultAuthId?: string;
          }
        ).defaultAuthId ?? "";
    } catch {
      // A malformed project.json fails the step.
    }
  }
  add(
    `The results folder is set, inside the project (${resultsDirKey})`,
    config.resultsDir !== undefined &&
      insideProject(project, config.resultsDir),
    "maintainer",
    resultsDirGuidance,
  );

  const absent = [config.probesDir, config.resultsDir, config.sdfDir].filter(
    (dir): dir is string => dir !== undefined && !existsSync(dir),
  );
  add(
    "Project files: the probe, results and SDF folders exist and the SDF project has a default auth id",
    absent.length === 0 && authId !== "",
    absent.length > 0 ? "agent" : "maintainer",
    absent.length > 0
      ? "Run suitescript-verify init to create the missing folders."
      : "Run account:setup:ci from the SDF folder once the steps above pass, so project.json gets a default auth id.",
  );

  add(`Runner role id: ${config.roleId}`, true, "agent", "");
  add(`Runner id: ${config.runnerId}`, true, "agent", "");

  return checks;
}

export function formatChecks(checks: Check[]): string {
  const lines = checks.map((c) =>
    c.ok
      ? `ok   ${c.name}`
      : `FAIL ${c.name}\n     ${c.owner === "maintainer" ? "Maintainer's own step" : "Agent can do this"}: ${c.next ?? ""}`,
  );
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) lines.push("\nAll checks passed.");
  else {
    const own = failed.filter((c) => c.owner === "maintainer").length;
    lines.push(
      `\n${failed.length} check(s) failed.${own > 0 ? ` ${own} are the Maintainer's own: relay each next step to the maintainer and wait. Never accept the license, create credentials or touch an account for them.` : ""}`,
    );
  }
  return lines.join("\n");
}
