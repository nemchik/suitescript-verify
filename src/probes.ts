import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const read = (path: string) =>
  readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** A parameter a probe declares with `@param <name> <pattern>`; its value is always a string. */
export interface ProbeParam {
  name: string;
  pattern: string;
}

export interface Probe {
  /** What is wrong with the probe's `@param` tags, if anything. */
  paramProblems: string[];
  params: ProbeParam[];
  scriptType: string;
  slug: string;
  writes: boolean;
}

/** A probe name is a lowercase slug: it ends up in a file name and the runner's fixed list. */
export const isSlug = (name: string) => /^[a-z0-9][a-z0-9-]*$/.test(name);

const paramName = /^[a-z][A-Za-z0-9]*$/;

/** The whole value must match: a declared pattern is anchored, so `[0-9]+` cannot match `1;x`. */
export const anchored = (pattern: string) =>
  new RegExp(`^(?:${pattern})$`, "u");

function parseParams(block: string): Pick<Probe, "paramProblems" | "params"> {
  const params: ProbeParam[] = [];
  const paramProblems: string[] = [];
  for (const match of block.matchAll(/^[ \t]*\*?[ \t]*@param\b[ \t]*(.*)$/gm)) {
    const line = (match[1] ?? "").trim();
    const [, name = "", pattern = ""] = /^(\S*)[ \t]*(.*)$/.exec(line) ?? [];
    if (!paramName.test(name)) {
      paramProblems.push(
        `@param "${name}" needs a name like recordType: @param <name> <pattern>`,
      );
    } else if (params.some((param) => param.name === name)) {
      paramProblems.push(`@param ${name} is declared more than once`);
    } else if (pattern === "") {
      paramProblems.push(
        `@param ${name} needs a pattern: @param ${name} <pattern>`,
      );
    } else {
      try {
        anchored(pattern);
        params.push({ name, pattern });
      } catch {
        paramProblems.push(`@param ${name} has an invalid pattern: ${pattern}`);
      }
    }
  }
  return { paramProblems, params };
}

/** Reads the tags in a probe's leading JSDoc block. Tags the package does not know are ignored. */
export function parseProbe(slug: string, source: string): Probe {
  const block = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? "";
  const tags = (name: string) =>
    [...block.matchAll(new RegExp(`@${name}\\b[ \\t]*([^\\n*]*)`, "g"))].map(
      (match) => (match[1] ?? "").trim(),
    );
  return {
    ...parseParams(block),
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
