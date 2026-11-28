/**
 * The RESTlet host: runs one RESTlet probe that declares a permission, by name,
 * under the execution role of its permission set. The runner never calls it:
 * a Suitelet host slot does, with `N/https.requestRestlet`, after the runner
 * reached the slot with `requestSuitelet`. A RESTlet deployment cannot name a
 * role to run as, so it runs as the role of its caller, the slot's execution
 * role, and its audience is the execution roles of the sets its probes
 * declare.
 *
 * The slot tells it which slot forwarded the request, and it refuses a probe
 * whose set is not the set that slot runs as. It proves the role it runs under
 * by reporting `getPermission` for each key the probe declares (never
 * `roleId`), in every answer.
 *
 * It never runs code from the request: the probes below are the only code it
 * can run, generated from the probes folder into this file's dependency list
 * by `suitescript-verify deploy`. It refuses to run unless the account is a
 * sandbox, and checks the parameters again against each probe's declarations.
 *
 * A writing probe (`@writes`, or a level above VIEW) gets
 * `context.scratch = { recordType, folderId, prefix }` as the second argument
 * of `run` from the scratch area (`./scratch`, shared with the Suitelet host):
 * the host sweeps old scratch items before the run and, once the probe has
 * settled (returned, thrown or rejected), deletes every scratch record and file
 * named with the run's prefix, before it answers, and reports both in `scratch`.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/runtime" /*PROBE_PATHS*/, "./scratch"], (
  runtime /*PROBE_NAMES*/,
  scratch,
) => {
  /** Each probe: its module, its parameters, the text of its permission set, the keys it declares and whether it writes. */
  const probes = new Map([
    /*PROBE_ENTRIES*/
  ]);
  /** Each slot a probe uses: its deployment id (lower case) and the text of the permission set it runs as. */
  const slots = new Map([
    /*SLOT_ENTRIES*/
  ]);

  /** The declared parameters from the body, or an error. Parameters are data, never evaluated. */
  const checkParams = (body, declared) => {
    const sent = body.params === undefined ? {} : body.params;
    if (!sent || typeof sent !== "object" || Array.isArray(sent)) {
      return { error: "invalid params: expected an object" };
    }
    const params = {};
    for (const key of Object.keys(sent)) {
      if (!declared.some((param) => param.name === key)) {
        return { error: `undeclared param: ${key}` };
      }
    }
    for (const { name: key, pattern } of declared) {
      const value = sent[key];
      if (typeof value !== "string") {
        return { error: `missing or non-string param: ${key}` };
      }
      if (!new RegExp(`^(?:${pattern})$`, "u").test(value)) {
        return { error: `param does not match its pattern: ${key}` };
      }
      params[key] = value;
    }
    return { params };
  };

  /** Whether a value is a thenable (has a `then` method), such as a Promise; a throwing getter is not one. */
  const isThenable = (value) => {
    if (value === null) return false;
    if (typeof value !== "object" && typeof value !== "function") return false;
    try {
      return typeof value.then === "function";
    } catch (_) {
      return false;
    }
  };

  /**
   * The path to the first Promise (any thenable) nested in a result, or
   * undefined: the same check as the runner's (a copy: the two are deployed
   * as separate scripts, and a test fails if they drift apart), since a nested Promise always
   * serializes as `{}` and means a probe forgot to await. A path reads
   * `page.items[1].cursor`; a cycle is visited once.
   */
  const findLostAwait = (value, path = "", seen = new Set()) => {
    if (value === null || typeof value !== "object" || seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    for (const key of Object.keys(value)) {
      let child;
      try {
        child = value[key];
      } catch (_) {
        continue;
      }
      const at = Array.isArray(value)
        ? `${path}[${key}]`
        : path
          ? `${path}.${key}`
          : key;
      if (isThenable(child)) return at;
      const found = findLostAwait(child, at, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  /** What a rejection reports: `REJECTS: <name>: <message>` for an error, else the rejected value as text. */
  const rejection = (e) => {
    try {
      if (
        e !== null &&
        typeof e === "object" &&
        typeof e.name === "string" &&
        typeof e.message === "string"
      ) {
        return `REJECTS: ${e.name}: ${e.message}`;
      }
      return `REJECTS: ${String(e)}`;
    } catch (_) {
      return "REJECTS: (a value that cannot be shown)";
    }
  };
  /** A script's usage entry. `exceeded: true` is added when the caught error's `name` is SSS_USAGE_LIMIT_EXCEEDED (never parsed from text: a NetSuite error is not an Error) or the after reading is 0. */
  const usageEntry = (before, after, caught) => {
    let hit = false;
    try {
      hit =
        caught !== null &&
        typeof caught === "object" &&
        caught.name === "SSS_USAGE_LIMIT_EXCEEDED";
    } catch (_) {
      hit = false;
    }
    return hit || after === 0
      ? { after, before, exceeded: true }
      : { after, before };
  };
  const lostAwait = (path) => {
    return `the result holds a Promise that was not awaited at ${path}`;
  };

  /** The level the running role holds of a permission, by its name in `runtime.Permission`; a key it cannot read is reported, never thrown. */
  const heldLevel = (user, name) => {
    try {
      const held = user.getPermission({ name });
      const level = Object.keys(runtime.Permission).find(
        (key) => runtime.Permission[key] === held,
      );
      return level === undefined ? String(held) : level;
    } catch (e) {
      const { message, name: kind } = e || {};
      return `UNREADABLE: ${kind}: ${message}`;
    }
  };
  /** The execution role's levels for the keys a probe declares: what the role really holds, read with getPermission. */
  const levelsFor = (keys) => {
    const levels = {};
    let user;
    try {
      user = runtime.getCurrentUser();
    } catch (_) {
      user = undefined;
    }
    for (const key of keys) {
      levels[key] = user
        ? heldLevel(user, key)
        : "UNREADABLE: the current user is not available";
    }
    return levels;
  };

  return {
    post(body) {
      if (runtime.envType !== runtime.EnvType.SANDBOX) {
        return { error: "refused: the RESTlet host only runs in a sandbox" };
      }
      const name = body && typeof body.probe === "string" ? body.probe : "";
      const entry = probes.get(name);
      if (!entry) return { error: "unknown probe", known: [...probes.keys()] };
      const [probe, declared, set, keys, writing] = entry;
      const slot = String(body.slot === undefined ? "" : body.slot);
      if (slots.get(slot.toLowerCase()) !== set) {
        return {
          error:
            "refused: the probe's set of permissions does not match the slot it was reached through",
        };
      }
      const checked = checkParams(body, declared);
      if (checked.error) return { error: checked.error };
      let area;
      let swept;
      if (writing) {
        try {
          area = scratch.open();
          swept = area.sweep();
        } catch (e) {
          return {
            error: `the scratch area is not available: ${e?.name}: ${e?.message}`,
          };
        }
      }
      const levels = levelsFor(keys);
      // Usage is information only: this script's units just before the
      // probe's run() and just after it (once a returned Promise settles).
      const before = runtime.getCurrentScript().getRemainingUsage();
      const answer = (result, caught) => {
        const lost = findLostAwait(result);
        const usage = usageEntry(
          before,
          runtime.getCurrentScript().getRemainingUsage(),
          caught,
        );
        // Whatever happens next, the run's scratch items go now: the probe has settled.
        const report = area
          ? { scratch: { cleanup: area.cleanup(), sweep: swept } }
          : {};
        if (lost !== undefined) {
          return { error: lostAwait(lost), ...report, usage };
        }
        return {
          permissions: levels,
          probe: name,
          result,
          ...report,
          scriptType: "RESTlet",
          usage,
          version: String(runtime.version),
        };
      };
      let result;
      try {
        result = area
          ? probe.run(checked.params, { scratch: area.context })
          : probe.run(checked.params);
      } catch (e) {
        return answer(`THROWS: ${e.name}: ${e.message}`, e);
      }
      // Only a probe that returns a thenable gets a promise back: a synchronous
      // probe keeps its synchronous answer.
      if (!isThenable(result)) return answer(result);
      return Promise.resolve(result).then(answer, (e) =>
        answer(rejection(e), e),
      );
    },
  };
});
