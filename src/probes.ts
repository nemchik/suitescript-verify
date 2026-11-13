import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const read = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

export interface Probe {
  scriptType: string;
  slug: string;
  writes: boolean;
}

/** A probe name is a lowercase slug: it ends up in a file name and the runner's fixed list. */
export const isSlug = (name: string) => /^[a-z0-9][a-z0-9-]*$/.test(name);

/** Reads the tags in a probe's leading JSDoc block. Tags the package does not know are ignored. */
export function parseProbe(slug: string, source: string): Probe {
  const block = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? "";
  const tags = (name: string) =>
    [...block.matchAll(new RegExp(`@${name}\\b[ \\t]*([^\\n*]*)`, "g"))].map(
      (match) => (match[1] ?? "").trim(),
    );
  return {
    scriptType: tags("scriptType")[0] ?? "",
    slug,
    writes: tags("writes").length > 0,
  };
}

export function listProbes(dir: string): Probe[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.replace(/\.js$/, ""))
    .filter(isSlug)
    .sort()
    .map((slug) => parseProbe(slug, read(join(dir, `${slug}.js`))));
}

export const isRestlet = (probe: Probe) =>
  probe.scriptType.toLowerCase() === "restlet";

/** The output a probe produced when it was verified, if it declared one. */
export function readExpect(slug: string, dir: string): unknown {
  const path = join(dir, `${slug}.expect.json`);
  return existsSync(path) ? JSON.parse(read(path)) : undefined;
}

export const matchesExpect = (result: unknown, expected: unknown) =>
  isDeepStrictEqual(result, expected);
