import { packageVersion } from "./version.ts";

/**
 * Whether a probe that does not write may import a module: `allowed` when the
 * module only reads or every write it can make needs a permission the role
 * lacks, `writing` otherwise. A module not listed counts as writing.
 */
export type ModuleClass = "allowed" | "writing";

/**
 * Every known `N/` module. `N/record` is allowed because in-memory record work
 * needs CREATE (sandbox check at NetSuite 2026.2, #85). `N/search` is allowed
 * by the maintainer's decision, although `search.save()` worked under VIEW:
 * refusing it would make almost every read probe a writing probe. `N/email` is
 * writing because `email.send` worked with no permission. The rest are
 * classified by what the module can do, not yet by a sandbox run.
 */
export const moduleClasses: Readonly<Record<string, ModuleClass>> = {
  "N/action": "writing",
  "N/auth": "writing",
  "N/cache": "writing",
  "N/certificateControl": "writing",
  "N/commerce/recordView": "allowed",
  "N/commerce/webSite": "allowed",
  "N/compress": "allowed",
  "N/config": "allowed",
  "N/crypto": "allowed",
  "N/crypto/certificate": "allowed",
  "N/crypto/random": "allowed",
  "N/currency": "allowed",
  "N/currentRecord": "allowed",
  "N/dataset": "allowed",
  "N/datasetLink": "allowed",
  "N/documentCapture": "writing",
  "N/email": "writing",
  "N/encode": "allowed",
  "N/error": "allowed",
  "N/file": "writing",
  "N/format": "allowed",
  "N/format/i18n": "allowed",
  "N/http": "writing",
  "N/https": "writing",
  "N/https/clientCertificate": "writing",
  "N/keyControl": "writing",
  "N/llm": "writing",
  "N/log": "allowed",
  "N/machineTranslation": "writing",
  "N/piremoval": "writing",
  "N/plugin": "writing",
  "N/portlet": "allowed",
  "N/query": "allowed",
  "N/record": "allowed",
  "N/recordContext": "allowed",
  "N/redirect": "allowed",
  "N/render": "allowed",
  "N/runtime": "allowed",
  "N/search": "allowed",
  "N/sftp": "writing",
  "N/sso": "writing",
  "N/suiteAppInfo": "allowed",
  "N/task": "writing",
  "N/task/accountMigration": "writing",
  "N/transaction": "writing",
  "N/translation": "allowed",
  "N/ui/dialog": "allowed",
  "N/ui/message": "allowed",
  "N/ui/serverWidget": "allowed",
  "N/url": "allowed",
  "N/util": "allowed",
  "N/workbook": "allowed",
  "N/workflow": "writing",
  "N/xml": "allowed",
};

/** The pseudo-modules AMD passes to a `define` callback; they load no code. */
const amdBuiltins = new Set(["require", "exports", "module"]);

type Token =
  | { kind: "string"; value: string }
  | { kind: "other"; text: string };

const keywordsBeforeRegex = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "yield",
  "await",
]);

/** Splits JavaScript into string literals and everything else, skipping comments. A template with `${` becomes one non-literal token. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const regexAllowed = () => {
    const prev = tokens.at(-1);
    if (!prev) return true;
    if (prev.kind === "string") return false;
    if (/^[A-Za-z_$]/.test(prev.text)) {
      return keywordsBeforeRegex.has(prev.text);
    }
    return !")]}".includes(prev.text);
  };
  while (i < source.length) {
    const ch = source[i] ?? "";
    const next = source[i + 1];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      let value = "";
      let dynamic = false;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === "\\") {
          value += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (ch === "`" && source[i] === "$" && source[i + 1] === "{") {
          dynamic = true;
        }
        value += source[i];
        i++;
      }
      i++;
      tokens.push(
        dynamic ? { kind: "other", text: "`" } : { kind: "string", value },
      );
    } else if (ch === "/" && regexAllowed()) {
      let inClass = false;
      i++;
      while (i < source.length && (inClass || source[i] !== "/")) {
        if (source[i] === "\\") i++;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "\n") break;
        i++;
      }
      i++;
      while (/[A-Za-z]/.test(source[i] ?? "")) i++;
      tokens.push({ kind: "other", text: "/re/" });
    } else if (/[A-Za-z_$]/.test(ch)) {
      let word = "";
      while (/[\w$]/.test(source[i] ?? "")) word += source[i++];
      tokens.push({ kind: "other", text: word });
    } else if (/[0-9]/.test(ch)) {
      while (/[\w.]/.test(source[i] ?? "")) i++;
      tokens.push({ kind: "other", text: "0" });
    } else {
      tokens.push({ kind: "other", text: ch });
      i++;
    }
  }
  return tokens;
}

export interface ProbeImports {
  /** A `define` dependency list or `require` call that names a module without a plain string. */
  dynamic: boolean;
  /** Every module named by a string literal, without repeats. */
  modules: string[];
}

