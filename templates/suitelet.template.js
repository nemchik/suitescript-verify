/**
 * The Suitelet host: runs one Suitelet probe by name when the suitescript-verify
 * runner asks, and answers with what it found as JSON. Its deployment is never
 * available without login and is limited to the runner's role, and the runner
 * calls it from inside the account with `N/https.requestSuitelet`.
 *
 * It never runs code from the request: the probes below are the only code it
 * can run, generated from the probes folder into this file's dependency list
 * by `suitescript-verify deploy`. It refuses to run unless the account is a
 * sandbox, and checks the parameters again against each probe's declarations.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(["N/runtime" /*PROBE_PATHS*/], (runtime /*PROBE_NAMES*/) => {
  const probes = new Map([
    /*PROBE_ENTRIES*/
  ]);

  const answer = (response, body) => {
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

  return {
    onRequest({ request, response }) {
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
      let result;
      try {
        result = probe.run(checked.params);
      } catch (e) {
        result = `THROWS: ${e.name}: ${e.message}`;
      }
      return answer(response, {
        probe: name,
        result,
        scriptType: "Suitelet",
        version: String(runtime.version),
      });
    },
  };
});
