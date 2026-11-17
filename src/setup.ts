import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { certificate } from "./certificate.ts";
import type { Config } from "./config.ts";
import {
  type Check,
  formatChecks,
  isSandboxAccount,
  names,
  runChecks,
} from "./doctor.ts";
import { selfCheckStep } from "./selfcheck.ts";
import { ask, askHidden, flagValue, saveEnv, UsageError } from "./shared.ts";

/** What `setup` composes from the other commands, which live in the CLI. */
export interface SetupCommands {
  /** Loads the configuration again, refusing on a problem: each step can change it. */
  configure(): Config;
  /** The real deploy, already confirmed by the person. */
  deploy(config: Config): number;
  setupCi(): number;
  doctor(): Promise<number>;
}

const steps = [
  "SuiteCloud CLI and Java",
  "Certificate pairs",
  "Sandbox checklist",
  "Account, client id and certificate ids",
  "Passkey",
  "Register the SDF login (setup-ci)",
  "First deploy",
  "doctor",
] as const;

const heading = (index: number) =>
  `\nStep ${index + 1} of ${steps.length}: ${steps[index]}`;
const skipped = (index: number) =>
  console.log(`${heading(index)}: already passes, skipped.`);

const closed = () =>
  new UsageError(
    "The terminal closed, so setup stopped. Run suitescript-verify setup again to pick up where you stopped.",
  );

/** The public certificate beside a private key `certificate` generated. */
const publicCertificate = (privateKey: string | undefined) =>
  privateKey && /-private\.pem$/.test(privateKey)
    ? privateKey.replace(/-private\.pem$/, "-public.pem")
    : `the public certificate made with ${privateKey ?? "its private key"}`;

function checklist(config: Config): string {
  const v = config.values;
  return [
    "In the sandbox, in one visit (Setup > Integration):",
    "  1. Create an integration record. Enable the Client Credentials (Machine to Machine) grant, the token-based authentication flags, and the RESTlets and REST Web Services scopes. Keep its client id for the next step; it is shown once.",
    `  2. Create the runner's role with only its name and id, and assign it to yourself: name "ssv runner role ${config.runnerId}", id ${config.roleId}. Leave its permissions empty: the first deploy writes them.`,
    "  3. Map the certificates (Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup), each to that integration record:",
    `     runner certificate ${publicCertificate(v[names.privateKeyPath])} -> the role ${config.roleId}`,
    `     SDF certificate ${publicCertificate(v[names.sdfPrivateKeyPath])} -> a role that can deploy (Administrator in a sandbox), never the runner's role`,
    "     Keep each mapping's certificate id for the next step.",
    `  4. Once, log in to the sandbox in a browser through the SuiteCloud CLI: with SUITECLOUD_CI_PASSKEY unset, run npx suitecloud account:setup from ${config.sdfDir} and choose a role. This installs Oracle's SuiteCloud Development Integration in the account.`,
  ].join("\n");
}

/**
 * Asks for each value without echoing it. An existing value is kept when the
 * person just presses Enter. Returns only the values the person typed.
 */
async function promptIds(config: Config): Promise<Record<string, string>> {
  const typed: Record<string, string> = {};
  for (const [name, label] of [
    [names.account, "Sandbox account id (digits_SBn)"],
    [names.clientId, "Integration record client id"],
    [names.certificateId, "Runner certificate id"],
    [names.sdfCertificateId, "SDF certificate id"],
  ] as const) {
    const existing = config.values[name] ?? "";
    for (;;) {
      const answer = await askHidden(
        existing
          ? `${label} (${name} is set; press Enter to keep it, or type a new value, hidden): `
          : `${label} (${name}, hidden): `,
      );
      if (answer === null) throw closed();
      const value = answer.trim();
      if (value === "" && existing) {
        console.log(`Kept the existing ${name}.`);
        break;
      }
      if (value === "") {
        console.log(`${name} is needed.`);
        continue;
      }
      if (name === names.account && !isSandboxAccount(value)) {
        console.log(
          "That is not a sandbox account id (digits_SBn). Verification runs in a sandbox only.",
        );
        continue;
      }
      typed[name] = value;
      break;
    }
  }
  return typed;
}

