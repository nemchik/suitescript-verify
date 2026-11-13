import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { certificate } from "./certificate.ts";
import {
  type Config,
  loadConfig,
  resultsDirGuidance,
  resultsDirKey,
  suggestedResultsDir,
} from "./config.ts";
import { formatChecks, names, runChecks } from "./doctor.ts";
import { envNames } from "./envfile.ts";
import { init } from "./init.ts";
import { runProbe } from "./run.ts";
import { buildSdfProject } from "./sdf.ts";
import {
  confirmWrite,
  flagValue,
  positionals,
  requireSandbox,
  saveEnv,
  suitecloud,
  UsageError,
} from "./shared.ts";

export const USAGE = `Usage: suitescript-verify <command> [options]

Commands:
  init [--results-dir <path>]          Scaffold the folders and .env, and print a to-do list; the results folder is yours to choose (suggested: docs/verification/results)
  doctor                               Check the setup; each failing step says who does it
  certificate [--only runner|sdf] [--keys-dir <path>] [--overwrite | --keep]
                                       Generate the key pairs outside the project
  passkey [--overwrite | --keep]       Generate the SuiteCloud passkey into .env.local
  env set NAME=value [--overwrite | --keep]
                                       Save a setting in .env.local
  setup-ci                             Register the SDF credentials (account:setup:ci)
  deploy [--approved]                  Dry-run the runner deployment; --approved deploys, from your own terminal
  run <probe> [--param name=value ...] [--draft]              Run one RESTlet probe through the runner; --draft writes a results page
  cleanup [--approved]                 Turn the runner's deployment off (dry run without --approved)
  help                                 Show this help

Every command takes --dir <path> to move the verification folder (default verification).

Probes run in a NetSuite sandbox only. The package never accepts Oracle's SuiteCloud license:
install @oracle/suitecloud-cli in your project and accept the license yourself.`;

const dirFlag = (args: string[]) => flagValue(args, "--dir");

/** Loads the layered configuration; a problem stops every command except the reporting ones. */
function configure(args: string[], refuse: boolean): Config {
  const config = loadConfig(process.cwd(), dirFlag(args));
  if (refuse && config.problems.length > 0) {
    throw new UsageError(
      `Refusing to run:\n${config.problems.map((p) => `- ${p.message}`).join("\n")}`,
    );
  }
  return config;
}

/** Loads the configuration for `doctor` and `init`, which report problems instead of refusing. */
function reporting(args: string[]): Config {
  const config = configure(args, false);
  if (config.problems.length > 0) {
    console.log("Configuration problems:");
    for (const problem of config.problems) console.log(`- ${problem.message}`);
    console.log("");
  }
  return config;
}

function doctor(args: string[]): number {
  const config = reporting(args);
  const checks = runChecks(process.cwd(), config);
  console.log(formatChecks(checks));
  return config.problems.length === 0 && checks.every((c) => c.ok) ? 0 : 1;
}

