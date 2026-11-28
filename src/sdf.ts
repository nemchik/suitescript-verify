import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { runnerOfObjectFile, scriptNames } from "./netsuite.ts";
import {
  isRestlet,
  isRunnable,
  isSuitelet,
  isWriting,
  listProbes,
  type Probe,
  type ProbePermission,
  read,
  tagProblems,
} from "./probes.ts";
import {
  type ExecutionRole,
  executionRoleNamePrefix,
  permissionSet,
  permissionSetKey,
  planSlots,
  runnerRolePermissions,
  type Slot,
} from "./roles.ts";
import { UsageError } from "./shared.ts";
import { packageVersion } from "./version.ts";

const templates = new URL("../templates/", import.meta.url);
const template = (name: string) =>
  readFileSync(new URL(name, templates), "utf8").replace(/\r\n/g, "\n");

const q = (value: string) => JSON.stringify(value);

/**
 * A generated role object. `inactive` writes the role's `isinactive` field
 * (an execution role is always written, active or retired); the runner's role
 * leaves it out.
 */
const roleObject = (
  roleId: string,
  name: string,
  permissions: readonly ProbePermission[],
  inactive?: boolean,
) =>
  template("sdf/role.xml")
    .replaceAll("%%ROLE_ID%%", roleId)
    .replaceAll("%%NAME%%", name)
    .replace(
      "%%INACTIVE%%",
      inactive === undefined
        ? ""
        : `  <isinactive>${inactive ? "T" : "F"}</isinactive>\n`,
    )
    .replace(
      "%%PERMISSIONS%%",
      permissions
        .map(
          ({ level, permkey }) =>
            `    <permission>\n      <permkey>${permkey}</permkey>\n      <permlevel>${level}</permlevel>\n    </permission>\n`,
        )
        .join(""),
    );

/** The runner's role object: its name comes from the runner id and fits the platform's 40 characters. */
const runnerRoleObject = (roleId: string, runnerId: string) =>
  roleObject(roleId, `ssv runner role ${runnerId}`, runnerRolePermissions);

/** An execution role's object, active or retired. */
const executionRoleObject = (role: ExecutionRole, inactive: boolean) =>
  roleObject(role.id, role.name, role.permissions, inactive);

/**
 * A script's source (the runner or a script host) with its dependency list
 * generated from the probe slugs. Each probe's entry is its module, its
 * parameters and then the `extra` values the script needs about it.
 */
function generateScript<T extends Pick<Probe, "params" | "slug">>(
  probes: T[],
  source: string,
  extra: (probe: T) => unknown[] = () => [],
): string {
  const slugs = probes.map((probe) => probe.slug);
  const names = slugs.map((_, i) => `probe${i}`);
  // Each list item carries its own leading comma, so the template stays valid
  // when the formatter moves the placeholder comments around.
  return source
    .replace(
      "/*PROBE_PATHS*/",
      slugs.map((slug) => `, ${q(`./probes/${slug}`)}`).join(""),
    )
    .replace("/*PROBE_NAMES*/", names.map((name) => `, ${name}`).join(""))
    .replace(
      "/*PROBE_ENTRIES*/",
      slugs
        .map(
          (slug, i) =>
            `[${q(slug)}, [${names[i]}, ${JSON.stringify(probes[i]?.params ?? [])}${(probes[i] ? extra(probes[i]) : []).map((value) => `, ${JSON.stringify(value)}`).join("")}]],`,
        )
        .join(" "),
    );
}

/**
 * The runner's list of probes it hands to the Suitelet host: their names,
 * parameters and the deployment of their slot, never their code.
 */
const hostedEntries = (
  hosted: Pick<Probe, "params" | "slug">[],
  slotOf: Map<string, Slot>,
) =>
  hosted
    .map(
      (probe) =>
        `[${q(probe.slug)}, ${JSON.stringify(probe.params)}, ${q(slotOf.get(probe.slug)?.deploymentId ?? "")}],`,
    )
    .join(" ");

/**
 * The host's table of slots: the deployment id of each slot a probe uses
 * (lower case, as a deployment id is compared) and the text of the permission
 * set it runs as.
 */
const slotEntries = (slots: Slot[]) =>
  slots
    .filter((slot) => slot.used)
    .map((slot) => `[${q(slot.deploymentId.toLowerCase())}, ${q(slot.key)}],`)
    .join(" ");

/** The placeholder the build fingerprint replaces, left in place while it is computed. */
const BUILD = "%%BUILD%%";

/**
 * The generated runner and Suitelet host, and their build fingerprint: the
 * first 12 hex digits of a sha256 of both scripts (with the placeholder still
 * in place) and every probe's source. The package version stays the same
 * between builds, so the fingerprint is what tells the self-check that the
 * templates or the probes changed since the deploy.
 */
