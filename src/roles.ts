import { createHash } from "node:crypto";
import type { ProbePermission } from "./probes.ts";
import { UsageError } from "./shared.ts";

/**
 * The runner's role and the execution roles (ADR 0005): which permission sets
 * probes declare, the role each set runs under and the Suitelet host slot that
 * role is reached through. Later tickets extend this module: a probe's
 * `permissionSet` is where levels above VIEW or the scratch area's permissions
 * join the set, `planSlots` takes the probes that need a slot (a RESTlet
 * probe with a permission also goes through its set's slot), and
 * `slotCount` is the only limit on how many sets one deploy can hold.
 */

/** What the runner's role holds: logging in with a token and calling a RESTlet. Never a probe's permissions. */
export const runnerRolePermissions: readonly ProbePermission[] = [
  { level: "FULL", permkey: "ADMI_LOGIN_OAUTH2" },
  { level: "FULL", permkey: "ADMI_RESTWEBSERVICES" },
];

/**
 * The Suitelet host's deployment slots, `_s0` to `_s9`: a slot suffix is as
 * long as `_sl`, so a slot's id fits the platform's 40 characters with a runner
 * id of up to 24, which allows one digit.
 */
export const slotCount = 10;

/** The id of the host's deployment in slot `index`. */
export const slotDeploymentId = (runnerId: string, index: number) =>
  `customdeploy_${runnerId}_s${index}`;

const byKey = (a: ProbePermission, b: ProbePermission) =>
  a.permkey < b.permkey ? -1 : a.permkey > b.permkey ? 1 : 0;

/**
 * The permissions a probe runs with: what it declares, sorted by key. This is
 * the one place a later ticket adds to a probe's set.
 */
export const permissionSet = (probe: {
  permissions: ProbePermission[];
}): ProbePermission[] => [...probe.permissions].sort(byKey);

/** A set as one string, `KEY:LEVEL` per permission, sorted: the same set always gives the same text, and no set gives `""`. */
export const permissionSetKey = (set: ProbePermission[]) =>
  [...set]
    .sort(byKey)
    .map(({ level, permkey }) => `${permkey}:${level}`)
    .join(",");

/** An execution role: a role the deploy writes for one permission set. */
export interface ExecutionRole {
  /** The role's script id, `customrole_<runner id, up to 20 characters>_<hash>`: at most 40 characters. */
  id: string;
  /** The name shown in the account, at most 40 characters. */
  name: string;
  permissions: ProbePermission[];
}

/** The name prefix that marks a role as an execution role, so a later deploy can tell it from the runner's. */
export const executionRoleNamePrefix = "ssv exec ";

/**
 * The role for a permission set. Its id and name carry the first 8 hex digits
 * of a sha256 of the runner id and the set, so a changed set gets a new role,
 * the same set gets the same role, and two runners in one account never share one.
 */
export function executionRole(
  runnerId: string,
  set: ProbePermission[],
): ExecutionRole {
  const hash = createHash("sha256")
    .update(`${runnerId}\0${permissionSetKey(set)}`)
    .digest("hex")
    .slice(0, 8);
  return {
    id: `customrole_${runnerId.slice(0, 20)}_${hash}`,
    name: `${executionRoleNamePrefix}${hash} ${runnerId.slice(0, 22)}`,
    permissions: [...set].sort(byKey),
  };
}

/** A Suitelet host deployment and what it runs as. */
export interface Slot {
  /** The deployment's script id. */
  deploymentId: string;
  /** The slot's number, `_s<index>`. */
  index: number;
  /** The permission set text of the role the slot runs as (see `permissionSetKey`). */
  key: string;
  /** The slugs of the probes that go through this slot. */
  probes: string[];
  role: ExecutionRole;
  /** Whether a probe uses the slot: an unused one is switched off. */
  used: boolean;
}

/**
 * Assigns the probes' permission sets to the host's slots: each distinct set
 * once, in the order of its text, with the set of no permissions always first
 * (slot 0) so the host answers the self-check even with no probes. A set that
 * no probe declares leaves its slot unused, switched off and running as the
 * role of no permissions. More sets than slots is an error.
 */
export function planSlots(
  runnerId: string,
  probes: { permissions: ProbePermission[]; slug: string }[],
): { slots: Slot[]; slotOf: Map<string, Slot> } {
  const sets = new Map<string, { probes: string[]; set: ProbePermission[] }>([
    ["", { probes: [], set: [] }],
  ]);
  for (const probe of probes) {
    const set = permissionSet(probe);
    const key = permissionSetKey(set);
    const known = sets.get(key) ?? { probes: [], set };
    known.probes.push(probe.slug);
    sets.set(key, known);
  }
  const keys = [...sets.keys()].sort();
  if (keys.length > slotCount) {
    throw new UsageError(
      `The probes declare ${keys.length} different sets of permissions, and the Suitelet host has ${slotCount} slots. Share permissions between probes, or declare fewer sets.`,
    );
  }
  const empty = executionRole(runnerId, []);
  const slots: Slot[] = Array.from({ length: slotCount }, (_, index) => {
    const key = keys[index];
    const entry = key === undefined ? undefined : sets.get(key);
    return {
      deploymentId: slotDeploymentId(runnerId, index),
      index,
      key: key ?? "",
      probes: entry?.probes ?? [],
      role: entry ? executionRole(runnerId, entry.set) : empty,
      used: entry !== undefined,
    };
  });
  const slotOf = new Map<string, Slot>();
  for (const slot of slots) {
    for (const slug of slot.probes) slotOf.set(slug, slot);
  }
  return { slotOf, slots };
}
