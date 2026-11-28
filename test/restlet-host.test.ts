import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

/**
 * RESTlet probes that declare a permission run runner -> slot -> RESTlet host.
 * Driven through the built CLI in a temporary project with a fake SuiteCloud
 * CLI and fake `N/` modules, like run-probe.test.ts.
 */
const root = join(import.meta.dirname, "..");
const bin = join(root, "dist", "bin", "suitescript-verify.js");
const fake = pathToFileURL(
  join(import.meta.dirname, "fixtures", "fake-netsuite.mjs"),
).href;
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { force: true, recursive: true });
});

const write = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

const probeSource = (tags: string[]) =>
  `/**\n * A probe.\n *\n * @NApiVersion 2.1\n${tags.map((t) => ` * ${t}`).join("\n")}\n */\ndefine([], () => ({ run() { return { ok: true }; } }));\n`;

const fakeCli = (dir: string) => `const fs = require("node:fs");
const path = require("node:path");
const cabinet = path.join(process.cwd(), "src", "FileCabinet");
const objects = path.join(process.cwd(), "src", "Objects");
const list = (d) =>
  fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String) : [];
const read = (suffix) => list(cabinet)
  .filter((f) => f.endsWith(suffix))
  .map((f) => fs.readFileSync(path.join(cabinet, f), "utf8"));
fs.writeFileSync(${JSON.stringify(join(dir, "calls.json"))}, JSON.stringify({
  files: list(cabinet),
  objects: list(objects).map((f) => fs.readFileSync(path.join(objects, f), "utf8")),
  restletHost: read("restlethost.js"),
  runner: read("restlet.js"),
  suitelet: read("suitelet.js"),
}));`;

type Project = {
  dir: string;
  env: Record<string, string>;
  requests: () => { body: string; url: string }[];
  script: (token: unknown, restlet: unknown) => void;
};