function generateScripts(
  probes: Probe[],
  { probesDir, runnerId }: Pick<Config, "probesDir" | "runnerId">,
  { slotOf, slots }: ReturnType<typeof planSlots>,
): { build: string; host: string; runner: string } {
  const restlets = probes.filter(isRestlet);
  const suitelets = probes.filter(isSuitelet);
  const host = scriptNames(runnerId, "sl");
  const slugList = (list: Probe[]) =>
    list
      .map((probe) => probe.slug)
      .sort()
      .join(",");
  const runner = generateScript(
    restlets,
    template("runner.template.js"),
    // Whether the probe declares a permission or writes, which the runner's role cannot give it.
    (probe) => [probe.permissions.length > 0 || isWriting(probe)],
  )
    .replace("/*SUITELET_ENTRIES*/", hostedEntries(suitelets, slotOf))
    .replace("%%SUITELET_SCRIPT_ID%%", host.scriptId)
    // The self-check slot: the one running as no permissions.
    .replace("%%SUITELET_DEPLOY_ID%%", slots[0]?.deploymentId ?? "")
    .replace("%%PACKAGE_VERSION%%", packageVersion)
    .replace(
      "%%PERMISSIONS%%",
      runnerRolePermissions.map(({ permkey }) => permkey).join(","),
    )
    .replace("%%PROBES%%", slugList(probes));
  const hostScript = generateScript(
    suitelets,
    template("suitelet.template.js"),
    (probe) => {
      const set = permissionSet(probe);
      return [permissionSetKey(set), set.map(({ permkey }) => permkey)];
    },
  )
    .replace("/*SLOT_ENTRIES*/", slotEntries(slots))
    .replace("%%PACKAGE_VERSION%%", packageVersion)
    .replace("%%PROBES%%", slugList(suitelets));
  const hash = createHash("sha256").update(runner).update(hostScript);
  for (const { slug } of probes) {
    hash.update(`\0${slug}\0${read(join(probesDir, `${slug}.js`))}`);
  }
  const build = hash.digest("hex").slice(0, 12);
  return {
    build,
    host: hostScript.replace(BUILD, build),
    runner: runner.replace(BUILD, build),
  };
}

/** The build fingerprint a deploy from this project would bake into the runner and the host. */
export function buildFingerprint({
  extraTags,
  probesDir,
  runnerId,
}: Pick<Config, "extraTags" | "probesDir" | "runnerId">): string {
  const probes = listProbes(probesDir, extraTags).filter(isRunnable);
  return generateScripts(
    probes,
    { probesDir, runnerId },
    planSlots(runnerId, probes.filter(isSuitelet)),
  ).build;
}

/** A script's SDF object: its ids, file, name and role, and whether it is deployed. */
const scriptObject = (
  name: string,
  names: ReturnType<typeof scriptNames>,
  roleId: string,
  deployed: boolean,
) =>
  template(name)
    .replaceAll("%%SCRIPT_ID%%", names.scriptId)
    .replaceAll("%%DEPLOY_ID%%", names.deployId)
    .replaceAll("%%FOLDER%%", names.folder)
    .replaceAll("%%FILE%%", names.file)
    .replaceAll("%%TITLE%%", names.title)
    .replace("%%DEPLOYED%%", deployed ? "T" : "F")
    .replaceAll("%%ROLE_ID%%", roleId);

/**
 * The Suitelet host's SDF object: one deployment per slot, each running as its
 * slot's execution role (`runasrole`), for the runner's role only and never
 * online. A slot no probe uses is switched off, like every slot in cleanup.
 */
const suiteletObject = (
  names: ReturnType<typeof scriptNames>,
  runnerRoleId: string,
  slots: Slot[],
  deployed: boolean,
) =>
  template("sdf/suitelet.xml")
    .replaceAll("%%SCRIPT_ID%%", names.scriptId)
    .replaceAll("%%FOLDER%%", names.folder)
    .replaceAll("%%FILE%%", names.file)
    .replaceAll("%%TITLE%%", names.title)
    .replace("%%DEPLOYMENTS%%", () =>
      slots
        .map((slot) =>
          template("sdf/suitelet-deployment.xml")
            .replaceAll("%%DEPLOY_ID%%", slot.deploymentId)
            .replaceAll("%%TITLE%%", `${names.title} s${slot.index}`)
            .replace("%%DEPLOYED%%", deployed && slot.used ? "T" : "F")
            .replaceAll("%%ROLE_ID%%", runnerRoleId)
            .replaceAll("%%RUN_AS_ROLE%%", slot.role.id),
        )
        .join(""),
    );

