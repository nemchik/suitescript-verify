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
 * status, headers (cookies redacted but `sv_*`) and body (cut at 64 KB).
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
  const BODY_LIMIT = 64 * 1024;

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

  /** The probe's own response as the runner reports it: no marker, cookies redacted, the body cut at 64 KB. */
  const ownResponse = (status, headers, text) => {
    const shown = {};
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === MARKER) continue;
      shown[key] =
        lower === "set-cookie" ? redactSetCookie(headers[key]) : headers[key];
    }
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

  /** Asks the Suitelet host to run a probe; a failed or unexpected answer is reported, never thrown. */
  const viaSuitelet = (name, params) => {
    let reply;
    try {
      reply = https.requestSuitelet({
        deploymentId: host.deploymentId,
        scriptId: host.scriptId,
        urlParams: { params: JSON.stringify(params), probe: name },
      });
    } catch (e) {
      const { message, name: kind } = e || {};
      return { error: `the Suitelet host call failed: ${kind}: ${message}` };
    }
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
        version: String(runtime.version),
      };
    }
    if (marker !== "wrapped") {
      return {
        error:
          status === 200
            ? `the Suitelet host answered HTTP 200 without its X-SSV-Mode header: ${cut(text)}`
            : `the Suitelet host answered HTTP ${status}: ${cut(text)}`,
      };
    }
    if (status !== 200) {
      return {
        error: `the Suitelet host answered HTTP ${status}: ${cut(text)}`,
      };
    }
    let answer;
    try {
      answer = JSON.parse(text);
    } catch (_) {
      answer = undefined;
    }
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      return { error: `the Suitelet host's answer was not JSON: ${cut(text)}` };
    }
    if (answer.error) {
      return { error: `the Suitelet host refused: ${cut(answer.error)}` };
    }
    return {
      probe: name,
      result: answer.result,
      scriptType: "Suitelet",
      version: String(runtime.version),
    };
  };

  /** What the deploy baked in: the package version, every probe and each permission written to the role. */
  const deployment = {
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
      let result;
      try {
        result = entry[0].run(checked.params);
      } catch (e) {
        result = `THROWS: ${e.name}: ${e.message}`;
      }
      return {
        probe: name,
        result,
        scriptType: "RESTlet",
        version: String(runtime.version),
      };
    },
  };
});
