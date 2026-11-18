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
  listProbes,
  type Probe,
  type ProbePermission,
  read,
  tagProblems,
} from "./probes.ts";
import { UsageError } from "./shared.ts";
import { packageVersion } from "./version.ts";

const templates = new URL("../templates/", import.meta.url);
const template = (name: string) =>
  readFileSync(new URL(name, templates), "utf8").replace(/\r\n/g, "\n");

const q = (value: string) => JSON.stringify(value);

/** The minimum the runner needs to be called with a token. */
const minimumPermissions: ProbePermission[] = [
  { level: "FULL", permkey: "ADMI_LOGIN_OAUTH2" },
  { level: "FULL", permkey: "ADMI_RESTWEBSERVICES" },
];

/**
 * The runner role's permissions: the minimum, then each permission the probes
 * declare with `@permission`, once, sorted by key. A key the minimum already
 * holds keeps the minimum's level. A deploy writes these to the role object;
 * whether it also removes permissions not listed is unconfirmed (#44).
 */
export function rolePermissions(
  probes: Pick<Probe, "permissions">[],
): ProbePermission[] {
  const held = new Set(minimumPermissions.map(({ permkey }) => permkey));
  const declared = new Map<string, string>();
  for (const { level, permkey } of probes.flatMap((p) => p.permissions)) {
    if (!held.has(permkey)) declared.set(permkey, level);
  }
  return [
    ...minimumPermissions,
    ...[...declared]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([permkey, level]) => ({ level, permkey })),
  ];
}

/** The generated role object; its name comes from the runner id and fits the platform's 40 characters. */
const roleObject = (
  roleId: string,
  runnerId: string,
  permissions: ProbePermission[],
) =>
  template("sdf/role.xml")
    .replaceAll("%%ROLE_ID%%", roleId)
    .replaceAll("%%NAME%%", `ssv runner role ${runnerId}`)
    .replace(
      "%%PERMISSIONS%%",
      permissions
        .map(
          ({ level, permkey }) =>
            `    <permission>\n      <permkey>${permkey}</permkey>\n      <permlevel>${level}</permlevel>\n    </permission>\n`,
        )
        .join(""),
    );

/**
 * A script's source (the runner or a script host) with its dependency list
 * generated from the probe slugs.
 */
function generateScript(
  probes: Pick<Probe, "params" | "slug">[],
  source: string,
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
            `[${q(slug)}, [${names[i]}, ${JSON.stringify(probes[i]?.params ?? [])}]],`,
        )
        .join(" "),
    );
}

/**
 * The runner's list of probes it hands to the Suitelet host: their names and
 * parameters only, never their code.
 */
const hostedEntries = (hosted: Pick<Probe, "params" | "slug">[]) =>
  hosted
    .map((probe) => `[${q(probe.slug)}, ${JSON.stringify(probe.params)}],`)
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
): { build: string; host: string; runner: string } {
  const restlets = probes.filter(isRestlet);
  const suitelets = probes.filter(isSuitelet);
  const host = scriptNames(runnerId, "sl");
  const slugList = (list: Probe[]) =>
    list
      .map((probe) => probe.slug)
      .sort()
      .join(",");
  const runner = generateScript(restlets, template("runner.template.js"))
    .replace("/*SUITELET_ENTRIES*/", hostedEntries(suitelets))
    .replace("%%SUITELET_SCRIPT_ID%%", host.scriptId)
    .replace("%%SUITELET_DEPLOY_ID%%", host.deployId)
    .replace("%%PACKAGE_VERSION%%", packageVersion)
    .replace(
      "%%PERMISSIONS%%",
      rolePermissions(probes)
        .map(({ permkey }) => permkey)
        .join(","),
    )
    .replace("%%PROBES%%", slugList(probes));
  const hostScript = generateScript(suitelets, template("suitelet.template.js"))
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
  return generateScripts(listProbes(probesDir, extraTags).filter(isRunnable), {
    probesDir,
    runnerId,
  }).build;
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
 * Writes the generated runner, the probe copies and the SDF project files into
 * the SDF folder. RESTlet probes go in the runner and Suitelet probes in the
 * Suitelet host beside it, which is generated even with no Suitelet probes. With
 * `deployed: false` both deployments are switched off (cleanup). A runner
 * generated here under another id, or by 1.x (`_runner`) under any id, is
 * removed so it is not deployed again; `replacedRunners` names them, since each
 * may still be deployed in the sandbox. The runner's role is written too, the
 * same in deploy and cleanup (cleanup leaves it alone); a role object written
 * here under another id is removed so it is not deployed again.
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
      rmSync(join(src, "Objects", file));
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
    roleObject(roleId, runnerId, rolePermissions(probes)),
  );
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
    scriptObject("sdf/suitelet.xml", host, roleId, deployed),
  );
  const scripts = generateScripts(probes, { probesDir, runnerId });
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