function project(): Project {
  const dir = mkdtempSync(join(tmpdir(), "suitescript-verify-rh-"));
  temps.push(dir);
  write(
    dir,
    "node_modules/@oracle/suitecloud-cli/src/suitecloud.js",
    fakeCli(dir),
  );
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const keyPath = join(dir, "runner-private.pem");
  writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  const scriptFile = join(dir, "fake-netsuite.json");
  const logFile = join(dir, "requests.log");
  writeFileSync(scriptFile, "{}");
  for (const sub of ["verification/sdf", "verification/probes"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return {
    dir,
    env: {
      FAKE_NETSUITE_LOG: logFile,
      FAKE_NETSUITE_SCRIPT: scriptFile,
      NODE_OPTIONS: `--import=${fake}`,
      SUITESCRIPT_VERIFY_ACCOUNT: "1234567_SB1",
      SUITESCRIPT_VERIFY_CERTIFICATE_ID: "cert-runner-id",
      SUITESCRIPT_VERIFY_CLIENT_ID: "client-id-0001",
      SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH: keyPath,
      SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID: "cert-sdf-id",
      SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH: join(dir, "sdf-private.pem"),
    },
    requests: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
    script: (token, restlet) =>
      writeFileSync(scriptFile, JSON.stringify({ restlet, token })),
  };
}

function cli(p: Project, args: string[]) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.SUITECLOUD_CLI_ACCEPT_LICENSE;
  for (const name of Object.keys(base)) {
    if (name.startsWith("SUITESCRIPT_VERIFY_")) delete base[name];
  }
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: p.dir,
    encoding: "utf8",
    env: { ...base, ...p.env },
    input: "",
  });
  return {
    all: `${result.stdout}${result.stderr}`,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

const calls = (p: Project) =>
  JSON.parse(readFileSync(join(p.dir, "calls.json"), "utf8")) as {
    files: string[];
    objects: string[];
    restletHost: string[];
    runner: string[];
    suitelet: string[];
  };

function load<T>(source: string, ...modules: unknown[]): T {
  let factory: ((...m: unknown[]) => T) | undefined;
  new Function("define", source)((_deps: string[], f: typeof factory) => {
    factory = f;
  });
  if (!factory) throw new Error("no define");
  return factory(...modules);
}

const restlet = "@scriptType Restlet";
const gated = [restlet, "@permission LIST_CUSTJOB VIEW"];
const slot = (index: number) => `customdeploy_suitescript_verify_s${index}`;
const sandbox = {
  EnvType: { PRODUCTION: "PRODUCTION", SANDBOX: "SANDBOX" },
  envType: "SANDBOX",
  Permission: { CREATE: 2, EDIT: 3, FULL: 4, NONE: 0, VIEW: 1 },
  version: "2026.2",
};
const runtimeAt = (
  deploymentId: string,
  held: Record<string, number> = {},
) => ({
  ...sandbox,
  getCurrentScript: () => ({ deploymentId, getRemainingUsage: () => 5000 }),
  getCurrentUser: () => ({
    getPermission: ({ name }: { name: string }) => held[name] ?? 0,
    roleId: "customrole_whatever",
  }),
});

const objectOf = (p: Project, scriptId: string) =>
  calls(p).objects.find((o) => o.includes(`scriptid="${scriptId}"`)) ?? "";

describe("deploy writes the RESTlet host", () => {
  it("generates the script and deployment, listing the probes it runs, with an audience of the execution roles that call it", () => {
    const p = project();
    write(p.dir, "verification/probes/plain.js", probeSource([restlet]));
    write(p.dir, "verification/probes/seen.js", probeSource(gated));
    write(
      p.dir,
      "verification/probes/page.js",
      probeSource(["@scriptType Suitelet", "@permission LIST_EMPLOYEE VIEW"]),
    );
    const result = cli(p, ["deploy"]);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /Probes in the runner: plain\n/);
    assert.match(result.stdout, /Probes in the RESTlet host: seen\n/);
    const call = calls(p);
    assert.ok(call.files.some((f) => f.endsWith("restlethost.js")));
    const xml = objectOf(p, "customscript_suitescript_verify_rh");
    assert.match(
      xml,
      /<restlet scriptid="customscript_suitescript_verify_rh">/,
    );
    assert.match(xml, /scriptid="customdeploy_suitescript_verify_rh"/);
    assert.match(xml, /<isdeployed>T<\/isdeployed>/);
    assert.doesNotMatch(xml, /<runasrole>|<allroles>T/);
    // Only the role of the slot the RESTlet probe goes through, never the Suitelet probe's or the runner's.
    const audience = /<audslctrole>([^<]*)<\/audslctrole>/.exec(xml)?.[1] ?? "";
    assert.match(audience, /^\[customrole_suitescript_verify_[0-9a-f]{8}\]$/);
    assert.doesNotMatch(audience, /^\[customrole_suitescript_verify\]$/);
    // The runner holds only RESTlet probes with no permission, and no code of a hosted probe.
    assert.doesNotMatch(call.runner.join(""), /probes\/seen/);
    assert.match(call.restletHost.join(""), /probes\/seen/);
    assert.doesNotMatch(call.restletHost.join(""), /probes\/(plain|page)/);
  });

  it("is switched off in cleanup", () => {
    const p = project();
    write(p.dir, "verification/probes/seen.js", probeSource(gated));
    assert.equal(cli(p, ["deploy"]).status, 0);
    const cleanup = cli(p, ["cleanup"]);
    assert.equal(cleanup.status, 0, cleanup.all);
    const xml = objectOf(p, "customscript_suitescript_verify_rh");
    assert.match(xml, /<isdeployed>F<\/isdeployed>/);
  });

  it("is off, with the runner's role as its audience, when no RESTlet probe declares a permission", () => {
    const p = project();
    write(p.dir, "verification/probes/plain.js", probeSource([restlet]));
    assert.equal(cli(p, ["deploy"]).status, 0);
    const xml = objectOf(p, "customscript_suitescript_verify_rh");
    assert.match(xml, /<isdeployed>F<\/isdeployed>/);
    assert.match(xml, /<audslctrole>\[customrole_suitescript_verify\]</);
  });
});

