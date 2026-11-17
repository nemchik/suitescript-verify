/**
 * The Suitelet host: runs one Suitelet probe by name when the suitescript-verify
 * runner asks. Its deployment is never available without login and is limited
 * to the runner's role, and the runner calls it from inside the account with
 * `N/https.requestSuitelet`.
 *
 * It never runs code from the request: the probes below are the only code it
 * can run, generated from the probes folder into this file's dependency list
 * by `suitescript-verify deploy`. It refuses to run unless the account is a
 * sandbox, and checks the parameters again against each probe's declarations.
 * A request with `selfCheck` (never a probe name) asks for its self-check,
 * which only reads.
 *
 * A probe gets `run(params, context)`: a request view of only the method and
 * its declared parameters, and a response that records every call and replays
 * nothing until the probe returns. The host then answers in one mode, named by
 * the X-SSV-Mode header, which a probe cannot set:
 * - `wrapped`: the probe made no response calls (or threw), and its returned
 *   value (or `THROWS: …`) is written as JSON;
 * - `own`: the probe made response calls and returned nothing, and they are
 *   replayed in order;
 * - both is refused, as wrapped JSON.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(["N/runtime" /*PROBE_PATHS*/], (runtime /*PROBE_NAMES*/) => {
  const probes = new Map([
    /*PROBE_ENTRIES*/
  ]);
  const MARKER = "X-SSV-Mode";

  const answer = (response, body) => {
    response.setHeader({ name: MARKER, value: "wrapped" });
    response.setHeader({ name: "Content-Type", value: "application/json" });
    response.write({ output: JSON.stringify(body) });
  };

  /** The declared parameters, from the JSON the runner sent, or an error. Parameters are data, never evaluated. */
  const checkParams = (text, declared) => {
    let sent;
    try {
      sent = text === undefined || text === "" ? {} : JSON.parse(text);
    } catch (_) {
      return { error: "invalid params: expected a JSON object" };
    }
    if (!sent || typeof sent !== "object" || Array.isArray(sent)) {
      return { error: "invalid params: expected a JSON object" };
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

  const headerName = (options) =>
    String(options && options.name !== undefined ? options.name : "").trim();

  /**
   * A response that records every write, page, file, redirect and header call
   * for replay, and answers header reads from what it recorded. It refuses the
   * marker header, so a probe cannot choose how the runner reads its answer.
   */
  const recorder = () => {
    const calls = [];
    const headers = {};
    const record = (method) => (options) => {
      calls.push([method, options]);
    };
    const header = (method, replace) => (options) => {
      const name = headerName(options);
      if (name.toLowerCase() === MARKER.toLowerCase()) {
        const e = new Error(`the probe cannot set the ${MARKER} header`);
        e.name = "SSV_RESERVED_HEADER";
        throw e;
      }
      const value = options.value;
      const key =
        Object.keys(headers).find(
          (known) => known.toLowerCase() === name.toLowerCase(),
        ) || name;
      if (replace || headers[key] === undefined) {
        headers[key] = value;
      } else {
        headers[key] = [].concat(headers[key], value);
      }
      calls.push([method, options]);
    };
    const response = Object.freeze({
      addHeader: header("addHeader", false),
      getHeader: (options) => {
        const name = headerName(options).toLowerCase();
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
        return key === undefined ? null : headers[key];
      },
      get headers() {
        return { ...headers };
      },
      renderPdf: record("renderPdf"),
      sendRedirect: record("sendRedirect"),
      setCdnCacheable: record("setCdnCacheable"),
      setHeader: header("setHeader", true),
      write: record("write"),
      writeFile: record("writeFile"),
      writeLine: record("writeLine"),
      writePage: record("writePage"),
    });
    return { calls, response };
  };

  /** What the deploy baked in: the package version and this host's probes. */
  const deployment = {
    packageVersion: "%%PACKAGE_VERSION%%",
    probes: "%%PROBES%%".split(",").filter(Boolean),
  };

  return {
    onRequest({ request, response }) {
      if (request.parameters?.selfCheck !== undefined) {
        const sandbox = runtime.envType === runtime.EnvType.SANDBOX;
        return answer(response, {
          selfCheck: sandbox ? { ...deployment, sandbox } : { sandbox },
        });
      }
      if (runtime.envType !== runtime.EnvType.SANDBOX) {
        return answer(response, {
          error: "refused: the Suitelet host only runs in a sandbox",
        });
      }
      const sent = request.parameters || {};
      const name = typeof sent.probe === "string" ? sent.probe : "";
      const entry = probes.get(name);
      if (!entry) {
        return answer(response, {
          error: "unknown probe",
          known: [...probes.keys()],
        });
      }
      const [probe, declared] = entry;
      const checked = checkParams(sent.params, declared);
      if (checked.error) return answer(response, { error: checked.error });
      const recorded = recorder();
      const view = Object.freeze({
        method: request.method,
        parameters: Object.freeze({ ...checked.params }),
      });
      let result;
      try {
        result = probe.run(checked.params, {
          request: view,
          response: recorded.response,
        });
      } catch (e) {
        result = `THROWS: ${e.name}: ${e.message}`;
        recorded.calls.length = 0;
      }
      if (recorded.calls.length > 0 && result !== undefined) {
        return answer(response, {
          error:
            "the probe both wrote a response and returned a value; a Suitelet probe does one or the other",
        });
      }
      if (recorded.calls.length === 0) {
        return answer(response, {
          probe: name,
          result,
          scriptType: "Suitelet",
          version: String(runtime.version),
        });
      }
      response.setHeader({ name: MARKER, value: "own" });
      for (const [method, options] of recorded.calls) {
        response[method](options);
      }
    },
  };
});