const opens = new Set(["(", "[", "{"]);
const closes = new Set([")", "]", "}"]);

/** The modules a probe's `define` dependencies and `require` calls name. */
export function probeImports(source: string): ProbeImports {
  const tokens = tokenize(source);
  const modules: string[] = [];
  let dynamic = false;
  const text = (i: number) => {
    const t = tokens[i];
    return t?.kind === "other" ? t.text : undefined;
  };
  /** Reads a `[...]` list from its `[`: a string is a module, anything else is dynamic. */
  const readList = (start: number) => {
    let i = start + 1;
    while (i < tokens.length && text(i) !== "]") {
      // One element: it is a module only if it is a lone string before the next comma or the closing bracket.
      const first = tokens[i];
      let depth = 0;
      let length = 0;
      for (; i < tokens.length; i++, length++) {
        const s = text(i);
        if (s !== undefined && opens.has(s)) depth++;
        else if (s !== undefined && closes.has(s)) {
          if (depth === 0) break;
          depth--;
        } else if (s === "," && depth === 0) break;
      }
      if (length === 1 && first?.kind === "string") modules.push(first.value);
      else if (length > 0) dynamic = true;
      if (text(i) === ",") i++;
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const name = text(i);
    if ((name !== "define" && name !== "require") || text(i - 1) === ".") {
      continue;
    }
    if (text(i + 1) !== "(") continue;
    let at = i + 2;
    if (name === "define") {
      if (tokens[at]?.kind === "string" && text(at + 1) === ",") at += 2;
      if (text(at) === "[") readList(at);
      else {
        const t = text(at);
        const callback =
          t === "(" ||
          t === "{" ||
          t === "function" ||
          t === "async" ||
          (t !== undefined && /^[A-Za-z_$]/.test(t) && text(at + 1) === "=");
        if (!callback) dynamic = true;
      }
    } else {
      const first = tokens[at];
      if (text(at) === "[") readList(at);
      else if (first?.kind === "string" && text(at + 1) !== "+") {
        modules.push(first.value);
      } else dynamic = true;
    }
  }
  return { dynamic, modules: [...new Set(modules)] };
}

/** A pre-filled new-issue link asking for a module to be classified. It carries the module name and the package version only; the package never sends it. */
export const classifyIssueUrl = (module: string) => {
  const query = new URLSearchParams({
    body: `Module: ${module}\nPackage version: ${packageVersion}\n\nPlease classify this module as allowed or writing for a probe that does not write.`,
    title: `Classify ${module}`,
  });
  return `https://github.com/nemchik/suitescript-verify/issues/new?${query}`;
};

/** A module name safe to put in the issue link: a plain `N/` path. */
const linkable = /^N\/[A-Za-z0-9/]{1,60}$/;

const addTag = "add @writes (or a permission level above VIEW) to the probe";

/** What stops a probe that does not write from using the modules it imports. */
export function moduleProblems(
  slug: string,
  { dynamic, modules }: ProbeImports,
): string[] {
  const problems: string[] = [];
  for (const name of modules) {
    if (amdBuiltins.has(name)) continue;
    const kind = Object.hasOwn(moduleClasses, name)
      ? moduleClasses[name]
      : undefined;
    if (kind === "allowed") continue;
    if (kind === "writing") {
      problems.push(
        `${slug} imports ${name}, which can write, but declares neither @writes nor a @permission above VIEW. Either ${addTag}, or remove the import.`,
      );
    } else if (linkable.test(name)) {
      problems.push(
        `${slug} imports ${name}, which the package does not know, so it counts as writing. Ask the person to open this issue so the module can be classified (the package never posts it): ${classifyIssueUrl(name)}`,
      );
    } else {
      problems.push(
        `${slug} imports "${name}", which is not a known N/ module, and a probe that does not write may import only allowed N/ modules. Either ${addTag}, or remove the import.`,
      );
    }
  }
  if (dynamic) {
    problems.push(
      `${slug} names a module in define or require with a name that is not a literal string, so it cannot be checked. Write each module name as a string literal, or ${addTag}.`,
    );
  }
  return problems;
}
