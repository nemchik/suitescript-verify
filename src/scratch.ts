import { maxTimeoutSeconds, type ProbePermission } from "./probes.ts";

/**
 * The scratch area (ADR 0005): a custom record type and a File Cabinet folder
 * for each runner id, where a writing probe keeps what it creates. The host
 * running a writing probe deletes a run's items when the probe finishes and
 * sweeps older ones at the start of each write run.
 */

/** The record type's script id, `customrecord_<runner id>_sc`: 40 characters at most for a runner id of up to 24. */
export const scratchRecordId = (runnerId: string) =>
  `customrecord_${runnerId}_sc`;

/** The folder's name inside the runner's own folder. */
export const scratchFolderName = "scratch";

/**
 * The file that makes the deploy create the scratch folder (SDF deploys a
 * folder through its files), also how the host finds the folder's id.
 */
export const scratchMarkerFile = "readme.txt";

/** The permission key a role needs for the File Cabinet folder: Documents and Files (the permission list has no per-folder key). */
export const scratchFolderPermissionKey = "LIST_FILECABINET";

/** The permissions every writing probe's set holds, whatever it declares: FULL on the scratch record type and the scratch folder. */
export const scratchPermissions = (runnerId: string): ProbePermission[] => [
  { level: "FULL", permkey: scratchRecordId(runnerId) },
  { level: "FULL", permkey: scratchFolderPermissionKey },
];

/** How much longer than the longest allowed timeout a scratch item must be before a write run sweeps it. */
export const scratchSweepMarginSeconds = 60;

/** A scratch item older than this is swept at the start of a write run: the longest `@timeout` a probe may declare, plus the margin. */
export const scratchMaxAgeSeconds =
  maxTimeoutSeconds + scratchSweepMarginSeconds;
