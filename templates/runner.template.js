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
      const probe = probes.get(name);
      if (!probe) {
        return { error: "unknown probe", known: [...probes.keys()] };
      }
      let result;
      try {
        result = probe.run();
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
