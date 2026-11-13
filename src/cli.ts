import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Config, loadConfig } from "./config.ts";

export const USAGE = `Usage: suitescript-verify <command> [options]

Commands:
  deploy [--approved] [--dir <path>]   Dry-run the runner deployment; --approved deploys, from your own terminal
  doctor [--dir <path>]                Report what is wrong with the setup
  init [--dir <path>]                  Report the configuration to fix before the first run
  help                                 Show this help

Probes run in a NetSuite sandbox only. The package never accepts Oracle's SuiteCloud license:
install @oracle/suitecloud-cli in your project and accept the license yourself.`;

class UsageError extends Error {}

/** The project's own SuiteCloud CLI (a peer dependency), never a global one. */
function suitecloudEntry(project: string): string {
  const entry = join(
    project,
    "node_modules",
    "@oracle",
    "suitecloud-cli",
    "src",
    "suitecloud.js",
  );
  if (!existsSync(entry)) {
    throw new UsageError(
      "Install @oracle/suitecloud-cli in this project (npm install --save-dev @oracle/suitecloud-cli), and accept Oracle's license yourself.",
    );
  }
  return entry;
}

/** Runs the project's SuiteCloud CLI from the SDF project folder. */
function suitecloud(
  project: string,
  sdfDir: string,
  args: string[],
  layered: Record<string, string>,
): number {
  const env: NodeJS.ProcessEnv = { ...process.env, ...layered };
  // Hand the passkey to the CLI for this child process only.
  if (env.SUITESCRIPT_VERIFY_PASSKEY) {
    env.SUITECLOUD_CI_PASSKEY = env.SUITESCRIPT_VERIFY_PASSKEY;
  }
  if (env.SUITECLOUD_CI_PASSKEY) env.SUITECLOUD_CI = "1";
  const result = spawnSync(
    process.execPath,
    [suitecloudEntry(project), ...args],
    { cwd: sdfDir, env, stdio: "inherit" },
  );
  return result.status ?? 1;
}

/**
 * A write to the sandbox needs a person at a terminal, on top of --approved:
 * an agent's shell has none, so an agent cannot run it. The person types the
 * action name to confirm.
 */
async function confirmWrite(action: string, what: string) {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      `${what} needs the user at a terminal. Ask the user to run this same command, with --approved, in their own terminal.`,
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${what}. Type ${action} to continue: `);
  rl.close();
  if (answer.trim() !== action) {
    throw new UsageError("Not confirmed. Nothing was changed.");
  }
}

/** The value after `--dir`, when given. */
function dirFlag(args: string[]): string | undefined {
  const flag = args.indexOf("--dir");
  if (flag < 0) return undefined;
  const value = args[flag + 1];
  if (!value) throw new UsageError("--dir needs a path.");
  return value;
}

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

/** Prints the configuration problems for `doctor` and `init`, which report instead of refusing. */
function report(args: string[]): number {
  const { problems } = configure(args, false);
  if (problems.length === 0) console.log("Configuration: no problems found.");
  else {
    console.log("Configuration problems:");
    for (const problem of problems) console.log(`- ${problem.message}`);
  }
  return 0;
}

async function deploy(args: string[]): Promise<number> {
  const project = process.cwd();
  const config = configure(args, true);
  const approved = args.includes("--approved");
  if (approved) await confirmWrite("DEPLOY", "This deploys to the sandbox");
  else {
    console.log(
      "Dry run only. Deploying writes to the sandbox, so ask the user for approval, then rerun with --approved.",
    );
  }
  return suitecloud(
    project,
    config.sdfDir,
    ["project:deploy", ...(approved ? [] : ["--dryrun"])],
    config.values,
  );
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === undefined || command === "help" || command === "--help") {
      console.log(USAGE);
      return 0;
    }
    if (command === "deploy") return await deploy(rest);
    if (command === "doctor" || command === "init") return report(rest);
    throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}
