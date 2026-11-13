import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

export const USAGE = `Usage: suitescript-verify <command> [options]

Commands:
  deploy [--approved] [--dir <path>]   Dry-run the runner deployment; --approved deploys, from your own terminal
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
function suitecloud(project: string, sdfDir: string, args: string[]): number {
  const env: NodeJS.ProcessEnv = { ...process.env };
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

async function deploy(args: string[]): Promise<number> {
  const project = process.cwd();
  const dirFlag = args.indexOf("--dir");
  const root = resolve(
    project,
    dirFlag >= 0 ? (args[dirFlag + 1] ?? "") : "verification",
  );
  const sdfDir = join(root, "sdf");
  const approved = args.includes("--approved");
  if (approved) await confirmWrite("DEPLOY", "This deploys to the sandbox");
  else {
    console.log(
      "Dry run only. Deploying writes to the sandbox, so ask the user for approval, then rerun with --approved.",
    );
  }
  return suitecloud(project, sdfDir, [
    "project:deploy",
    ...(approved ? [] : ["--dryrun"]),
  ]);
}

export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === undefined || command === "help" || command === "--help") {
      console.log(USAGE);
      return 0;
    }
    if (command === "deploy") return await deploy(rest);
    throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}
