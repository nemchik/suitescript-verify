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
 * the X-SSV-Mode header, which a probe cannot set (nor any X-SSV- header):
 * - `wrapped`: the probe made no response calls (or threw), and its returned
 *   value (or `THROWS: …`) is written as JSON;
 * - `own`: the probe made response calls and returned nothing, and they are
 *   replayed in order, with its headers also listed in X-SSV-Headers; a replayed call that fails switches the marker back to
 *   `wrapped` and writes `THROWS: …`;
 * - both is refused, as wrapped JSON.
 *
 * A probe whose `run()` returns a thenable is awaited, and judged once it
 * settles by the same rules: a rejection is `REJECTS: <name>: <message>` with
 * the recorded calls discarded. The recorder is sealed at settle, so a stray
 * call a continuation makes later is ignored. The host catches the rejection
 * itself, because an unhandled one from `onRequest` is said (unverified in a
 * sandbox) to give an HTTP 500 page that the execution log shows only as
 * `UNEXPECTED_ERROR`.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(["N/runtime" /*PROBE_PATHS*/], (runtime /*PROBE_NAMES*/) => {
  const probes = new Map([
    /*PROBE_ENTRIES*/
  ]);
  const MARKER = "X-SSV-Mode";
  /**
   * The host's report of the probe's own headers, for an `own` answer: the
   * runner's `ClientResponse.headers` keeps one value per name (the first), so
   * a second `addHeader` value or a probe's `Set-Cookie` behind the platform's
   * session cookie never reaches it otherwise.
   */
  const HEADERS = "X-SSV-Headers";
  /** The host's reading of its own remaining units, for an `own` answer: `{ before, after }` as JSON. */
  const USAGE = "X-SSV-Usage";
  /** Every `X-SSV-` header is the host's; a probe cannot set one. */
  const RESERVED = /^x-ssv-/i;

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
   * A response that records every write, page, file and header call for
   * replay, and answers header reads from what it recorded. It refuses every
   * X-SSV- header, so a probe cannot choose how the runner reads its answer,
   * and refuses a redirect: `requestSuitelet` follows it, so the runner would
   * see the page it leads to (often the login page), never the redirect. Once
   * sealed, it ignores every call, so nothing lands while the host replays.
   */
  const recorder = () => {
    const calls = [];
    const headers = {};
    let sealed = false;
    const record = (method) => (options) => {
      if (sealed) return;
      calls.push([method, options]);
    };
    const header = (method, replace) => (options) => {
      if (sealed) return;
      const name = headerName(options);
      if (RESERVED.test(name)) {
        const e = new Error(
          `the probe cannot set ${name}: X-SSV- headers (${MARKER}, ${HEADERS}, ${USAGE}) are the host's`,
        );
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
      sendRedirect: () => {
        const e = new Error(
          "a Suitelet probe cannot redirect: requestSuitelet follows redirects, so the runner never sees one",
        );
        e.name = "SSV_REDIRECT_REFUSED";
        throw e;
      },
      setCdnCacheable: record("setCdnCacheable"),
      setHeader: header("setHeader", true),
      write: record("write"),
      writeFile: record("writeFile"),
      writeLine: record("writeLine"),
      writePage: record("writePage"),
    });
    /** The recorded headers as the response ends up with them, in order: `{ name, value }` per value. */
    const list = () =>
      Object.keys(headers).flatMap((name) =>
        [].concat(headers[name]).map((value) => ({
          name,
          value: String(value),
        })),
      );
    /** Ends recording: a call made after this (a stray continuation) is ignored. */
    const seal = () => {
      sealed = true;
    };
    return { calls, headers: list, response, seal };
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

  /** What the deploy baked in: the package version, the build fingerprint (shared with the runner) and this host's probes. */
  const deployment = {
    build: "%%BUILD%%",
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
      // Usage is information only: this host's units just before the probe's
      // run() and just after it (once a returned Promise settles). Reads cost nothing.
      const before = runtime.getCurrentScript().getRemainingUsage();
      let result;
      let caught;
      try {
        result = probe.run(checked.params, {
          request: view,
          response: recorded.response,
        });
      } catch (e) {
        result = `THROWS: ${e.name}: ${e.message}`;
        recorded.calls.length = 0;
        caught = e;
      }
      const finish = (result) => {
        recorded.seal();
        const usage = usageEntry(
          before,
          runtime.getCurrentScript().getRemainingUsage(),
          caught,
        );
        if (recorded.calls.length > 0 && result !== undefined) {
          return answer(response, {
            error:
              "the probe both wrote a response and returned a value; a Suitelet probe does one or the other",
          });
        }
        const wrapped = (value) => {
          const lost = findLostAwait(value);
          return answer(
            response,
            lost === undefined
              ? {
                  probe: name,
                  result: value,
                  scriptType: "Suitelet",
                  usage,
                  version: String(runtime.version),
                }
              : {
                  error: lostAwait(lost),
                },
          );
        };
        if (recorded.calls.length === 0) return wrapped(result);
        response.setHeader({ name: MARKER, value: "own" });
        response.setHeader({ name: USAGE, value: JSON.stringify(usage) });
        try {
          // JSON with every non-ASCII character escaped, so it is a valid header value.
          response.setHeader({
            name: HEADERS,
            value: JSON.stringify(recorded.headers()).replace(
              /[\u007f-\uffff]/g,
              (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
            ),
          });
        } catch (_) {
          // The runner falls back to the platform's headers alone.
        }
        try {
          for (const [method, options] of recorded.calls) {
            response[method](options);
          }
        } catch (e) {
          // A replayed call the real response refuses ends the replay. The host
          // cannot take back what it already wrote, so it switches the marker to
          // `wrapped` and appends the `THROWS` answer: with nothing written yet
          // the runner reads a clean THROWS result, and after a write it reads
          // the partial output plus the answer as a body that is not JSON, which
          // it reports as an error, never as `own` output. The platform still
          // takes a header set after a write (confirmed in a sandbox).
          wrapped(`THROWS: ${e.name}: ${e.message}`);
        }
      };
      // A probe that returns a thenable is awaited and judged once it settles;
      // a synchronous one keeps its synchronous answer.
      if (isThenable(result)) {
        return Promise.resolve(result)
          .then(
            (value) => finish(value),
            (e) => {
              recorded.calls.length = 0;
              caught = e;
              return finish(rejection(e));
            },
          )
          .catch((e) => {
            // Answering failed (a result that cannot be serialized, say). Never
            // let it reject: that is an HTTP 500 page the runner cannot read.
            try {
              answer(response, {
                error: `the host could not answer after the probe settled: ${e?.name}: ${e?.message}`,
              });
            } catch (_) {
              // Nothing more can be written.
            }
          });
      }
      return finish(result);
    },
  };
});