describe("the runner sends a RESTlet probe with a permission to its slot", () => {
  const deployed = (p: Project) => {
    write(p.dir, "verification/probes/plain.js", probeSource([restlet]));
    write(
      p.dir,
      "verification/probes/seen.js",
      probeSource([...gated, "@param id ^[0-9]+$"]),
    );
    assert.equal(cli(p, ["deploy"]).status, 0);
    return calls(p).runner.join("");
  };
  type Runner = { post: (b: unknown) => Record<string, unknown> };

  it("calls its set's slot with requestSuitelet, reports it as a RESTlet probe and all three scripts' usage", () => {
    const p = project();
    const seen: unknown[] = [];
    const runner = load<Runner>(
      deployed(p),
      {
        ...runtimeAt("x"),
        getCurrentScript: () => ({ getRemainingUsage: () => 5000 }),
      },
      {
        requestSuitelet: (options: unknown) => {
          seen.push(options);
          return {
            body: JSON.stringify({
              permissions: { LIST_CUSTJOB: "VIEW" },
              restletUsage: { after: 4000, before: 4990 },
              result: { ok: 1 },
              usage: { after: 900, before: 1000 },
            }),
            code: 200,
            headers: { "x-ssv-mode": "wrapped" },
          };
        },
      },
      { run: () => "in the runner" },
    );
    assert.deepEqual(runner.post({ params: { id: "7" }, probe: "seen" }), {
      permissions: { LIST_CUSTJOB: "VIEW" },
      probe: "seen",
      result: { ok: 1 },
      scriptType: "RESTlet",
      usage: {
        RESTlet: { after: 5000, before: 5000 },
        "RESTlet host": { after: 4000, before: 4990 },
        Suitelet: { after: 900, before: 1000 },
      },
      version: "2026.2",
    });
    assert.deepEqual(seen, [
      {
        deploymentId: slot(1),
        scriptId: "customscript_suitescript_verify_sl",
        urlParams: { params: JSON.stringify({ id: "7" }), probe: "seen" },
      },
    ]);
  });

  it("still runs a RESTlet probe with no permission in the runner, never through the host", () => {
    const p = project();
    let calledHost = 0;
    const runner = load<Runner>(
      deployed(p),
      {
        ...runtimeAt("x"),
        getCurrentScript: () => ({ getRemainingUsage: () => 5000 }),
      },
      {
        requestSuitelet: () => {
          calledHost++;
          return { body: "{}", code: 200 };
        },
      },
      { run: () => "in the runner" },
    );
    const answer = runner.post({ probe: "plain" });
    assert.equal(answer.result, "in the runner");
    assert.equal(calledHost, 0);
  });

  it("reports the RESTlet host's refusal with the usage of the scripts that took part", () => {
    const p = project();
    const runner = load<Runner>(
      deployed(p),
      {
        ...runtimeAt("x"),
        getCurrentScript: () => ({ getRemainingUsage: () => 5000 }),
      },
      {
        requestSuitelet: () => ({
          body: JSON.stringify({
            error: "the RESTlet host refused: unknown probe",
            restletUsage: { after: 1, before: 2 },
            usage: { after: 3, before: 4 },
          }),
          code: 200,
          headers: { "x-ssv-mode": "wrapped" },
        }),
      },
      {},
    );
    const answer = runner.post({ params: { id: "7" }, probe: "seen" });
    assert.equal(
      answer.error,
      "the Suitelet host refused: the RESTlet host refused: unknown probe",
    );
    assert.deepEqual(Object.keys(answer.usage as object).sort(), [
      "RESTlet",
      "RESTlet host",
      "Suitelet",
    ]);
  });
});