/**
 * Writes the generated runner, the probe copies and the SDF project files into
 * the SDF folder. RESTlet probes go in the runner and Suitelet probes in the
 * Suitelet host beside it, which is generated even with no Suitelet probes. With
 * `deployed: false` the runner's and every slot's deployment are switched off
 * (cleanup). A runner generated here under another id, or by 1.x (`_runner`)
 * under any id, is removed so it is not deployed again; `replacedRunners` names
 * them, since each may still be deployed in the sandbox. The runner's role is
 * written too, the same in deploy and cleanup (cleanup leaves it alone); a role
 * object written here under another id is removed so it is not deployed again.
 * Each current execution role is written active. One left in the folder by an
 * earlier deploy that no slot uses is written again inactive, since SDF can
 * neither delete a role nor take permissions off it.
 */
export function buildSdfProject(
  {
    extraTags,
    probesDir,
    roleId,
    runnerId,
    sdfDir,
  }: Pick<Config, "extraTags" | "probesDir" | "roleId" | "runnerId" | "sdfDir">,
  { deployed }: { deployed: boolean },
): {
  files: string[];
  replacedRunners: { id: string; legacy: boolean }[];
  slugs: string[];
  suiteletSlugs: string[];
} {
  const probes = listProbes(probesDir, extraTags).filter(isRunnable);
  const bad = probes.filter((probe) => tagProblems(probe).length > 0);
  if (bad.length > 0) {
    throw new UsageError(
      `Fix the probe tags before deploying:\n${bad
        .flatMap((p) => tagProblems(p).map((m) => `- ${p.slug}: ${m}`))
        .join("\n")}`,
    );
  }
  const plan = planSlots(runnerId, probes.filter(isSuitelet));
  const current = new Map<string, ExecutionRole>(
    plan.slots.map(({ role }) => [role.id, role]),
  );
  const src = join(sdfDir, "src");
  const names = scriptNames(runnerId, "rl");
  const folder = join(src, "FileCabinet", "SuiteScripts", names.folder);
  rmSync(join(src, "FileCabinet"), { force: true, recursive: true });
  mkdirSync(join(folder, "probes"), { recursive: true });
  mkdirSync(join(src, "Objects"), { recursive: true });
  const replacedRunners: { id: string; legacy: boolean }[] = [];
  for (const file of readdirSync(join(src, "Objects"))) {
    const runner = runnerOfObjectFile(file);
    if (runner !== undefined && (runner.legacy || runner.id !== runnerId)) {
      rmSync(join(src, "Objects", file));
      if (
        !replacedRunners.some(
          (r) => r.id === runner.id && r.legacy === runner.legacy,
        )
      ) {
        replacedRunners.push(runner);
      }
    } else if (/^customrole_.*\.xml$/.test(file) && file !== `${roleId}.xml`) {
      const path = join(src, "Objects", file);
      const retired = read(path);
      if (!retired.includes(`<name>${executionRoleNamePrefix}`)) {
        rmSync(path);
      } else if (!current.has(file.replace(/\.xml$/, ""))) {
        // An execution role no slot uses: written again, inactive.
        writeFileSync(
          path,
          retired.replace(
            "<isinactive>F</isinactive>",
            "<isinactive>T</isinactive>",
          ),
        );
      }
    }
  }
  writeFileSync(join(sdfDir, "package.json"), template("sdf/package.json"));
  writeFileSync(
    join(sdfDir, "suitecloud.config.js"),
    template("sdf/suitecloud.config.js"),
  );
  writeFileSync(join(src, "manifest.xml"), template("sdf/manifest.xml"));
  writeFileSync(
    join(src, "Objects", `${roleId}.xml`),
    runnerRoleObject(roleId, runnerId),
  );
  for (const role of current.values()) {
    writeFileSync(
      join(src, "Objects", `${role.id}.xml`),
      executionRoleObject(role, false),
    );
  }
  writeFileSync(
    join(src, "deploy.xml"),
    template("sdf/deploy.xml").replaceAll("%%FOLDER%%", names.folder),
  );
  writeFileSync(
    join(src, "Objects", `${names.scriptId}.xml`),
    scriptObject("sdf/runner.xml", names, roleId, deployed),
  );
  const host = scriptNames(runnerId, "sl");
  writeFileSync(
    join(src, "Objects", `${host.scriptId}.xml`),
    suiteletObject(host, roleId, plan.slots, deployed),
  );
  const scripts = generateScripts(probes, { probesDir, runnerId }, plan);
  const files: string[] = [names.file, host.file];
  writeFileSync(join(folder, names.file), scripts.runner);
  writeFileSync(join(folder, host.file), scripts.host);
  for (const slug of probes.map((probe) => probe.slug)) {
    writeFileSync(
      join(folder, "probes", `${slug}.js`),
      read(join(probesDir, `${slug}.js`)),
    );
    files.push(`probes/${slug}.js`);
  }
  return {
    files,
    replacedRunners,
    slugs: probes.filter(isRestlet).map((probe) => probe.slug),
    suiteletSlugs: probes.filter(isSuitelet).map((probe) => probe.slug),
  };
}