/** The results folder `init` was told to use: the flag, or a prompt at a terminal when the key is not set. Never a silent default. */
async function chooseResultsDir(
  config: Config,
  args: string[],
): Promise<string | undefined> {
  const flagged = flagValue(args, "--results-dir");
  // Already configured: the flag is passed on only so `init` can say it was ignored.
  if (config.resultsDir !== undefined || flagged !== undefined) return flagged;
  if (!process.stdin.isTTY) {
    throw new UsageError(
      `${resultsDirKey} is not set. ${resultsDirGuidance} Nothing was created.`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `Where should results pages live in this project? [${suggestedResultsDir}] `,
  );
  rl.close();
  return answer.trim() || suggestedResultsDir;
}

async function initCommand(args: string[]): Promise<number> {
  const config = reporting(args);
  console.log(
    init(process.cwd(), config, await chooseResultsDir(config, args)),
  );
  return 0;
}

async function deploy(args: string[]): Promise<number> {
  const project = process.cwd();
  const config = configure(args, true);
  requireSandbox(config);
  const { files, slugs } = buildSdfProject(config.sdfDir, config.probesDir, {
    deployed: true,
    extraTags: config.extraTags,
    roleId: config.roleId,
  });
  console.log(`Probes in the runner: ${slugs.join(", ") || "(none)"}`);
  console.log(`Files to upload: ${files.join(", ")}`);
  const approved = args.includes("--approved");
  if (approved) await confirmWrite("DEPLOY", "This deploys to the sandbox");
  else {
    console.log(
      "\nDry run only. Deploying writes to the sandbox, so ask the user for approval, then rerun with --approved.",
    );
  }
  return suitecloud(project, config, [
    "project:deploy",
    ...(approved ? [] : ["--dryrun"]),
  ]);
}

async function cleanup(args: string[]): Promise<number> {
  const project = process.cwd();
  const config = configure(args, true);
  requireSandbox(config);
  const approved = args.includes("--approved");
  if (approved) {
    await confirmWrite("CLEANUP", "This turns the runner's deployment off");
  } else {
    console.log(
      "Dry run only. This turns the runner's deployment off in the sandbox, so ask the user for approval, then rerun with --approved.\nTo remove access entirely, the user revokes the certificate mapping (Setup > Integration > Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup).",
    );
  }
  buildSdfProject(config.sdfDir, config.probesDir, {
    deployed: false,
    extraTags: config.extraTags,
    roleId: config.roleId,
  });
  return suitecloud(project, config, [
    "project:deploy",
    ...(approved ? [] : ["--dryrun"]),
  ]);
}

const CI_SETTINGS = [
  "ACCOUNT",
  "CLIENT_ID",
  "CERTIFICATE_ID",
  "PRIVATE_KEY_PATH",
  "SDF_CERTIFICATE_ID",
  "SDF_PRIVATE_KEY_PATH",
  "PASSKEY",
].map((name) => `  SUITESCRIPT_VERIFY_${name}`);

const CI_NOTES = [
  "",
  "Registered the SDF credentials with the SuiteCloud CLI. To run probes from a pipeline, the pipeline supplies these settings as its own secrets and variables (names only; this command wrote none and holds no value):",
  ...CI_SETTINGS,
  "Accept Oracle's SuiteCloud license yourself in the pipeline; this package never does.",
].join("\n");

function setupCi(args: string[]): number {
  const config = configure(args, true);
  const creds = requireSandbox(config);
  const status = suitecloud(process.cwd(), config, [
    "account:setup:ci",
    "--account",
    creds.account,
    "--authid",
    "suitescript-verify",
    "--certificateid",
    creds.sdfCertificateId,
    "--privatekeypath",
    creds.sdfPrivateKeyPath,
    ...(config.values.SUITESCRIPT_VERIFY_DOMAIN
      ? ["--domain", config.values.SUITESCRIPT_VERIFY_DOMAIN]
      : []),
  ]);
  if (status === 0) console.log(CI_NOTES);
  return status;
}

async function envCommand(args: string[]): Promise<number> {
  const config = configure(args, true);
  const [action, assignment] = positionals(args);
  const match = /^([A-Z0-9_]+)=([\s\S]*)$/.exec(assignment ?? "");
  if (action !== "set" || !match) {
    throw new UsageError(
      "Usage: suitescript-verify env set NAME=value [--overwrite | --keep]",
    );
  }
  const name = match[1] ?? "";
  if (name === names.passkey) {
    throw new UsageError(
      "Generate the passkey with `suitescript-verify passkey`.",
    );
  }
  if (!(envNames as readonly string[]).includes(name)) {
    throw new UsageError(
      `Unknown variable ${name}. Known: ${envNames.join(", ")}`,
    );
  }
  await saveEnv(config, args, { [name]: match[2] ?? "" });
  return 0;
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === undefined || command === "help" || command === "--help") {
      console.log(USAGE);
      return 0;
    }
    if (command === "deploy") return await deploy(rest);
    if (command === "cleanup") return await cleanup(rest);
    if (command === "run") {
      const config = configure(rest, true);
      return await runProbe(process.cwd(), config, rest);
    }
    if (command === "certificate") {
      await certificate(process.cwd(), configure(rest, true), rest);
      return 0;
    }
    if (command === "passkey") {
      await saveEnv(configure(rest, true), rest, {
        [names.passkey]: randomBytes(30).toString("hex"),
      });
      return 0;
    }
    if (command === "env") return await envCommand(rest);
    if (command === "setup-ci") return setupCi(rest);
    if (command === "doctor") return doctor(rest);
    if (command === "init") return await initCommand(rest);
    throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}
