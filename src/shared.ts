import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Config, resultsDirGuidance, resultsDirKey } from "./config.ts";
import { isSandboxAccount, names } from "./doctor.ts";
import { applyEnvUpdate, planEnvUpdate } from "./envfile.ts";

/** A refusal or mistake to report to the person; the message holds no secret. */
export class UsageError extends Error {}

const valueFlags = [
  "--dir",
  "--keys-dir",
  "--only",
  "--param",
  "--results-dir",
];

/** The value after a flag, when given. */
export function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${flag} needs a value.`);
  }
  return value;
}

/** Arguments that are neither flags nor a flag's value. */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (valueFlags.includes(arg)) i++;
    else if (!arg.startsWith("--")) out.push(arg);
  }
  return out;
}

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

/**
 * Runs the project's SuiteCloud CLI from the SDF project folder. The package
 * never sets SUITECLOUD_CLI_ACCEPT_LICENSE (ADR 0001): the child gets the
 * parent's environment plus the passkey, nothing about the license.
 */
export function suitecloud(
  project: string,
  config: Config,
  args: string[],
): number {
  const env: NodeJS.ProcessEnv = { ...process.env, ...config.values };
  // Hand the passkey to the CLI for this child process only.
  if (env.SUITESCRIPT_VERIFY_PASSKEY) {
    env.SUITECLOUD_CI_PASSKEY = env.SUITESCRIPT_VERIFY_PASSKEY;
  }
  if (env.SUITECLOUD_CI_PASSKEY) env.SUITECLOUD_CI = "1";
  const result = spawnSync(
    process.execPath,
    [suitecloudEntry(project), ...args],
    { cwd: config.sdfDir, env, stdio: "inherit" },
  );
  return result.status ?? 1;
}

/**
 * A write to the sandbox needs a person at a terminal, on top of --approved:
 * an agent's shell has none, so an agent cannot run it. The person types the
 * action name to confirm.
 */
export async function confirmWrite(action: string, what: string) {
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

/** True when the person (or --overwrite) allows replacing something that exists. */
export async function allowReplace(args: string[], description: string) {
  if (args.includes("--overwrite")) return true;
  if (args.includes("--keep") || !process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `${description} already exists. Overwrite it? [y/N] `,
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Saves values to `.env.local`. A name that already holds a different value is
 * a conflict: ask the person (overwrite or keep). Without a terminal, or with
 * --keep, keep it and say so; --overwrite replaces it. Values are never printed.
 */
export async function saveEnv(
  config: Config,
  args: string[],
  entries: Record<string, string>,
) {
  const file = join(config.root, ".env.local");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const plan = planEnvUpdate(text, entries);
  const overwrite = new Set<string>();
  const kept: string[] = [];
  for (const name of plan.conflicts) {
    if (await allowReplace(args, `${name} in .env.local`)) overwrite.add(name);
    else kept.push(name);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, applyEnvUpdate(text, entries, overwrite));
  for (const name of [...plan.fresh, ...overwrite]) {
    console.log(`Saved ${name} to .env.local.`);
  }
  for (const name of plan.same) console.log(`${name} already has this value.`);
  for (const name of kept) {
    console.log(
      `Kept the existing ${name}. To replace it, ask the user, then rerun with --overwrite.`,
    );
  }
}

/** The results folder, or a refusal naming the key: the package imposes no layout for results. */
export function requireResultsDir(config: Config): string {
  if (config.resultsDir === undefined) {
    throw new UsageError(`${resultsDirKey} is not set. ${resultsDirGuidance}`);
  }
  return config.resultsDir;
}

/** The runner credentials, or a refusal: every command that reaches the sandbox needs a sandbox account. */
export function requireSandbox(config: Config) {
  const v = config.values;
  const missing = Object.values(names).filter(
    (name) => name !== names.passkey && !v[name],
  );
  if (missing.length > 0) {
    throw new UsageError(
      `Missing ${missing.join(", ")}. Run suitescript-verify doctor.`,
    );
  }
  const account = v[names.account] ?? "";
  if (!isSandboxAccount(account)) {
    throw new UsageError(
      `${names.account} is not a sandbox account id (expected digits_SBn). Verification runs in a sandbox only.`,
    );
  }
  return {
    account,
    certificateId: v[names.certificateId] ?? "",
    clientId: v[names.clientId] ?? "",
    privateKeyPath: v[names.privateKeyPath] ?? "",
    sdfCertificateId: v[names.sdfCertificateId] ?? "",
    sdfPrivateKeyPath: v[names.sdfPrivateKeyPath] ?? "",
  };
}
