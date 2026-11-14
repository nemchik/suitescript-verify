import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { runnerIdOfObjectFile, runnerNames } from "./netsuite.ts";
import {
  isRestlet,
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

/** The runner source with its dependency list generated from the probe slugs. */
export function generateRunner(
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
 * Writes the generated runner, the probe copies and the SDF project files into
 * the SDF folder. Only RESTlet probes go in: the runner is a RESTlet. With
 * `deployed: false` the runner's deployment is switched off (cleanup). A runner
 * generated here under another id is removed so it is not deployed again;
 * `replacedRunners` names those ids, since each may still be deployed in the sandbox.
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
): { files: string[]; replacedRunners: string[]; slugs: string[] } {
  const probes = listProbes(probesDir, extraTags).filter(isRestlet);
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
  const replacedRunners: string[] = [];
  for (const file of readdirSync(join(src, "Objects"))) {
    const id = runnerIdOfObjectFile(file);
    if (id !== undefined && id !== runnerId) {
      rmSync(join(src, "Objects", file));
      replacedRunners.push(id);
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
      .replaceAll("%%TITLE%%", names.title)
      .replace("%%DEPLOYED%%", deployed ? "T" : "F")
      .replaceAll("%%ROLE_ID%%", roleId),
  );
  const slugs = probes.map((probe) => probe.slug);
  const files = ["runner.js"];
  writeFileSync(
    join(folder, "runner.js"),
    generateRunner(probes, template("runner.template.js")),
  );
  for (const slug of slugs) {
    writeFileSync(
      join(folder, "probes", `${slug}.js`),
      read(join(probesDir, `${slug}.js`)),
    );
    files.push(`probes/${slug}.js`);
  }
  return { files, replacedRunners, slugs };
}
