import { parseEnv } from "./config.ts";

/** The variables `env set` accepts. The passkey has its own command, layout keys live in the committed `.env`. */
export const envNames = [
  "SUITESCRIPT_VERIFY_ACCOUNT",
  "SUITESCRIPT_VERIFY_CLIENT_ID",
  "SUITESCRIPT_VERIFY_CERTIFICATE_ID",
  "SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH",
  "SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID",
  "SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH",
  "SUITESCRIPT_VERIFY_DOMAIN",
] as const;

const header =
  "# Local credentials for suitescript-verify. This file is gitignored.\n# Do not commit it and do not copy these values elsewhere.\n";

/** Forward slashes keep a Windows path valid inside a dotenv file. */
export const envValue = (value: string) => {
  const normalized = value.replace(/\\/g, "/");
  if (!/[\s#"']/.test(normalized)) return normalized;
  // The reader does not unescape, so quote with a character the value lacks.
  if (!normalized.includes('"')) return `"${normalized}"`;
  if (!normalized.includes("'")) return `'${normalized}'`;
  throw new Error("A value can not contain both kinds of quote.");
};

export interface EnvPlan {
  /** Already set to a different value: the person decides. */
  conflicts: string[];
  /** Not set yet. */
  fresh: string[];
  /** Already set to this value. */
  same: string[];
}

export function planEnvUpdate(
  text: string,
  entries: Record<string, string>,
): EnvPlan {
  const current = parseEnv(text);
  const plan: EnvPlan = { conflicts: [], fresh: [], same: [] };
  for (const [name, value] of Object.entries(entries)) {
    const existing = current.get(name);
    if (existing === undefined || existing === "") plan.fresh.push(name);
    else if (existing === value.replace(/\\/g, "/") || existing === value) {
      plan.same.push(name);
    } else plan.conflicts.push(name);
  }
  return plan;
}

/** Writes the entries, replacing a conflicting value only if its name is in `overwrite`. */
export function applyEnvUpdate(
  text: string,
  entries: Record<string, string>,
  overwrite: ReadonlySet<string>,
): string {
  const plan = planEnvUpdate(text, entries);
  const write = new Set([
    ...plan.fresh,
    ...plan.conflicts.filter((name) => overwrite.has(name)),
  ]);
  let out = text === "" ? header : text;
  for (const name of write) {
    const line = `${name}=${envValue(entries[name] ?? "")}`;
    const pattern = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=).*$`, "m");
    out = pattern.test(out)
      ? out.replace(pattern, () => line)
      : `${out.endsWith("\n") ? out : `${out}\n`}${line}\n`;
  }
  return out;
}
