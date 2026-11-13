/**
 * The verification runner: a RESTlet that runs one probe by name and returns
 * what it found. It never runs code from the request: the probes below are
 * the only code it can run, and they are generated from the probes folder
 * into this file's dependency list by `suitescript-verify deploy`.
 *
 * It refuses to run unless the account is a sandbox.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(["N/runtime" /*PROBE_PATHS*/], (runtime /*PROBE_NAMES*/) => {
  const probes = new Map([
    /*PROBE_ENTRIES*/
  ]);

  return {
    post(body) {
      if (runtime.envType !== runtime.EnvType.SANDBOX) {
        return { error: "refused: the runner only runs in a sandbox" };
      }
      const name = body && typeof body.probe === "string" ? body.probe : "";
      const entry = probes.get(name);
      if (!entry) {
        return { error: "unknown probe", known: [...probes.keys()] };
      }
      const [probe, declared] = entry;
      // Parameters are data: only declared names, only strings that match the
      // declared pattern in full, and never evaluated.
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
      let result;
      try {
        result = probe.run(params);
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
