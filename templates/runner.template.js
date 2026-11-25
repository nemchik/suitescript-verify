/**
 * The verification runner: a RESTlet that runs one probe by name and returns
 * what it found. It never runs code from the request: the probes below are
 * the only code it can run, and they are generated from the probes folder
 * into this file's dependency list by `suitescript-verify deploy`.
 *
 * A Suitelet probe runs in the Suitelet host deployed beside the runner, which
 * the runner calls from inside the account with `N/https.requestSuitelet`. The
 * runner knows each Suitelet probe's name and parameters, never its code.
 * The host's X-SSV-Mode header says how to read its answer: `wrapped` JSON
 * holding the probe's result, or the probe's `own` response, reported as its
 * status, headers (one lower-cased key per name: the platform's content
 * headers and every header the probe set, from the host's X-SSV-Headers, with
 * cookies but `sv_*`, credential-like values and file names redacted)
 * and body (NetSuite's trailing HTML comments dropped, cut at 64 KB).
 *
 * It refuses to run unless the account is a sandbox. A body with `selfCheck`
 * (never a probe name) asks for the self-check instead, which only reads.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/runtime", "N/https" /*PROBE_PATHS*/], (
  runtime,
  https /*PROBE_NAMES*/,
) => {
  const probes = new Map([
    /*PROBE_ENTRIES*/
  ]);
  const suitelets = new Map([
    /*SUITELET_ENTRIES*/
  ]);
  const host = {
    deploymentId: "%%SUITELET_DEPLOY_ID%%",
    scriptId: "%%SUITELET_SCRIPT_ID%%",
  };
  const cut = (text) => String(text).slice(0, 500);
  /** The host's header naming how to read its answer: `wrapped` JSON, or the probe's `own` response. */
  const MARKER = "x-ssv-mode";
  /** The host's list of the probe's own headers, for an `own` answer. */
  const HEADERS = "x-ssv-headers";
  /** The host's own headers, never reported. */
  const RESERVED = /^x-ssv-/;
  const BODY_LIMIT = 64 * 1024;

  /** The platform's headers that describe the content and stay the same from call to call: the only ones reported. */
  const PLATFORM_HEADERS = [
    "cache-control",
    "content-disposition",
    "content-encoding",
    "content-language",
    "content-type",
  ];
  /** A probe header whose name looks like a credential: its value is reported as `<redacted>`. */
  const CREDENTIAL =
    /^(authorization|proxy-authorization|cookie)$|token|secret|session|password|auth|key|csrf|sign|hmac|credential|nonce|jwt/;

  /** One Set-Cookie value with its value and attributes redacted, unless the cookie is the probe's own (`sv_*`). */
  const redactCookie = (cookie) => {
    const text = String(cookie);
    const name = text.split("=")[0].trim();
    return name.startsWith("sv_") ? text : `${name}=<redacted>`;
  };
  /** Redacts a Set-Cookie header, given as a list or as cookies joined with commas (a comma inside Expires is not a join). */
  const redactSetCookie = (value) =>
    Array.isArray(value)
      ? value.map(redactCookie)
      : String(value)
          .split(/,(?=\s*[^;,=\s]+=)/)
          .map((cookie) => redactCookie(cookie.trim()))
          .join(", ");
  /** A Content-Disposition with its `filename` and `filename*` values redacted: a file name can name a record or a customer. */
  const redactFileName = (value) =>
    String(value).replace(
      /(\bfilename\*?\s*=\s*)("(?:[^"\\]|\\.)*"|[^;]*)/gi,
      "$1<redacted>",
    );
  /** A header value as it may be committed: cookies but `sv_*`, credential-like values and file names redacted (by lower-cased name). */
  const safeValue = (lower, value) =>
    lower === "set-cookie"
      ? redactSetCookie(value)
      : lower === "content-disposition"
        ? redactFileName(value)
        : CREDENTIAL.test(lower)
          ? "<redacted>"
          : value;

  /**
   * The probe's own headers as the host reports them in X-SSV-Headers: a JSON
   * list of `{ name, value }`, in order. A missing or malformed report gives
   * none, and only the platform's allowlisted headers are reported rather
   * than failing the probe.
   */
  const recordedHeaders = (headers) => {
    const key = Object.keys(headers).find(
      (name) => name.toLowerCase() === HEADERS,
    );
    if (key === undefined) return [];
    let list;
    try {
      list = JSON.parse([].concat(headers[key])[0]);
    } catch (_) {
      return [];
    }
    return Array.isArray(list)
      ? list.filter((entry) => entry && typeof entry.name === "string")
      : [];
  };

  /**
   * One lower-cased key per header name, holding only what is safe to commit.
   * From the platform (`ClientResponse.headers`, several casings of each name)
   * only the allowlisted content headers; every other platform header,
   * cookies included, is dropped. Every header the probe set, from the host's
   * report, replaces the platform's values of that name. No X-SSV- header is
   * reported. Values are made safe, then repeated ones dropped; a name left
   * with one value keeps it, and one with several keeps them as a list.
   */
  const collapseHeaders = (headers) => {
    const values = {};
    const add = (lower, value) => {
      const list = values[lower] || [];
      const shown = safeValue(lower, value);
      if (!list.includes(shown)) list.push(shown);
      values[lower] = list;
    };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (!PLATFORM_HEADERS.includes(lower)) continue;
      for (const value of [].concat(headers[key])) add(lower, value);
    }
    const replaced = {};
    for (const { name, value } of recordedHeaders(headers)) {
      const lower = name.toLowerCase();
      if (RESERVED.test(lower)) continue;
      if (!replaced[lower]) {
        values[lower] = [];
        replaced[lower] = true;
      }
      add(lower, String(value));
    }
    const shown = {};
    for (const key of Object.keys(values)) {
      shown[key] = values[key].length === 1 ? values[key][0] : values[key];
    }
    return shown;
  };

  /** An HTML body without the `<!-- … -->` comments NetSuite appends to every page (they name the account and the user). */
  const stripTrailer = (headers, text) => {
    const type = String([].concat(headers["content-type"])[0]);
    if (!/^\s*text\/html\b/i.test(type)) return text;
    let body = text;
    let stripped = false;
    for (;;) {
      const trimmed = body.replace(/\s+$/, "");
      const start = trimmed.lastIndexOf("<!--");
      if (!trimmed.endsWith("-->") || start < 0) break;
      body = trimmed.slice(0, start);
      stripped = true;
    }
    return stripped ? body.replace(/\s+$/, "") : text;
  };

  /** The probe's own response as the runner reports it: no marker, one key per header, only headers safe to commit, NetSuite's HTML trailer dropped, the body cut at 64 KB. */
  const ownResponse = (status, headers, raw) => {
    const shown = collapseHeaders(headers);
    const text = stripTrailer(shown, raw);
    const response = {
      body: text.slice(0, BODY_LIMIT),
      headers: shown,
      status,
    };
    if (text.length > BODY_LIMIT) response.truncated = true;
    return response;
  };

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

  /** The USAGE header's name, lower-cased: the host's reading for an `own` answer. */
  const USAGE = "x-ssv-usage";

  /** A host's reading `{ before, after }` as finite numbers (and `exceeded` only when exactly true), or undefined: a malformed one is dropped, never trusted. */
  const hostReading = (value) =>
    value &&
    typeof value === "object" &&
    Number.isFinite(value.before) &&
    Number.isFinite(value.after)
      ? {
          after: value.after,
          before: value.before,
          ...(value.exceeded === true ? { exceeded: true } : {}),
        }
      : undefined;

  /** The host's reading from its X-SSV-Usage header (an `own` answer), or undefined. */
  const headerUsage = (headers) => {
    const key = Object.keys(headers).find(
      (name) => name.toLowerCase() === USAGE,
    );
    if (key === undefined) return undefined;
    try {
      return hostReading(JSON.parse([].concat(headers[key])[0]));
    } catch (_) {
      return undefined;
    }
  };

  /** Asks the Suitelet host to run a probe; a failed or unexpected answer is reported, never thrown. */
  const viaSuitelet = (name, params) => {
    // Usage is information only: this script's units just before and just
    // after the call, so the runner's entry includes the 10 units
    // requestSuitelet spends. The host's own reading is folded in beside it
    // when the host answered. The reads cost nothing.
    const before = runtime.getCurrentScript().getRemainingUsage();
    let reply;
    let after;
    try {
      reply = https.requestSuitelet({
        deploymentId: host.deploymentId,
        scriptId: host.scriptId,
        urlParams: { params: JSON.stringify(params), probe: name },
      });
    } catch (e) {
      const { message, name: kind } = e || {};
      after = runtime.getCurrentScript().getRemainingUsage();
      return {
        error: `the Suitelet host call failed: ${kind}: ${message}`,
        usage: { RESTlet: usageEntry(before, after, e) },
      };
    }
    after = runtime.getCurrentScript().getRemainingUsage();
    const usageOf = (reading) => ({
      ...(reading ? { Suitelet: reading } : {}),
      RESTlet: usageEntry(before, after),
    });
    const fail = (error) => ({ error, usage: usageOf() });
    const status = reply ? reply.code : undefined;
    const text = reply && reply.body !== undefined ? String(reply.body) : "";
    const headers = reply?.headers || {};
    const markerKey = Object.keys(headers).find(
      (key) => key.toLowerCase() === MARKER,
    );
    const marker =
      markerKey === undefined ? undefined : [].concat(headers[markerKey])[0];
    if (marker === "own") {
      return {
        probe: name,
        response: ownResponse(status, headers, text),
        scriptType: "Suitelet",
        usage: usageOf(headerUsage(headers)),
        version: String(runtime.version),
      };
    }
    if (marker !== "wrapped") {
      return fail(
        status === 200
          ? `the Suitelet host answered HTTP 200 without its X-SSV-Mode header (a followed redirect or a login page does this): ${cut(text)}`
          : `the Suitelet host answered HTTP ${status}: ${cut(text)}`,
      );
    }
    if (status !== 200) {
      return fail(`the Suitelet host answered HTTP ${status}: ${cut(text)}`);
    }
    let answer;
    try {
      answer = JSON.parse(text);
    } catch (_) {
      answer = undefined;
    }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      return fail(`the Suitelet host's answer was not JSON: ${cut(text)}`);
    }
    if (answer.error) {
      return fail(`the Suitelet host refused: ${cut(answer.error)}`);
    }
    return {
      probe: name,
      result: answer.result,
      scriptType: "Suitelet",
      usage: usageOf(hostReading(answer.usage)),
      version: String(runtime.version),
    };
  };

  /**
   * What the deploy baked in: the package version, the build fingerprint (a
   * hash of the generated scripts and probes, shared with the host), every
   * probe and each permission written to the role.
   */
  const deployment = {
    build: "%%BUILD%%",
    packageVersion: "%%PACKAGE_VERSION%%",
    permissions: "%%PERMISSIONS%%".split(",").filter(Boolean),
    probes: "%%PROBES%%".split(",").filter(Boolean),
  };

  /** The held level of a permission, by its name in `runtime.Permission`; a key it cannot read is reported, never thrown. */
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

  /** The Suitelet host's answer to its own self-check, or the error the call met. */
  const hostSelfCheck = () => {
    let reply;
    try {
      reply = https.requestSuitelet({
        deploymentId: host.deploymentId,
        scriptId: host.scriptId,
        urlParams: { selfCheck: "1" },
      });
    } catch (e) {
      const { message, name: kind } = e || {};
      return { error: `the Suitelet host call failed: ${kind}: ${message}` };
    }
    const status = reply ? reply.code : undefined;
    const text = reply && reply.body !== undefined ? String(reply.body) : "";
    if (status !== 200) {
      return {
        error: `the Suitelet host answered HTTP ${status}: ${cut(text)}`,
      };
    }
    let answer;
    try {
      answer = JSON.parse(text);
    } catch (_) {
      return { error: `the Suitelet host's answer was not JSON: ${cut(text)}` };
    }
    if (!answer || typeof answer.selfCheck !== "object" || !answer.selfCheck) {
      return { error: `the Suitelet host has no self-check: ${cut(text)}` };
    }
    return answer.selfCheck;
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
   * undefined. A nested Promise always serializes as `{}`, so it is never a
   * meaningful value: it means a probe forgot to await. The result itself is
   * not checked, since the caller has awaited it. A path reads `page.items[1].cursor`;
   * a cycle is visited once. The Suitelet host keeps its own copy (separately
   * deployed scripts); a test fails if the copies drift apart.
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

  /** The reserved self-check: proves the deployment, its role and the host without running a probe. */
  const selfCheck = () => {
    if (runtime.envType !== runtime.EnvType.SANDBOX) {
      return { selfCheck: { sandbox: false } };
    }
    const user = runtime.getCurrentUser();
    const permissions = {};
    for (const name of deployment.permissions) {
      permissions[name] = heldLevel(user, name);
    }
    return {
      selfCheck: {
        build: deployment.build,
        host: hostSelfCheck(),
        packageVersion: deployment.packageVersion,
        permissions,
        probes: deployment.probes,
        role: String(user.roleId),
        sandbox: true,
        version: String(runtime.version),
      },
    };
  };

  return {
    post(body) {
      if (body && body.selfCheck !== undefined) return selfCheck();
      if (runtime.envType !== runtime.EnvType.SANDBOX) {
        return { error: "refused: the runner only runs in a sandbox" };
      }
      const name = body && typeof body.probe === "string" ? body.probe : "";
      const entry = probes.get(name);
      const suitelet = suitelets.get(name);
      if (!entry && !suitelet) {
        return {
          error: "unknown probe",
          known: [...probes.keys(), ...suitelets.keys()],
        };
      }
      const checked = checkParams(body, entry ? entry[1] : suitelet);
      if (checked.error) return { error: checked.error };
      if (!entry) return viaSuitelet(name, checked.params);
      // Usage is information only: the units this script has left just before
      // the probe's run() and just after it (once a returned Promise settles).
      // The read costs nothing.
      const before = runtime.getCurrentScript().getRemainingUsage();
      const answer = (result, caught) => {
        const lost = findLostAwait(result);
        if (lost !== undefined) return { error: lostAwait(lost) };
        const after = runtime.getCurrentScript().getRemainingUsage();
        return {
          probe: name,
          result,
          scriptType: "RESTlet",
          usage: { RESTlet: usageEntry(before, after, caught) },
          version: String(runtime.version),
        };
      };
      let result;
      try {
        result = entry[0].run(checked.params);
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
