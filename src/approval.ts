import {
  aboveView,
  isRunnable,
  isWriting,
  listProbes,
  type Probe,
  permissionLevels,
} from "./probes.ts";

/**
 * The permission keys of the scratch area's custom records, which a writing
 * probe may hold above VIEW without it counting as a standard-record write.
 * Empty until the scratch area exists.
 */
const scratchPermissionKeys: ReadonlySet<string> = new Set();

/** The flag on a row whose permission is a standard record's, written above VIEW. */
export const standardWriteFlag = "standard-record write";

/** The flag on a row for a write that no permission shows. */
export const noPermissionFlag = "write with no permission";

/** A permission key that is a custom record's or the scratch area's, never a standard record's. */
const isOwnKey = (permkey: string) =>
  permkey.toLowerCase().startsWith("customrecord") ||
  scratchPermissionKeys.has(permkey);

/** One line of the writing-probe table. */
export interface WritingRow {
  flags: string[];
  /** The level, or `-` for a write no permission shows. */
  level: string;
  /** The permission key, or `-` for a write no permission shows. */
  permission: string;
  probe: string;
}

/** The probes a deploy would include that write (`@writes` or a level above VIEW). */
export const writingProbes = (probes: Probe[]) =>
  probes.filter(isRunnable).filter(isWriting);

/**
 * The table's rows: one per permission above VIEW, flagged when its key is not
 * a custom record's or the scratch area's, and one per `@writes` probe,
 * flagged as a write no permission shows.
 */
export function writingRows(probes: Probe[]): WritingRow[] {
  return writingProbes(probes).flatMap((probe) => [
    ...probe.permissions
      .filter((p) => aboveView(p.level))
      .map((p) => ({
        flags: isOwnKey(p.permkey) ? [] : [standardWriteFlag],
        level: p.level,
        permission: p.permkey,
        probe: probe.slug,
      })),
    ...(probe.writes
      ? [
          {
            flags: [noPermissionFlag],
            level: "-",
            permission: "-",
            probe: probe.slug,
          },
        ]
      : []),
  ]);
}

/**
 * The word the person types to approve a deploy: the highest level among the
 * writing probes, `FULL` > `EDIT` > `CREATE` > `WRITES` (only `@writes` probes
 * with nothing above VIEW) > `VIEW` (no writing probes).
 */
export function approvalWord(probes: Probe[]): string {
  const ranks = ["VIEW", "WRITES", "CREATE", "EDIT", "FULL"];
  const rank = (probe: Probe) =>
    Math.max(
      1,
      ...probe.permissions.map((p) =>
        aboveView(p.level) ? permissionLevels.indexOf(p.level) + 1 : 0,
      ),
    );
  return ranks[Math.max(0, ...writingProbes(probes).map(rank))] ?? "VIEW";
}

/** The writing-probe table as plain text, or a line saying there are none. */
export function formatWritingTable(probes: Probe[]): string {
  const rows = writingRows(probes);
  if (rows.length === 0) return "Writing probes: none.";
  const head = ["Probe", "Permission", "Level", "Flags"];
  const body = rows.map((r) => [
    r.probe,
    r.permission,
    r.level,
    r.flags.join("; "),
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [
    "Writing probes this deploy includes:",
    line(head),
    ...body.map(line),
  ].join("\n");
}

/** What a deploy's approval is for: the table, the word to type and what it covers. */
export function deployApproval(dir: string, extraTags: readonly string[]) {
  const probes = listProbes(dir, extraTags);
  const word = approvalWord(probes);
  return {
    included: writingProbes(probes).length > 0,
    table: formatWritingTable(probes),
    word,
  };
}