describe("the Suitelet host forwards to the RESTlet host", () => {
  type Host = { onRequest: (c: unknown) => unknown };
  const deployed = (p: Project) => {
    write(p.dir, "verification/probes/plain.js", probeSource([restlet]));
    write(
      p.dir,
      "verification/probes/seen.js",
      probeSource([...gated, "@param id ^[0-9]+$"]),
    );
    assert.equal(cli(p, ["deploy"]).status, 0);
    return calls(p).suitelet.join("");
  };
  const ask = (
    source: string,
    deploymentId: string,
    requestRestlet: (o: unknown) => unknown,
    parameters: Record<string, string>,
  ) => {
    const written: string[] = [];
    load<Host>(source, runtimeAt(deploymentId), { requestRestlet }).onRequest({
      request: { method: "GET", parameters },
      response: {
        setHeader: () => undefined,
        write: (o: { output: string }) => written.push(o.output),
      },
    });
    return JSON.parse(written.join(""));
  };
  const asked = { params: JSON.stringify({ id: "7" }), probe: "seen" };

  it("calls requestRestlet with the probe, its parameters and its own slot, and answers with the result, the role's levels and both readings", () => {
    const p = project();
    const seen: { body: string; scriptId: string; deploymentId: string }[] = [];
    const answer = ask(
      deployed(p),
      slot(1),
      (o) => {
        seen.push(o as (typeof seen)[number]);
        return {
          body: JSON.stringify({
            permissions: { LIST_CUSTJOB: "VIEW" },
            result: { ok: 1 },
            usage: { after: 4000, before: 4990 },
          }),
          code: 200,
        };
      },
      asked,
    );
    assert.equal(seen[0]?.scriptId, "customscript_suitescript_verify_rh");
    assert.equal(seen[0]?.deploymentId, "customdeploy_suitescript_verify_rh");
    assert.deepEqual(JSON.parse(seen[0]?.body ?? ""), {
      params: { id: "7" },
      probe: "seen",
      slot: slot(1),
    });
    assert.deepEqual(answer.permissions, { LIST_CUSTJOB: "VIEW" });
    assert.deepEqual(answer.result, { ok: 1 });
    assert.deepEqual(answer.restletUsage, { after: 4000, before: 4990 });
    assert.deepEqual(answer.usage, { after: 5000, before: 5000 });
  });

  it("refuses a probe reached through a slot that does not run as its set, without calling the RESTlet host", () => {
    const p = project();
    let called = 0;
    const answer = ask(
      deployed(p),
      slot(0),
      () => {
        called++;
        return { body: "{}", code: 200 };
      },
      asked,
    );
    assert.match(answer.error, /does not match the slot/);
    assert.equal(called, 0);
  });

  it("checks parameters before calling, and reports a failed call, a bad status and a refusal, never throwing", () => {
    const p = project();
    const source = deployed(p);
    let called = 0;
    const never = () => {
      called++;
      return { body: "{}", code: 200 };
    };
    assert.match(
      ask(source, slot(1), never, { params: '{"id":"x"}', probe: "seen" })
        .error,
      /param/,
    );
    assert.equal(called, 0);
    const failing = ask(
      source,
      slot(1),
      () => {
        throw Object.assign(new Error("no luck"), { name: "SSS_X" });
      },
      asked,
    );
    assert.equal(failing.error, "the RESTlet host call failed: SSS_X: no luck");
    assert.match(
      ask(source, slot(1), () => ({ body: "oops", code: 500 }), asked).error,
      /answered HTTP 500: oops/,
    );
    assert.equal(
      ask(
        source,
        slot(1),
        () => ({
          body: JSON.stringify({ error: "unknown probe" }),
          code: 200,
        }),
        asked,
      ).error,
      "the RESTlet host refused: unknown probe",
    );
  });
});

