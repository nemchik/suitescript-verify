/** One script's governance units just before and just after the probe ran; `exceeded` only when it ran out. */
export type UsageEntry = { before: number; after: number; exceeded?: true };

/** The usage the runner reports: an entry per script type that ran the probe (`RESTlet`, `Suitelet`). */
export type Usage = Record<string, UsageEntry>;

/**
 * The runner's usage, keeping only what the runner itself would send: an
 * entry with finite `before` and `after` (and `exceeded` only when exactly
 * true). Anything else is dropped, so nothing unexpected is ever printed or
 * recorded. Scripts are in name order, as an expectation is sorted. Undefined when no entry is left.
 */
export function readUsage(value: unknown): Usage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const usage: Usage = {};
  for (const [script, entry] of Object.entries(value).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (entry === null || typeof entry !== "object") continue;
    const { before, after, exceeded } = entry as Record<string, unknown>;
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    usage[script] = {
      after: after as number,
      before: before as number,
      ...(exceeded === true ? { exceeded: true } : {}),
    };
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The script types whose usage entry says the script ran out of governance units, sorted. */
export const exceededScripts = (usage: Usage | undefined): string[] =>
  Object.entries(usage ?? {})
    .filter(([, entry]) => entry.exceeded === true)
    .map(([script]) => script)
    .sort();

/** The one-line warning for scripts that ran out of governance units, or undefined when none did. */
export function governanceWarning(usage: Usage | undefined) {
  const ranOut = exceededScripts(usage);
  return ranOut.length > 0
    ? `Warning: a script ran out of governance units (${ranOut.join(", ")}); the probe's output may be cut short.`
    : undefined;
}
