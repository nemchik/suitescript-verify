import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Check } from "./doctor.ts";
import { scriptNames, scrub } from "./netsuite.ts";
import {
  isRunnable,
  isSuitelet,
  listProbes,
  type Probe,
  type ProbePermission,
  permissionLevels,
} from "./probes.ts";
import { callRunner, knownIds } from "./run.ts";
import { buildFingerprint, rolePermissions } from "./sdf.ts";
import { type Creds, requireSandbox } from "./shared.ts";
import { packageVersion } from "./version.ts";

const name =
  "The deployed runner passes its self-check (version, build, probes, Suitelet host and role)";

/** Permission levels from least to most; anything else (an unreadable permission) ranks below NONE. */
const levels = ["NONE", ...permissionLevels];
const rank = (level: unknown) => levels.indexOf(String(level));

const redeployHow =
  "Run suitescript-verify deploy, then ask the user to run it with --approved in their own terminal, and run doctor again.";

interface HostAnswer {
  build?: string;
  error?: string;
  packageVersion?: string;
  probes?: string[];
  sandbox?: boolean;
}

interface SelfCheck {
  build?: string;
  host?: HostAnswer;
  packageVersion?: string;
  permissions?: Record<string, string>;
  probes?: string[];
  role?: string;
  sandbox?: boolean;
}

const list = (items: readonly string[] | undefined) =>
  `[${(items ?? []).join(", ")}]`;
const same = (a: readonly string[] | undefined, b: readonly string[]) =>
  list([...(a ?? [])].sort()) === list([...b].sort());

/** Whether the generated SDF project here last switched the runner on: a local trace of a deploy. */
function deployedHere(config: Config): boolean {
  const file = join(
    config.sdfDir,
    "src",
    "Objects",
    `${scriptNames(config.runnerId, "rl").scriptId}.xml`,
  );
  return (
    existsSync(file) &&
    readFileSync(file, "utf8").includes("<isdeployed>T</isdeployed>")
  );
}

/** Why the deployment differs from this project, each reason a short clause; empty when it matches. */
function redeployReasons(
  check: SelfCheck,
  probes: Probe[],
  wanted: ProbePermission[],
  build: string,
): string[] {
  const slugs = probes.map((probe) => probe.slug);
  const suitelets = probes.filter(isSuitelet).map((probe) => probe.slug);
  const permkeys = wanted.map(({ permkey }) => permkey);
  const reasons: string[] = [];
  if (check.packageVersion !== packageVersion || check.build !== build) {
    reasons.push(
      `the deployed runner is version ${check.packageVersion} build ${check.build}, this project has version ${packageVersion} build ${build}`,
    );
  }
  if (!same(check.probes, slugs)) {
    reasons.push(
      `the deployed probes are ${list(check.probes)}, this project has ${list(slugs)}`,
    );
  }
  if (!same(Object.keys(check.permissions ?? {}), permkeys)) {
    reasons.push(
      `the deployed role permissions are ${list(Object.keys(check.permissions ?? {}))}, this project's are ${list(permkeys)}`,
    );
  }
  const host = check.host ?? { error: "no answer" };
  if (host.error !== undefined) {
    reasons.push(
      `the Suitelet host does not answer its self-check (${host.error})`,
    );
  } else if (
    host.sandbox !== true ||
    host.packageVersion !== packageVersion ||
    host.build !== build ||
    !same(host.probes, suitelets)
  ) {
    reasons.push(
      `the Suitelet host is version ${host.packageVersion} build ${host.build} with probes ${list(host.probes)}, this project has version ${packageVersion} build ${build} with ${list(suitelets)}`,
    );
  }
  return reasons;
}

/**
 * The final `doctor` step: calls the runner's reserved self-check through the
 * token flow `run` uses and compares the answer with this project. It only
 * reads. Nothing is sent until the runner's settings pass, and nothing the
 * answer holds is printed unless it passes the scrubber.
 */
export async function selfCheckStep(config: Config): Promise<Check> {
  const fail = (next: string): Check => ({
    name,
    next,
    ok: false,
    owner: "maintainer",
  });
  const before =
    "Fix the steps above first: the self-check needs the runner's settings and private key.";
  if (config.problems.length > 0) return fail(before);
  let creds: Creds;
  try {
    creds = requireSandbox(config);
  } catch {
    return fail(before);
  }
  if (!existsSync(creds.privateKeyPath)) return fail(before);

  let text: string;
  try {
    text = await callRunner(creds, config.runnerId, { selfCheck: true });
  } catch (error) {
    const detail = scrub((error as Error).message, knownIds(creds));
    const seen =
      detail.problems.length > 0
        ? "an answer that cannot be printed"
        : detail.text.replace(/\s+/g, " ").trim();
    return fail(
      deployedHere(config)
        ? `The runner did not answer the self-check: ${seen}. If cleanup switched it off, or the deploy failed, redeploy. ${redeployHow}`
        : `Deploy first: this project has not deployed the runner, and it did not answer (${seen}). ${redeployHow}`,
    );
  }

  const scrubbed = scrub(text, knownIds(creds));
  if (scrubbed.problems.length > 0) {
    return fail(
      `Refusing to print the runner's self-check: ${scrubbed.problems.join("; ")}. Review it by hand.`,
    );
  }
  let answer: { selfCheck?: SelfCheck };
  try {
    answer = JSON.parse(scrubbed.text);
  } catch {
    answer = {};
  }
  const check = answer?.selfCheck;
  if (!check || typeof check !== "object") {
    return fail(
      `Redeploy: the deployed runner has no self-check (it answered ${scrubbed.text.slice(0, 200)}). ${redeployHow}`,
    );
  }
  if (check.sandbox !== true) {
    return fail(
      "The runner reports the account is not a sandbox. Verification never runs in production: check SUITESCRIPT_VERIFY_ACCOUNT and the deploy target.",
    );
  }
  const probes = listProbes(config.probesDir, config.extraTags).filter(
    isRunnable,
  );
  const wanted = rolePermissions(probes);
  const reasons = redeployReasons(
    check,
    probes,
    wanted,
    buildFingerprint(config),
  );
  if (reasons.length > 0) {
    return fail(`Redeploy: ${reasons.join("; ")}. ${redeployHow}`);
  }
  if (String(check.role ?? "").toLowerCase() !== config.roleId) {
    return fail(
      `The runner runs as ${check.role}, not ${config.roleId}. Map the runner certificate to ${config.roleId} in the sandbox (Setup > Integration > Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup).`,
    );
  }
  const lacking = wanted.filter(
    ({ level, permkey }) => rank(check.permissions?.[permkey]) < rank(level),
  );
  if (lacking.length > 0) {
    return fail(
      `Drift: the runner's role lacks ${lacking
        .map(
          ({ level, permkey }) =>
            `${permkey} (wants ${level}, holds ${check.permissions?.[permkey]})`,
        )
        .join(
          ", ",
        )}. The role was changed in the account since the deploy wrote it; a redeploy writes it again. ${redeployHow}`,
    );
  }
  return { name, ok: true };
}
