import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { runnerNames, runnerOfObjectFile, suiteletNames } from "./netsuite.ts";
import {
  isRestlet,
  isRunnable,
  isSuitelet,
  listProbes,
  type Probe,
  read,
  tagProblems,
} from "./probes.ts";
import { UsageError } from "./shared.ts";

const templates = new URL("../templates/", import.meta.url);
const template = (name: string) =>
  readFileSync(new URL(name, templates), "utf8").replace(/\r\n/g, "\n");

const q = (value: string) => JSON.stringify(value);

/**
 * A script's source (the runner or a script host) with its dependency list
 * generated from the probe slugs. `declared` lists probes the script hands to
 * a host: their names and parameters only, never their code.
 */
export function generateScript(
  probes: Pick<Probe, "params" | "slug">[],
  source: string,
  declared: Pick<Probe, "params" | "slug">[] = [],
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
    )
    .replace(
      "/*SUITELET_ENTRIES*/",
      declared
        .map((probe) => `[${q(probe.slug)}, ${JSON.stringify(probe.params)}],`)
        .join(" "),
    );
}

/**
 * Writes the generated runner, the probe copies and the SDF project files into
 * the SDF folder. RESTlet probes go in the runner and Suitelet probes in the
 * Suitelet host beside it, which is generated even with no Suitelet probes. With
 * `deployed: false` both deployments are switched off (cleanup). A runner
 * generated here under another id, or by 1.x (`_runner`) under any id, is
 * removed so it is not deployed again; `replacedRunners` names them, since each
 * may still be deployed in the sandbox.
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
  const names = runnerNames(runnerId);
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
    }
  }
  writeFileSync(join(sdfDir, "package.json"), template("sdf/package.json"));
  writeFileSync(
    join(sdfDir, "suitecloud.config.js"),
    template("sdf/suitecloud.config.js"),
  );
  writeFileSync(
    join(src, "manifest.xml"),
    template("sdf/manifest.xml").replaceAll("%%ROLE_ID%%", roleId),
  );
  writeFileSync(
    join(src, "deploy.xml"),
    template("sdf/deploy.xml").replaceAll("%%FOLDER%%", names.folder),
  );
  writeFileSync(
    join(src, "Objects", `${names.scriptId}.xml`),
    template("sdf/runner.xml")
      .replaceAll("%%SCRIPT_ID%%", names.scriptId)
      .replaceAll("%%DEPLOY_ID%%", names.deployId)
      .replaceAll("%%FOLDER%%", names.folder)
      .replaceAll("%%FILE%%", names.file)
      .replaceAll("%%TITLE%%", names.title)
      .replace("%%DEPLOYED%%", deployed ? "T" : "F")
      .replaceAll("%%ROLE_ID%%", roleId),
  );
  const host = suiteletNames(runnerId);
  writeFileSync(
    join(src, "Objects", `${host.scriptId}.xml`),
    template("sdf/suitelet.xml")
      .replaceAll("%%SCRIPT_ID%%", host.scriptId)
      .replaceAll("%%DEPLOY_ID%%", host.deployId)
      .replaceAll("%%FOLDER%%", host.folder)
      .replaceAll("%%FILE%%", host.file)
      .replaceAll("%%TITLE%%", host.title)
      .replace("%%DEPLOYED%%", deployed ? "T" : "F")
      .replaceAll("%%ROLE_ID%%", roleId),
  );
  const restlets = probes.filter(isRestlet);
  const suitelets = probes.filter(isSuitelet);
  const files = [names.file, host.file];
  writeFileSync(
    join(folder, names.file),
    generateScript(restlets, template("runner.template.js"), suitelets)
      .replace("%%SUITELET_SCRIPT_ID%%", host.scriptId)
      .replace("%%SUITELET_DEPLOY_ID%%", host.deployId),
  );
  writeFileSync(
    join(folder, host.file),
    generateScript(suitelets, template("suitelet.template.js")),
  );
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
    slugs: restlets.map((probe) => probe.slug),
    suiteletSlugs: suitelets.map((probe) => probe.slug),
  };
}