/**
 * Walks a person at a terminal through the whole setup in order. Each step
 * `doctor` already passes is skipped, so a rerun resumes. Installing the CLI
 * and accepting Oracle's license stay the person's: a failing CLI or Java
 * check stops setup with the fix. No prompted value is printed; values are
 * written to `.env.local` only.
 */
export async function setup(
  project: string,
  args: string[],
  commands: SetupCommands,
): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      "setup needs the user at a terminal: it asks for credentials and a typed confirmation. Ask the user to run suitescript-verify setup in their own terminal.",
    );
  }
  let config = commands.configure();
  if (
    config.resultsDir === undefined ||
    ![config.probesDir, config.resultsDir, config.sdfDir].every(existsSync)
  ) {
    throw new UsageError(
      "Run suitescript-verify init first: setup needs the folders it creates.",
    );
  }
  const checks = () => runChecks(project, config);
  /** Whether every check with each id is present and passes. */
  const passes = (list: Check[], ...ids: string[]) =>
    ids.every((id) => {
      const matching = list.filter((c) => c.id === id);
      return matching.length > 0 && matching.every((c) => c.ok);
    });

  // 1. The CLI and Java are the person's to install; stop with the fix.
  const tools = checks().filter((c) => c.id === "cli" || c.id === "java");
  if (tools.every((c) => c.ok)) skipped(0);
  else {
    console.log(`${heading(0)}:`);
    console.log(formatChecks(tools.filter((c) => !c.ok)));
    console.log(
      "Fix these yourself, then run suitescript-verify setup again. This package never installs the CLI or accepts Oracle's license.",
    );
    return 1;
  }

  // 2. Certificate pairs, only the missing ones.
  const keys = checks();
  const runnerOk = passes(keys, "runner-key");
  const sdfOk = passes(keys, "SDF-key");
  if (runnerOk && sdfOk) skipped(1);
  else {
    console.log(`${heading(1)}:`);
    const keysDir = flagValue(args, "--keys-dir");
    await certificate(project, config, [
      ...(runnerOk ? ["--only", "sdf"] : sdfOk ? ["--only", "runner"] : []),
      ...(keysDir === undefined ? [] : ["--keys-dir", keysDir]),
    ]);
    config = commands.configure();
  }

  // 3. The one sandbox trip.
  if (passes(checks(), "ids", "sandbox", "login")) skipped(2);
  else {
    console.log(`${heading(2)}:`);
    console.log(checklist(config));
    if (
      (await ask("\nPress Enter when the sandbox steps are done. ")) === null
    ) {
      throw closed();
    }
  }

  // 4. The values from the sandbox, never echoed.
  if (passes(checks(), "ids", "sandbox")) skipped(3);
  else {
    console.log(`${heading(3)}:`);
    const typed = await promptIds(config);
    if (Object.keys(typed).length > 0) {
      await saveEnv(config, ["--overwrite"], typed);
    }
    config = commands.configure();
  }

  // 5. The passkey.
  if (passes(checks(), "passkey")) skipped(4);
  else {
    console.log(`${heading(4)}:`);
    await saveEnv(config, [], {
      [names.passkey]: randomBytes(30).toString("hex"),
    });
    config = commands.configure();
  }

  // 6. Register the SDF login.
  if (passes(checks(), "files", "login")) skipped(5);
  else {
    console.log(`${heading(5)}:`);
    const status = commands.setupCi();
    if (status !== 0) {
      console.log(
        "\nsetup-ci failed; see Troubleshooting in the README, then run suitescript-verify setup again.",
      );
      return status;
    }
  }

  // 7. The first deploy is the person's, behind the typed DEPLOY.
  if ((await selfCheckStep(config)).ok) skipped(6);
  else {
    console.log(`${heading(6)}:`);
    const answer = await ask(
      "\nThis deploys to the sandbox and takes over the runner's role. Type DEPLOY to deploy now, or press Enter to skip: ",
    );
    if (answer === null) throw closed();
    if (answer.trim() === "DEPLOY") {
      const status = commands.deploy(config);
      if (status !== 0) {
        console.log(
          "\nThe deploy failed; fix it, then run suitescript-verify setup again.",
        );
        return status;
      }
    } else {
      console.log(
        "Skipped the deploy. Deploy later with suitescript-verify deploy --approved from your own terminal.",
      );
    }
  }

  // 8. doctor, with the self-check.
  console.log(`${heading(7)}:`);
  return commands.doctor();
}