describe("the generated RESTlet host", () => {
  type Host = { post: (b: unknown) => Record<string, unknown> };
  const deployed = (p: Project) => {
    write(
      p.dir,
      "verification/probes/seen.js",
      probeSource([...gated, "@param id ^[0-9]+$"]),
    );
    assert.equal(cli(p, ["deploy"]).status, 0);
    return calls(p).restletHost.join("");
  };
  const hostAs = (
    p: Project,
    run: (params: unknown) => unknown,
    runtime: object = runtimeAt(slot(1), { LIST_CUSTJOB: 1 }),
  ) => load<Host>(deployed(p), runtime, { run });
  const body = { params: { id: "7" }, probe: "seen", slot: slot(1) };

  it("runs the probe and proves the role with getPermission, with its usage", () => {
    const p = project();
    const host = hostAs(p, (params) => ({ got: params }));
    assert.deepEqual(host.post(body), {
      permissions: { LIST_CUSTJOB: "VIEW" },
      probe: "seen",
      result: { got: { id: "7" } },
      scriptType: "RESTlet",
      usage: { after: 5000, before: 5000 },
      version: "2026.2",
    });
  });

  it("refuses a slot that does not match the probe's set, an unknown probe, bad parameters and a non-sandbox, running nothing", () => {
    const p = project();
    let ran = 0;
    const host = hostAs(p, () => ran++);
    assert.match(
      String(host.post({ ...body, slot: slot(0) }).error),
      /does not match the slot/,
    );
    assert.match(
      String(host.post({ ...body, slot: undefined }).error),
      /does not match/,
    );
    assert.equal(host.post({ ...body, probe: "nope" }).error, "unknown probe");
    assert.match(
      String(host.post({ ...body, params: { id: "x" } }).error),
      /param/,
    );
    const prod = hostAs(p, () => ran++, {
      ...runtimeAt(slot(1)),
      envType: "PRODUCTION",
    });
    assert.match(String(prod.post(body).error), /only runs in a sandbox/);
    assert.equal(ran, 0);
  });

  it("reports a throw and a rejection as the result, and a lost Promise as an error, each with usage", async () => {
    const p = project();
    const throwing = hostAs(p, () => {
      throw new TypeError("boom");
    });
    assert.equal(throwing.post(body).result, "THROWS: TypeError: boom");
    const rejecting = hostAs(p, () => Promise.reject(new RangeError("late")));
    const rejected = await rejecting.post(body);
    assert.equal(rejected.result, "REJECTS: RangeError: late");
    assert.ok(rejected.usage);
    const lost = hostAs(p, () => ({ later: Promise.resolve(1) }));
    const answer = lost.post(body) as Record<string, unknown>;
    assert.match(String(answer.error), /not awaited at later/);
    assert.ok(answer.usage);
  });
});

describe("a RESTlet probe with a permission has a 45-second timeout", () => {
  const withTags = (p: Project, tags: string[]) =>
    write(p.dir, "verification/probes/one.js", probeSource(tags));

  it("refuses a @timeout above 45 at run and deploy, naming the probe and the limit, before anything is sent", () => {
    const p = project();
    p.script(
      { body: { access_token: "t" }, status: 200 },
      { body: { result: {} }, status: 200 },
    );
    withTags(p, [...gated, "@timeout 46"]);
    const run = cli(p, ["run", "one"]);
    assert.equal(run.status, 1, run.all);
    assert.match(run.stderr, /one has invalid tags/);
    assert.match(run.stderr, /@timeout "46"[^\n]*1 to 45/);
    const deploy = cli(p, ["deploy"]);
    assert.equal(deploy.status, 1, deploy.all);
    assert.match(deploy.stderr, /one: @timeout "46"[^\n]*1 to 45/);
    assert.deepEqual(p.requests(), []);
  });

  it("accepts 45, while a RESTlet probe with no permission keeps its 300", () => {
    const p = project();
    p.script(
      { body: { access_token: "t" }, status: 200 },
      { body: { probe: "one", result: {}, version: "1" }, status: 200 },
    );
    withTags(p, [...gated, "@timeout 45"]);
    const first = cli(p, ["run", "one"]);
    assert.equal(first.status, 0, first.all);
    withTags(p, [restlet, "@timeout 300"]);
    const long = cli(p, ["run", "one"]);
    assert.equal(long.status, 0, long.all);
    withTags(p, [restlet, "@timeout 301"]);
    assert.match(cli(p, ["run", "one"]).stderr, /1 to 300/);
  });
});
