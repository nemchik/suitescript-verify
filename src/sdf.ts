import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileCabinetFolder } from "./netsuite.ts";
import { isRestlet, listProbes, read } from "./probes.ts";

const templates = new URL("../templates/", import.meta.url);
const template = (name: string) =>
  readFileSync(new URL(name, templates), "utf8").replace(/\r\n/g, "\n");

const q = (value: string) => JSON.stringify(value);

/** The runner source with its dependency list generated from the probe slugs. */
export function generateRunner(slugs: string[], source: string): string {
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
      slugs.map((slug, i) => `[${q(slug)}, ${names[i]}],`).join(" "),
    );
}

/**
 * Writes the generated runner, the probe copies and the SDF project files into
 * the SDF folder. Only RESTlet probes go in: the runner is a RESTlet. With
 * `deployed: false` the runner's deployment is switched off (cleanup).
 */
export function buildSdfProject(
  sdfDir: string,
  probesDir: string,
  { deployed }: { deployed: boolean },
): { files: string[]; slugs: string[] } {
  const probes = listProbes(probesDir).filter(isRestlet);
  const src = join(sdfDir, "src");
  const folder = join(src, "FileCabinet", "SuiteScripts", fileCabinetFolder);
  rmSync(join(src, "FileCabinet"), { force: true, recursive: true });
  mkdirSync(join(folder, "probes"), { recursive: true });
  mkdirSync(join(src, "Objects"), { recursive: true });
  writeFileSync(join(sdfDir, "package.json"), template("sdf/package.json"));
  writeFileSync(
    join(sdfDir, "suitecloud.config.js"),
    template("sdf/suitecloud.config.js"),
  );
  writeFileSync(join(src, "manifest.xml"), template("sdf/manifest.xml"));
  writeFileSync(join(src, "deploy.xml"), template("sdf/deploy.xml"));
  writeFileSync(
    join(src, "Objects", "customscript_suitescript_verify_runner.xml"),
    template("sdf/runner.xml").replace("%%DEPLOYED%%", deployed ? "T" : "F"),
  );
  const slugs = probes.map((probe) => probe.slug);
  const files = ["runner.js"];
  writeFileSync(
    join(folder, "runner.js"),
    generateRunner(slugs, template("runner.template.js")),
  );
  for (const slug of slugs) {
    writeFileSync(
      join(folder, "probes", `${slug}.js`),
      read(join(probesDir, `${slug}.js`)),
    );
    files.push(`probes/${slug}.js`);
  }
  return { files, slugs };
}
