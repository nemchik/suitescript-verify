import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { moduleClasses } from "../src/modules.ts";
import { listProbes, parseProbe } from "../src/probes.ts";
import {
  graceSeconds,
  patientDispatcher,
  secondsToWait,
  timedOutMessage,
} from "../src/run.ts";
import { fakeTerminal } from "./fixtures/terminal.ts";

const root = join(import.meta.dirname, "..");
const bin = join(root, "dist", "bin", "suitescript-verify.js");
const fake = pathToFileURL(
  join(import.meta.dirname, "fixtures", "fake-netsuite.mjs"),
).href;
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { force: true, recursive: true });
});

const account = "1234567_SB1";
const clientId = "client-id-value";
/** The comments NetSuite appends to an HTML page, with invented values. */
const trailer = `
<!-- Host [ host-a1 ] App Version [ 2026.2.0 ] -->
<!-- COMPID [ ${account} ] EMAIL [ person@example.com ] URL [ /app/site/hosting/scriptlet.nl ] Time [ Tue Nov 17 10:00:00 PST 2026 ] -->
<!-- Not logging slowest SQL -->
`;

interface Answer {
  body: unknown;
  /** How long the fake takes to answer, in milliseconds. */
  delayMs?: number;
  status: number;
}

interface Project {
  dir: string;
  env: Record<string, string>;
  requests: () => { body: string; url: string }[];
  script: (token: Answer, restlet: Answer) => void;
}

const write = (project: string, file: string, text: string) => {
  mkdirSync(dirname(join(project, file)), { recursive: true });
  writeFileSync(join(project, file), text);
};

const probeSource = (tags: string) =>
  `/**\n * A probe.\n *\n * @NApiVersion 2.1\n${tags}\n */\ndefine([], () => ({ run() { return { ok: true }; } }));\n`;

/** The fake SuiteCloud CLI: records how it was called and what the SDF folder held. */
const fakeCli = (dir: string) => `const fs = require("node:fs");
const path = require("node:path");
const cabinet = path.join(process.cwd(), "src", "FileCabinet");
const objects = path.join(process.cwd(), "src", "Objects");
const list = (d) =>
  fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map(String) : [];
fs.writeFileSync(${JSON.stringify(join(dir, "calls.json"))}, JSON.stringify({
  args: process.argv.slice(2),
  files: list(cabinet),
  license: process.env.SUITECLOUD_CLI_ACCEPT_LICENSE ?? null,
  objects: list(objects).map((f) => fs.readFileSync(path.join(objects, f), "utf8")),
  runner: list(cabinet)
    .filter((f) => f.endsWith("restlet.js"))
    .map((f) => fs.readFileSync(path.join(cabinet, f), "utf8")),
  suitelet: list(cabinet)
    .filter((f) => f.endsWith("suitelet.js"))
    .map((f) => fs.readFileSync(path.join(cabinet, f), "utf8")),
}));`;

/**
 * A temporary project with a fake SuiteCloud CLI and an EC key for the
 * runner. Network calls go to the fake fetch, never to NetSuite.
 */
function project(): Project {
  const dir = mkdtempSync(join(tmpdir(), "suitescript-verify-"));
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
  for (const sub of [
    "verification/sdf",
    "verification/probes",
    "docs/verification/results",
  ]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return {
    dir,
    env: {
      FAKE_NETSUITE_LOG: logFile,
      FAKE_NETSUITE_SCRIPT: scriptFile,
      NODE_OPTIONS: `--import=${fake}`,
      SUITESCRIPT_VERIFY_ACCOUNT: account,
      SUITESCRIPT_VERIFY_CERTIFICATE_ID: "cert-runner-id",
      SUITESCRIPT_VERIFY_CLIENT_ID: clientId,
      SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH: keyPath,
      SUITESCRIPT_VERIFY_RESULTS_DIR: "docs/verification/results",
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

function cli(
  p: Project,
  args: string[],
  env: Record<string, string> = {},
  cwd: string = p.dir,
) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.SUITECLOUD_CLI_ACCEPT_LICENSE;
  for (const name of Object.keys(base)) {
    if (name.startsWith("SUITESCRIPT_VERIFY_")) delete base[name];
  }
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...base, ...p.env, ...env },
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
    args: string[];
    files: string[];
    license: string | null;
    objects: string[];
    runner: string[];
    suitelet: string[];
  };

const ok = (restletBody: unknown): [Answer, Answer] => [
  { body: { access_token: "tok-abc" }, status: 200 },
  { body: restletBody, status: 200 },
];

const restlet = "@scriptType Restlet";

describe("deploy builds the runner from the probes", () => {
  it("generates the SDF project with only RESTlet probes, and uploads nothing without approval", () => {
    const p = project();
    write(p.dir, "verification/probes/one.js", probeSource(restlet));
    write(
      p.dir,
      "verification/probes/two.js",
      probeSource("@scriptType Client"),
    );
    write(p.dir, "verification/probes/three.js", probeSource(""));
    const result = cli(p, ["deploy"]);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /Probes in the runner: one\n/);
    const call = calls(p);
    assert.deepEqual(call.args, ["project:deploy", "--dryrun"]);
    assert.deepEqual(call.files.map((f) => f.replaceAll("\\", "/")).sort(), [
      "SuiteScripts",
      "SuiteScripts/suitescript-verify",
      "SuiteScripts/suitescript-verify/probes",
      "SuiteScripts/suitescript-verify/probes/one.js",
      "SuiteScripts/suitescript-verify/restlet.js",
      "SuiteScripts/suitescript-verify/suitelet.js",
    ]);
    assert.match(call.objects.join(""), /<isdeployed>T<\/isdeployed>/);
    const runner = call.runner.join("");
    assert.match(runner, /"\.\/probes\/one"/);
    assert.doesNotMatch(runner, /two|three/);
  });

  it("gives the runner a fixed probe list and no way to run code from a request", () => {
    const p = project();
    write(p.dir, "verification/probes/one.js", probeSource(restlet));
    cli(p, ["deploy"]);
    const runner = calls(p).runner.join("");
    assert.doesNotMatch(runner, /\beval\b|new Function|require\(/);
    assert.match(runner, /probes\.get\(name\)/);
    assert.match(runner, /EnvType\.SANDBOX/);
  });

  it("refuses an approved deploy without a terminal, before touching anything", () => {
    const p = project();
    const result = cli(p, ["deploy", "--approved"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs the user at a terminal/);
    assert.equal(existsSync(join(p.dir, "calls.json")), false);
  });

  it("deploys for real once the person types DEPLOY at the terminal", () => {
    const p = project();
    write(p.dir, "verification/probes/one.js", probeSource(restlet));
    const result = cli(
      p,
      ["deploy", "--approved"],
      fakeTerminal(["DEPLOY"], p.env),
    );
    assert.equal(result.status, 0, result.all);
    assert.match(
      result.stdout,
      /This deploys to the sandbox\. Type DEPLOY to continue: /,
    );
    const call = calls(p);
    assert.deepEqual(call.args, ["project:deploy"]);
    assert.match(call.objects.join(""), /<isdeployed>T<\/isdeployed>/);
  });

  for (const typed of ["deploy", "yes", "CLEANUP", ""]) {
    it(`deploys nothing when the person types ${JSON.stringify(typed)} instead of DEPLOY`, () => {
      const p = project();
      const result = cli(
        p,
        ["deploy", "--approved"],
        fakeTerminal([typed], p.env),
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Not confirmed\. Nothing was changed\./);
      assert.equal(existsSync(join(p.dir, "calls.json")), false);
    });
  }

  it("deploys nothing when the terminal closes before an answer", () => {
    const p = project();
    const result = cli(p, ["deploy", "--approved"], fakeTerminal([], p.env));
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(join(p.dir, "calls.json")), false);
  });
});

describe("cleanup", () => {
  it("dry-runs the deployment switched off", () => {
    const p = project();
    const result = cli(p, ["cleanup"]);
    assert.equal(result.status, 0, result.all);
    const call = calls(p);
    assert.deepEqual(call.args, ["project:deploy", "--dryrun"]);
    assert.match(call.objects.join(""), /<isdeployed>F<\/isdeployed>/);
  });

  it("refuses an approved cleanup without a terminal", () => {
    const p = project();
    const result = cli(p, ["cleanup", "--approved"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs the user at a terminal/);
    assert.equal(existsSync(join(p.dir, "calls.json")), false);
  });

  it("turns the deployment off for real once the person types CLEANUP at the terminal", () => {
    const p = project();
    const result = cli(
      p,
      ["cleanup", "--approved"],
      fakeTerminal(["CLEANUP"], p.env),
    );
    assert.equal(result.status, 0, result.all);
    assert.match(
      result.stdout,
      /This turns the runner's and the Suitelet host's deployments off\. Type CLEANUP to continue: /,
    );
    const call = calls(p);
    assert.deepEqual(call.args, ["project:deploy"]);
    assert.match(call.objects.join(""), /<isdeployed>F<\/isdeployed>/);
  });

  for (const typed of ["cleanup", "yes", "DEPLOY", ""]) {
    it(`changes nothing when the person types ${JSON.stringify(typed)} instead of CLEANUP`, () => {
      const p = project();
      const result = cli(
        p,
        ["cleanup", "--approved"],
        fakeTerminal([typed], p.env),
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Not confirmed\. Nothing was changed\./);
      assert.equal(existsSync(join(p.dir, "calls.json")), false);
    });
  }
});

describe("sandbox only", () => {
  const commands = [["deploy"], ["cleanup"], ["setup-ci"], ["run", "one"]];
  for (const bad of ["1234567", "1234567_RP", "TSTDRV1234567", "1234567_SB"]) {
    for (const command of commands) {
      it(`refuses ${command[0]} for account "${bad}" and reaches nothing`, () => {
        const p = project();
        write(p.dir, "verification/probes/one.js", probeSource(restlet));
        p.script(...ok({ result: {}, version: "1" }));
        const result = cli(p, command, { SUITESCRIPT_VERIFY_ACCOUNT: bad });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /not a sandbox account/);
        assert.equal(existsSync(join(p.dir, "calls.json")), false);
        assert.deepEqual(p.requests(), []);
      });
    }
  }

  it("refuses when settings are missing, naming them", () => {
    const p = project();
    const result = cli(p, ["deploy"], { SUITESCRIPT_VERIFY_CLIENT_ID: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SUITESCRIPT_VERIFY_CLIENT_ID/);
  });
});

describe("the SuiteCloud license", () => {
  it("is never set for the SuiteCloud CLI, by any command that calls it", () => {
    for (const command of [["deploy"], ["cleanup"], ["setup-ci"]]) {
      const p = project();
      const result = cli(p, command);
      assert.equal(result.status, 0, result.all);
      assert.equal(calls(p).license, null, command[0]);
    }
  });

  it("is never assigned anywhere in the source or templates", () => {
    const files = readdirSync(root, { encoding: "utf8", recursive: true })
      .map((f) => f.replaceAll("\\", "/"))
      .filter(
        (f) => /^(src|templates)\//.test(f) && /\.(ts|js|xml|json)$/.test(f),
      );
    assert.ok(files.length > 5);
    for (const file of files) {
      assert.doesNotMatch(
        readFileSync(join(root, file), "utf8"),
        /SUITECLOUD_CLI_ACCEPT_LICENSE["'`\]]?\s*[:=\]]/,
        file,
      );
    }
  });
});

describe("setup-ci", () => {
  it("registers the SDF credentials through the project's CLI", () => {
    const p = project();
    const result = cli(p, ["setup-ci"]);
    assert.equal(result.status, 0, result.all);
    const args = calls(p).args;
    assert.equal(args[0], "account:setup:ci");
    assert.ok(args.includes("cert-sdf-id"));
    assert.ok(!args.includes("cert-runner-id"));
  });

  const ci = (p: Project) =>
    cli(p, ["setup-ci"], { SUITESCRIPT_VERIFY_PASSKEY: "ci-passkey-5555" });

  it("lists the names the pipeline must supply, never a value", () => {
    const p = project();
    const result = ci(p);
    assert.equal(result.status, 0, result.all);
    for (const name of [
      "SUITESCRIPT_VERIFY_ACCOUNT",
      "SUITESCRIPT_VERIFY_CLIENT_ID",
      "SUITESCRIPT_VERIFY_CERTIFICATE_ID",
      "SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH",
      "SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID",
      "SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH",
      "SUITESCRIPT_VERIFY_PASSKEY",
    ]) {
      assert.match(result.stdout, new RegExp(name));
    }
    for (const value of [
      "ci-passkey-5555",
      "cert-sdf-id",
      "cert-runner-id",
      p.env.SUITESCRIPT_VERIFY_ACCOUNT ?? "never",
      p.env.SUITESCRIPT_VERIFY_CLIENT_ID ?? "never",
    ]) {
      assert.equal(result.all.includes(value), false, value);
    }
  });

  it("leaves the license to the person and sets no variable for it", () => {
    const p = project();
    const result = ci(p);
    assert.match(result.stdout, /accept .*license.* yourself/i);
    assert.equal(calls(p).license, null);
  });

  it("writes no credential or license variable and no file", () => {
    const p = project();
    const before = readdirSync(p.dir, {
      encoding: "utf8",
      recursive: true,
    }).sort();
    const result = ci(p);
    assert.equal(result.status, 0, result.all);
    assert.equal(existsSync(join(p.dir, "verification", ".env.local")), false);
    assert.equal(existsSync(join(p.dir, "verification", ".env")), false);
    const after = readdirSync(p.dir, {
      encoding: "utf8",
      recursive: true,
    }).sort();
    const added = after.filter((f) => !before.includes(f));
    assert.deepEqual(
      added.filter((f) => !f.startsWith("calls.json")),
      [],
    );
  });

  it("hands the CLI the passkey through the environment, not the arguments", () => {
    const p = project();
    ci(p);
    assert.equal(calls(p).args.join(" ").includes("ci-passkey-5555"), false);
  });

  it("prints no list when the CLI fails", () => {
    const p = project();
    const result = cli(p, ["setup-ci"], {
      SUITESCRIPT_VERIFY_ACCOUNT: "123_RP",
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /pipeline/);
  });
});

describe("passkey and env", () => {
  const local = (p: Project) =>
    readFileSync(join(p.dir, "verification", ".env.local"), "utf8");

  it("generates a passkey into .env.local and never prints it", () => {
    const p = project();
    const result = cli(p, ["passkey"]);
    assert.equal(result.status, 0, result.all);
    const key = /SUITESCRIPT_VERIFY_PASSKEY=([A-Za-z0-9]+)/.exec(local(p))?.[1];
    assert.match(key ?? "", /^[A-Za-z0-9]{32,100}$/);
    assert.equal(result.all.includes(key ?? "never"), false);
  });

  it("keeps an existing passkey unless told to overwrite it", () => {
    const p = project();
    cli(p, ["passkey"]);
    const first = local(p);
    const kept = cli(p, ["passkey"]);
    assert.match(kept.stdout, /Kept the existing SUITESCRIPT_VERIFY_PASSKEY/);
    assert.equal(local(p), first);
    cli(p, ["passkey", "--overwrite"]);
    assert.notEqual(local(p), first);
  });

  it("saves a known setting, refuses an unknown one and the passkey, and never echoes values", () => {
    const p = project();
    const secret = "very-secret-client-9999";
    const saved = cli(p, [
      "env",
      "set",
      `SUITESCRIPT_VERIFY_CLIENT_ID=${secret}`,
    ]);
    assert.equal(saved.status, 0, saved.all);
    assert.match(local(p), new RegExp(`CLIENT_ID=${secret}`));
    assert.equal(saved.all.includes(secret), false);
    assert.equal(cli(p, ["env", "set", "NOPE=1"]).status, 1);
    assert.match(
      cli(p, ["env", "set", "SUITESCRIPT_VERIFY_PASSKEY=x"]).stderr,
      /passkey/,
    );
  });

  it("keeps a different existing value without a terminal", () => {
    const p = project();
    cli(p, ["env", "set", "SUITESCRIPT_VERIFY_DOMAIN=one"]);
    const result = cli(p, ["env", "set", "SUITESCRIPT_VERIFY_DOMAIN=two"]);
    assert.match(result.stdout, /Kept the existing/);
    assert.match(local(p), /DOMAIN=one/);
    cli(p, ["env", "set", "SUITESCRIPT_VERIFY_DOMAIN=two", "--overwrite"]);
    assert.match(local(p), /DOMAIN=two/);
  });
});

describe("certificate", () => {
  const hasOpenssl =
    spawnSync("openssl", ["version"]).status === 0 ||
    existsSync("C:\\Program Files\\Git\\usr\\bin\\openssl.exe");

  it("refuses a key folder inside the project", () => {
    const p = project();
    const result = cli(p, ["certificate", "--keys-dir", join(p.dir, "keys")]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside the project/);
  });

  it("generates an EC runner pair and an RSA-4096 SDF pair outside the project, and saves only paths", {
    skip: !hasOpenssl,
  }, () => {
    const p = project();
    const keys = mkdtempSync(join(tmpdir(), "suitescript-verify-keys-"));
    temps.push(keys);
    const result = cli(p, ["certificate", "--keys-dir", keys]);
    assert.equal(result.status, 0, result.all);
    const runner = createPrivateKey(
      readFileSync(join(keys, "runner-private.pem")),
    );
    assert.equal(runner.asymmetricKeyDetails?.namedCurve, "prime256v1");
    const sdf = createPrivateKey(readFileSync(join(keys, "sdf-private.pem")));
    assert.equal(sdf.asymmetricKeyDetails?.modulusLength, 4096);
    const env = readFileSync(join(p.dir, "verification", ".env.local"), "utf8");
    assert.match(env, /PRIVATE_KEY_PATH=/);
    assert.doesNotMatch(env, /BEGIN/);
    assert.equal(result.all.includes("BEGIN"), false);
  });
});

describe("run", () => {
  const withProbe = (p: Project, tags = restlet, slug = "one") =>
    write(p.dir, `verification/probes/${slug}.js`, probeSource(tags));

  it("runs a RESTlet probe by name through the sandbox and prints the result", () => {
    const p = project();
    withProbe(p);
    p.script(...ok({ probe: "one", result: { ok: true }, version: "2026.2" }));
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /"ok": true/);
    const [token, call] = p.requests();
    assert.match(token?.url ?? "", /^https:\/\/1234567-sb1\.suitetalk\./);
    assert.match(token?.body ?? "", /client_assertion=/);
    assert.match(call?.url ?? "", /^https:\/\/1234567-sb1\.restlets\./);
    assert.equal(call?.body, JSON.stringify({ probe: "one" }));
  });

  it("prints and drafts the output with every object's keys sorted, so it can be copied as the expectation", () => {
    const p = project();
    withProbe(p);
    p.script(
      ...ok({
        // Parsed from text, so Biome's sorted-keys action cannot sort it.
        result: JSON.parse(
          '{"z": 1, "a": [{"y": 1, "b": 2}], "m": {"k": 1, "c": 2}}',
        ),
        version: "2026.2",
      }),
    );
    const result = cli(p, ["run", "one", "--draft"]);
    assert.equal(result.status, 0, result.all);
    const sorted = `{
  "a": [
    {
      "b": 2,
      "y": 1
    }
  ],
  "m": {
    "c": 2,
    "k": 1
  },
  "z": 1
}`;
    assert.ok(
      result.stdout.includes(`"result": ${sorted.replaceAll("\n", "\n  ")}`),
      result.stdout,
    );
    assert.ok(
      result.stdout.indexOf('"result"') < result.stdout.indexOf('"version"'),
    );
    const draft = readFileSync(
      join(p.dir, "docs", "verification", "results", "one.md"),
      "utf8",
    );
    assert.ok(draft.includes(sorted), draft);
  });

  it("calls the default runner, and the one named by SUITESCRIPT_VERIFY_RUNNER_ID", () => {
    const p = project();
    withProbe(p);
    p.script(...ok({ probe: "one", result: {}, version: "1" }));
    assert.equal(cli(p, ["run", "one"]).status, 0);
    assert.match(
      p.requests()[1]?.url ?? "",
      /script=customscript_suitescript_verify_rl&deploy=customdeploy_suitescript_verify_rl$/,
    );
    write(
      p.dir,
      "verification/.env",
      "SUITESCRIPT_VERIFY_RUNNER_ID=my_project\n",
    );
    p.script(...ok({ probe: "one", result: {}, version: "1" }));
    assert.equal(cli(p, ["run", "one"]).status, 0);
    assert.match(
      p.requests().at(-1)?.url ?? "",
      /script=customscript_my_project_rl&deploy=customdeploy_my_project_rl$/,
    );
  });

  it("runs a probe from a project nested in a subfolder, with --dir .", () => {
    const p = project();
    const tools = join(p.dir, "tools");
    write(tools, "probes/one.js", probeSource(restlet));
    mkdirSync(join(tools, "docs", "verification", "results"), {
      recursive: true,
    });
    p.script(...ok({ probe: "one", result: { ok: true }, version: "2026.2" }));
    const result = cli(p, ["run", "one", "--dir", "."], {}, tools);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /"ok": true/);
    assert.match(
      p.requests()[1]?.url ?? "",
      /^https:\/\/1234567-sb1\.restlets\./,
    );
  });

  it("takes only a probe name from the fixed list, never code", () => {
    const p = project();
    withProbe(p);
    p.script(...ok({ result: {}, version: "1" }));
    for (const name of ["missing", "../one", "one.js", "1+1"]) {
      const result = cli(p, ["run", name]);
      assert.equal(result.status, 1, name);
      assert.match(result.stderr, /Unknown probe/);
    }
    assert.deepEqual(p.requests(), []);
  });

  it("refuses a probe that is not a RESTlet or declares @writes", () => {
    const p = project();
    withProbe(p, "@scriptType Client", "client");
    withProbe(p, "", "undeclared");
    withProbe(p, `${restlet}\n * @writes`, "writer");
    p.script(...ok({ result: {}, version: "1" }));
    const client = cli(p, ["run", "client"]).stderr;
    assert.match(client, /RESTlet and Suitelet probes/);
    assert.doesNotMatch(client, /docs\/verification/);
    assert.match(cli(p, ["run", "undeclared"]).stderr, /undeclared/);
    assert.match(cli(p, ["run", "writer"]).stderr, /@writes/);
    assert.deepEqual(p.requests(), []);
  });

  it("scrubs the account and client ids from the output", () => {
    const p = project();
    withProbe(p);
    p.script(
      ...ok({
        result: { echoed: `${account} and ${clientId}` },
        version: "2026.2",
      }),
    );
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /<ACCOUNT> and <CLIENT-ID>/);
    assert.equal(result.stdout.includes(account), false);
    assert.equal(result.stdout.includes(clientId), false);
  });

  it("refuses to print or record output that still looks like an identifier", () => {
    const p = project();
    withProbe(p);
    p.script(
      ...ok({ result: { who: "someone@example.com" }, version: "2026.2" }),
    );
    const result = cli(p, ["run", "one", "--draft"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing to print or record/);
    assert.equal(result.stdout.includes("someone@"), false);
    assert.equal(
      existsSync(join(p.dir, "docs", "verification", "results", "one.md")),
      false,
    );
  });

  it("scrubs a failed call too", () => {
    const p = project();
    withProbe(p);
    p.script(
      {
        body: { error: "invalid_client", error_description: account },
        status: 401,
      },
      { body: {}, status: 200 },
    );
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /HTTP 401 invalid_client <ACCOUNT>/);
    assert.equal(result.all.includes(account), false);
  });

  it("reports the runner's own refusal", () => {
    const p = project();
    withProbe(p);
    p.script(...ok({ error: "refused: the runner only runs in a sandbox" }));
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /The runner reported an error: refused/);
  });

  const usage = (before: number, after: number) => ({
    RESTlet: { after, before },
  });

  it("prints usage with the result", () => {
    const p = project();
    withProbe(p);
    p.script(
      ...ok({
        result: { ok: true },
        usage: usage(5000, 4990),
        version: "2026.2",
      }),
    );
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 0, result.all);
    const printed = JSON.parse(result.stdout.split(/\r?\n\r?\n/)[0] ?? "");
    assert.deepEqual(printed.usage, usage(5000, 4990));
    assert.deepEqual(printed.result, { ok: true });
  });

  it("prints usage after the keys that sort before it, as the rest is sorted", () => {
    const p = project();
    withProbe(p);
    p.script(
      ...ok({
        result: { ok: true },
        usage: usage(5000, 4990),
        version: "2026.2",
      }),
    );
    const { stdout } = cli(p, ["run", "one"]);
    assert.ok(stdout.indexOf('"result"') < stdout.indexOf('"usage"'));
    assert.ok(stdout.indexOf('"usage"') < stdout.indexOf('"version"'));
  });

  describe("drift against expect.json", () => {
    it("passes when the output matches", () => {
      const p = project();
      withProbe(p);
      write(p.dir, "verification/probes/one.expect.json", '{"ok": true}');
      p.script(...ok({ result: { ok: true }, version: "2026.2" }));
      const result = cli(p, ["run", "one"]);
      assert.equal(result.status, 0, result.all);
      assert.match(result.stdout, /Matches the expected output/);
    });

    it("ignores usage: a matching expectation still matches when only usage differs, and needs no edit", () => {
      const p = project();
      withProbe(p);
      write(p.dir, "verification/probes/one.expect.json", '{"ok": true}');
      for (const [before, after] of [
        [5000, 4990],
        [5000, 1],
      ]) {
        p.script(
          ...ok({
            result: { ok: true },
            usage: usage(before as number, after as number),
            version: "2026.2",
          }),
        );
        const result = cli(p, ["run", "one"]);
        assert.equal(result.status, 0, result.all);
        assert.match(result.stdout, /Matches the expected output/);
      }
    });

    it("matches an expectation written before usage existed, with no edit", () => {
      const p = project();
      withProbe(p);
      write(p.dir, "verification/probes/one.expect.json", '{"ok": true}');
      p.script(
        ...ok({
          result: { ok: true },
          usage: {
            RESTlet: { after: 0, before: 5000, exceeded: true },
            Suitelet: { after: 900, before: 1000 },
          },
          version: "2026.2",
        }),
      );
      const result = cli(p, ["run", "one"]);
      assert.equal(result.status, 0, result.all);
      assert.match(result.stdout, /Matches the expected output/);
    });

    describe("an error answer that carries usage", () => {
      const failed = (usage: unknown) => {
        const p = project();
        withProbe(p);
        p.script(...ok({ error: "the Suitelet host refused: nope", usage }));
        return cli(p, ["run", "one"]);
      };

      it("shows the usage beside the error and exits 1 as before", () => {
        const result = failed({
          RESTlet: { after: 4990, before: 5000 },
          Suitelet: { after: 900, before: 1000 },
        });
        assert.equal(result.status, 1);
        assert.match(
          result.stderr,
          /The runner reported an error: the Suitelet host refused: nope\nUsage: \{"RESTlet":\{"after":4990,"before":5000\},"Suitelet":\{"after":900,"before":1000\}\}/,
        );
        assert.doesNotMatch(result.all, /Warning:/);
      });

      it("adds the governance warning when an entry is flagged", () => {
        const result = failed({
          RESTlet: { after: 0, before: 5000, exceeded: true },
        });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /"exceeded":true/);
        assert.match(
          result.stderr,
          /^Warning: a script ran out of governance units \(RESTlet\)/m,
        );
      });

      it("scrubs the usage like any other output", () => {
        const result = failed({ [account]: { after: 1, before: 2 } });
        assert.equal(result.all.includes(account), false);
      });

      it("drops a malformed reading and prints just the error", () => {
        const result = failed({ RESTlet: { after: "x", before: 1 } });
        assert.equal(result.status, 1);
        assert.doesNotMatch(result.stderr, /Usage:/);
      });
    });

    describe("the governance warning", () => {
      const warning =
        /^Warning: a script ran out of governance units \((.*)\)/m;

      it("prints one line naming each flagged script, and still prints the usage", () => {
        const p = project();
        withProbe(p);
        p.script(
          ...ok({
            result: { ok: true },
            usage: {
              RESTlet: { after: 0, before: 5000, exceeded: true },
              Suitelet: { after: 10, before: 1000 },
            },
            version: "2026.2",
          }),
        );
        const result = cli(p, ["run", "one"]);
        assert.equal(result.status, 0, result.all);
        assert.equal(result.stdout.match(/Warning:/g)?.length, 1);
        assert.equal(result.stdout.match(warning)?.[1], "RESTlet");
        assert.match(result.stdout, /"exceeded": true/);
      });

      it("names both scripts when both are flagged", () => {
        const p = project();
        withProbe(p);
        p.script(
          ...ok({
            result: 1,
            usage: {
              RESTlet: { after: 0, before: 5, exceeded: true },
              Suitelet: { after: 0, before: 5, exceeded: true },
            },
            version: "2026.2",
          }),
        );
        const result = cli(p, ["run", "one"]);
        assert.equal(result.stdout.match(/Warning:/g)?.length, 1);
        assert.equal(result.stdout.match(warning)?.[1], "RESTlet, Suitelet");
      });

      it("prints none when no entry is flagged or there is no usage", () => {
        const p = project();
        withProbe(p);
        for (const usage of [
          { RESTlet: { after: 4990, before: 5000 } },
          undefined,
        ]) {
          p.script(...ok({ result: 1, usage, version: "2026.2" }));
          const result = cli(p, ["run", "one"]);
          assert.equal(result.status, 0, result.all);
          assert.doesNotMatch(result.stdout, /Warning:/);
        }
      });
    });

    it("flags a difference with exit 2", () => {
      const p = project();
      withProbe(p);
      write(p.dir, "verification/probes/one.expect.json", '{"ok": false}');
      p.script(...ok({ result: { ok: true }, version: "2026.2" }));
      const result = cli(p, ["run", "one"]);
      assert.equal(result.status, 2);
      assert.match(result.stdout, /DRIFT/);
    });

    it("names what differs as dotted paths, at most ten", () => {
      const p = project();
      withProbe(p);
      write(
        p.dir,
        "verification/probes/one.expect.json",
        '{"a": 1, "b": {"c": 2, "d": [1]}, "gone": true}',
      );
      p.script(
        ...ok({
          result: { a: 1, b: { c: 3, d: [2] }, extra: 0 },
          version: "2026.2",
        }),
      );
      assert.match(
        cli(p, ["run", "one"]).stdout,
        /DRIFT: the output differs from one\.expect\.json at result\.b\.c, result\.b\.d, result\.extra, result\.gone\./,
      );
      p.script(...ok({ result: "changed", version: "2026.2" }));
      assert.match(
        cli(p, ["run", "one"]).stdout,
        /differs from one\.expect\.json at result\./,
      );
      const many = Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`k${i + 10}`, i]),
      );
      p.script(...ok({ result: { ...many, a: 1 }, version: "2026.2" }));
      assert.match(
        cli(p, ["run", "one"]).stdout,
        /at result\.b, result\.gone, result\.k10, result\.k11, result\.k12, result\.k13, result\.k14, result\.k15, result\.k16, result\.k17 and 4 more\./,
      );
    });
  });

  describe("--draft", () => {
    const page = (p: Project) =>
      join(p.dir, "docs", "verification", "results", "one.md");

    it("writes a results page with the test, version, results, explanation and decision", () => {
      const p = project();
      withProbe(p);
      p.script(...ok({ result: { ok: true }, version: "2026.2" }));
      const result = cli(p, ["run", "one", "--draft"]);
      assert.equal(result.status, 0, result.all);
      const text = readFileSync(page(p), "utf8");
      assert.match(text, /\*\*NetSuite version:\*\* 2026\.2/);
      assert.match(text, /\*\*Account type:\*\* sandbox/);
      for (const heading of ["Test", "Results", "Explanation", "Decision"]) {
        assert.match(text, new RegExp(`^## ${heading}$`, "m"));
      }
      assert.match(text, /define\(\[\]/);
      assert.match(text, /"ok": true/);
      assert.match(text, /\(\.\.\/\.\.\/\.\.\/verification\/probes\/one\.js\)/);
      assert.equal(text.includes(account), false);
      assert.doesNotMatch(text, /contradiction|rule/i);
    });

    it("carries usage in the Results section", () => {
      const p = project();
      withProbe(p);
      p.script(
        ...ok({
          result: { ok: true },
          usage: usage(5000, 4990),
          version: "2026.2",
        }),
      );
      assert.equal(cli(p, ["run", "one", "--draft"]).status, 0);
      const text = readFileSync(page(p), "utf8");
      const results = text.split("## Results")[1]?.split("## Explanation")[0];
      assert.match(
        results ?? "",
        /Usage \(.*\):\s+```json\s+\{\s+"RESTlet": \{\s+"after": 4990,\s+"before": 5000/,
      );
      assert.match(results ?? "", /"ok": true/);
    });

    it("prints the execution role's levels and carries them in the Results section", () => {
      const p = project();
      withProbe(p);
      p.script(
        ...ok({
          permissions: { LIST_CUSTJOB: "NONE" },
          result: { ok: true },
          scriptType: "Suitelet",
          version: "2026.2",
        }),
      );
      const result = cli(p, ["run", "one", "--draft"]);
      assert.equal(result.status, 0, result.all);
      assert.match(result.stdout, /"permissions": \{\s+"LIST_CUSTJOB": "NONE"/);
      const text = readFileSync(page(p), "utf8");
      const results = text.split("## Results")[1]?.split("## Explanation")[0];
      assert.match(
        results ?? "",
        /Permissions \(.*\):\s+```json\s+\{\s+"LIST_CUSTJOB": "NONE"/,
      );
    });

    it("refuses without a results folder, names the key and writes nothing", () => {
      const p = project();
      withProbe(p);
      delete p.env.SUITESCRIPT_VERIFY_RESULTS_DIR;
      rmSync(join(p.dir, "docs"), { force: true, recursive: true });
      p.script(...ok({ result: { ok: true }, version: "2026.2" }));
      const result = cli(p, ["run", "one", "--draft"]);
      assert.equal(result.status, 1, result.all);
      assert.match(result.all, /SUITESCRIPT_VERIFY_RESULTS_DIR/);
      assert.equal(existsSync(join(p.dir, "docs")), false);
    });

    it("names the missing results key even before any credential is set", () => {
      const p = project();
      withProbe(p);
      const bare = cli(p, ["run", "one", "--draft"], {
        SUITESCRIPT_VERIFY_ACCOUNT: "",
        SUITESCRIPT_VERIFY_RESULTS_DIR: "",
      });
      assert.equal(bare.status, 1, bare.all);
      assert.match(bare.all, /SUITESCRIPT_VERIFY_RESULTS_DIR is not set/);
      assert.ok(
        bare.all.includes(
          "Choose where results pages live in your project, then run suitescript-verify init --results-dir <path> (docs/verification/results is the suggested value) or set SUITESCRIPT_VERIFY_RESULTS_DIR in the committed .env.",
        ),
        bare.all,
      );
    });

    it("never overwrites an existing page", () => {
      const p = project();
      withProbe(p);
      write(p.dir, "docs/verification/results/one.md", "mine\n");
      p.script(...ok({ result: { ok: true }, version: "2026.2" }));
      const result = cli(p, ["run", "one", "--draft"]);
      assert.match(result.stdout, /already exists; not overwriting/);
      assert.equal(readFileSync(page(p), "utf8"), "mine\n");
    });
  });
});

describe("probe parameters", () => {
  const withParams = (p: Project, params: string[], slug = "one") =>
    write(
      p.dir,
      `verification/probes/${slug}.js`,
      probeSource([restlet, ...params.map((line) => ` * ${line}`)].join("\n")),
    );
  const sent = (p: Project) => p.requests().length;

  it("passes a valid parameter to the probe as data in the request body", () => {
    const p = project();
    withParams(p, ["@param recordType ^[a-z_]+$", "@param count ^[0-9]{1,3}$"]);
    p.script(...ok({ result: {}, version: "1" }));
    const result = cli(p, [
      "run",
      "one",
      "--param",
      "recordType=salesorder",
      "--param",
      "count=25",
    ]);
    assert.equal(result.status, 0, result.all);
    assert.deepEqual(JSON.parse(p.requests()[1]?.body ?? "{}"), {
      params: { count: "25", recordType: "salesorder" },
      probe: "one",
    });
  });

  it("matches the whole value against the pattern and keeps code-like text as inert data", () => {
    const p = project();
    withParams(p, ["@param text ^.+$", "@param id [0-9]+"]);
    p.script(...ok({ result: {}, version: "1" }));
    const text = "1); evil(`x`) //";
    const ok1 = cli(p, [
      "run",
      "one",
      "--param",
      `text=${text}`,
      "--param",
      "id=7",
    ]);
    assert.equal(ok1.status, 0, ok1.all);
    assert.deepEqual(JSON.parse(p.requests()[1]?.body ?? "{}").params, {
      id: "7",
      text,
    });
    const before = sent(p);
    const partial = cli(p, [
      "run",
      "one",
      "--param",
      "text=a",
      "--param",
      "id=7x",
    ]);
    assert.equal(partial.status, 1);
    assert.match(partial.stderr, /id/);
    assert.equal(sent(p), before);
  });

  it("rejects an invalid, undeclared, missing or repeated parameter before any request", () => {
    const p = project();
    withParams(p, ["@param id ^[0-9]+$"]);
    p.script(...ok({ result: {}, version: "1" }));
    const cases: [string[], RegExp][] = [
      [["--param", "id=abc"], /does not match/],
      [["--param", "id=1", "--param", "other=2"], /not declared/],
      [[], /needs/],
      [["--param", "id=1", "--param", "id=2"], /more than once/],
      [["--param", "noequals"], /name=value/],
    ];
    for (const [extra, message] of cases) {
      const result = cli(p, ["run", "one", ...extra]);
      assert.equal(result.status, 1, extra.join(" "));
      assert.match(result.stderr, message);
    }
    assert.deepEqual(p.requests(), []);
  });

  it("takes no parameters for a probe that declares none", () => {
    const p = project();
    withParams(p, []);
    p.script(...ok({ result: {}, version: "1" }));
    const result = cli(p, ["run", "one", "--param", "id=1"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /takes no parameters/);
    assert.deepEqual(p.requests(), []);
  });

  it("refuses a bad declaration at run and at deploy, before anything is generated or sent", () => {
    const p = project();
    p.script(...ok({ result: {}, version: "1" }));
    for (const line of [
      "@param id ([",
      "@param id",
      "@param 1bad x",
      "@param id a\n * @param id b",
    ]) {
      withParams(p, [line]);
      const run = cli(p, ["run", "one"]);
      assert.equal(run.status, 1, line);
      assert.match(run.stderr, /@param/);
      const deploy = cli(p, ["deploy"]);
      assert.equal(deploy.status, 1, line);
      assert.match(deploy.stderr, /@param/);
    }
    assert.deepEqual(p.requests(), []);
    assert.equal(existsSync(join(p.dir, "calls.json")), false);
  });

  it("generates a runner that enforces the declarations itself and passes only declared strings", () => {
    const p = project();
    withParams(p, ["@param id ^[0-9]+$"]);
    cli(p, ["deploy"]);
    const source = calls(p).runner.join("");
    let factory: (...modules: unknown[]) => {
      post: (b: unknown) => { error?: string; result?: unknown };
    } = () => {
      throw new Error("no define");
    };
    const define = (_deps: string[], f: typeof factory) => {
      factory = f;
    };
    new Function("define", source)(define);
    const seen: unknown[] = [];
    const runtime = {
      EnvType: { SANDBOX: "SANDBOX" },
      envType: "SANDBOX",
      getCurrentScript: () => ({ getRemainingUsage: () => 5000 }),
      version: "1",
    };
    const runner = factory(
      runtime,
      {},
      {
        run: (params: unknown) => {
          seen.push(params);
          return "done";
        },
      },
    );
    assert.equal(
      runner.post({ params: { id: "42" }, probe: "one" }).result,
      "done",
    );
    assert.deepEqual(seen, [{ id: "42" }]);
    for (const params of [
      { id: "x" },
      { extra: "2", id: "1" },
      {},
      { id: 1 },
    ]) {
      assert.match(runner.post({ params, probe: "one" }).error ?? "", /param/);
    }
    assert.equal(seen.length, 1);
  });
});

describe("extra probe tags", () => {
  const tagged = "@scriptType Restlet\n * @flavor sweet";
  const withTag = (p: Project) =>
    write(p.dir, "verification/probes/one.js", probeSource(tagged));

  it("reports an unregistered unknown tag on run and deploy, before any request", () => {
    const p = project();
    withTag(p);
    p.script(...ok({ result: {}, version: "1" }));
    const run = cli(p, ["run", "one"]);
    assert.equal(run.status, 1, run.all);
    assert.match(run.stderr, /one.*@flavor/s);
    assert.deepEqual(p.requests(), []);
    const deploy = cli(p, ["deploy"]);
    assert.equal(deploy.status, 1);
    assert.match(deploy.stderr, /@flavor/);
  });

  it("accepts a tag registered in the process environment, .env.local or the committed .env", () => {
    const p = project();
    withTag(p);
    p.script(...ok({ result: {}, version: "1" }));
    const env = { SUITESCRIPT_VERIFY_EXTRA_TAGS: "flavor, other" };
    assert.equal(cli(p, ["run", "one"], env).status, 0);
    write(p.dir, "verification/.env", "SUITESCRIPT_VERIFY_EXTRA_TAGS=flavor\n");
    const committed = cli(p, ["deploy"]);
    assert.equal(committed.status, 0, committed.all);
    assert.doesNotMatch(committed.all, /not a layout key/);
  });

  it("still validates the built-in tags when extras are registered", () => {
    const p = project();
    write(
      p.dir,
      "verification/probes/one.js",
      probeSource("@scriptType Restlet\n * @param bad"),
    );
    const result = cli(p, ["run", "one"], {
      SUITESCRIPT_VERIFY_EXTRA_TAGS: "flavor",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@param/);
  });

  it("rejects a committed registration that is not a list of tag names, or looks like a secret", () => {
    const p = project();
    withTag(p);
    for (const value of [
      "../../etc",
      "a".repeat(40),
      "-----BEGIN PRIVATE KEY-----",
    ]) {
      write(
        p.dir,
        "verification/.env",
        `SUITESCRIPT_VERIFY_EXTRA_TAGS=${value}\n`,
      );
      const result = cli(p, ["deploy"]);
      assert.equal(result.status, 1, value);
      assert.match(result.all, /SUITESCRIPT_VERIFY_EXTRA_TAGS/);
      assert.equal(result.all.includes(value), false);
    }
  });
});

describe("@permission", () => {
  const withTags = (p: Project, slug: string, lines: string[]) =>
    write(
      p.dir,
      `verification/probes/${slug}.js`,
      probeSource(
        (lines[0]?.startsWith("@scriptType") ? lines : [restlet, ...lines])
          .map((l) => ` * ${l}`)
          .join("\n"),
      ),
    );
  const rolePermissions = (p: Project) =>
    [
      ...(
        calls(p).objects.find((xml) =>
          xml.startsWith('<role scriptid="customrole_suitescript_verify">'),
        ) ?? ""
      ).matchAll(
        /<permkey>([^<]+)<\/permkey>\s*<permlevel>([^<]+)<\/permlevel>/g,
      ),
    ].map((match) => `${match[1]} ${match[2]}`);

  it("leaves the runner's role with only the token-login and REST web services permissions, whatever the probes declare", () => {
    const p = project();
    withTags(p, "one", [
      "@permission TRAN_SALESORD VIEW",
      "@permission LIST_CUSTJOB VIEW",
    ]);
    withTags(p, "two", [
      "@scriptType Suitelet",
      "@permission LIST_CUSTJOB VIEW",
      "@permission LIST_EMPLOYEE VIEW",
      "@permission ADMI_RESTWEBSERVICES VIEW",
    ]);
    const result = cli(p, ["deploy"]);
    assert.equal(result.status, 0, result.all);
    assert.deepEqual(rolePermissions(p), [
      "ADMI_LOGIN_OAUTH2 FULL",
      "ADMI_RESTWEBSERVICES FULL",
    ]);
  });

  it("lets a probe with a valid declaration run", () => {
    const p = project();
    withTags(p, "one", ["@permission LIST_CUSTJOB VIEW"]);
    p.script(...ok({ probe: "one", result: { ok: true }, version: "1" }));
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 0, result.all);
  });

  it("refuses a malformed tag, an unknown key or level, or a level above VIEW, at run and deploy, before anything is sent", () => {
    const p = project();
    p.script(...ok({ result: {}, version: "1" }));
    for (const line of [
      "@permission",
      "@permission LIST_CUSTJOB",
      "@permission LIST_CUSTJOB VIEW extra",
      "@permission LIST_NOT_A_KEY VIEW",
      "@permission list_custjob VIEW",
      "@permission customrecord_thing VIEW",
      "@permission LIST_CUSTJOB READ",
      "@permission LIST_CUSTJOB view",
      "@permission LIST_CUSTJOB CREATE",
      "@permission LIST_CUSTJOB EDIT",
      "@permission LIST_CUSTJOB FULL",
    ]) {
      withTags(p, "one", [line]);
      const run = cli(p, ["run", "one"]);
      assert.equal(run.status, 1, line);
      assert.match(run.stderr, /one has invalid tags/, line);
      assert.match(run.stderr, /@permission/, line);
      const deploy = cli(p, ["deploy"]);
      assert.equal(deploy.status, 1, line);
      assert.match(deploy.stderr, /- one: @permission/, line);
    }
    assert.deepEqual(p.requests(), []);
    assert.equal(existsSync(join(p.dir, "calls.json")), false);
  });
});

describe("execution roles", () => {
  const suitelet = "@scriptType Suitelet";
  const probe = (p: Project, slug: string, ...tags: string[]) =>
    write(
      p.dir,
      `verification/probes/${slug}.js`,
      probeSource(
        [tags[0]?.startsWith("@scriptType") ? "" : suitelet, ...tags]
          .filter(Boolean)
          .map((l) => ` * ${l}`)
          .join("\n"),
      ),
    );
  const roles = (p: Project) =>
    calls(p)
      .objects.filter((xml) => xml.startsWith("<role "))
      .map((xml) => ({
        id: /<role scriptid="([^"]+)">/.exec(xml)?.[1] ?? "",
        inactive: /<isinactive>T<\/isinactive>/.test(xml),
        name: /<name>([^<]*)<\/name>/.exec(xml)?.[1] ?? "",
        permissions: [
          ...xml.matchAll(
            /<permkey>([^<]+)<\/permkey>\s*<permlevel>([^<]+)<\/permlevel>/g,
          ),
        ].map((m) => `${m[1]} ${m[2]}`),
        xml,
      }));
  const execution = (p: Project) =>
    roles(p).filter((role) => role.name.startsWith("ssv exec "));
  const hostXml = (p: Project) =>
    calls(p).objects.find((o) => o.startsWith("<suitelet")) ?? "";
  const slots = (p: Project) =>
    [
      ...hostXml(p).matchAll(
        /<scriptdeployment scriptid="([^"]+)">([\s\S]*?)<\/scriptdeployment>/g,
      ),
    ].map((m) => {
      const body = m[2] ?? "";
      const field = (name: string) =>
        new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1];
      const ref = (name: string) =>
        new RegExp(`<${name}>\\[([^\\]]+)\\]</${name}>`).exec(body)?.[1];
      return {
        allroles: field("allroles"),
        audience: ref("audslctrole"),
        deployed: field("isdeployed"),
        id: m[1] ?? "",
        online: field("isonline"),
        runAs: ref("runasrole"),
        title: field("title") ?? "",
      };
    });
  const view = (key: string) => `@permission ${key} VIEW`;

  it("writes one active execution role per distinct permission set of Suitelet probes, shared by the probes that declare it, and one for no permissions", () => {
    const p = project();
    probe(p, "a", view("LIST_CUSTJOB"));
    probe(p, "b", view("LIST_CUSTJOB"));
    probe(p, "c", view("LIST_EMPLOYEE"), view("LIST_CUSTJOB"));
    probe(p, "d");
    assert.equal(cli(p, ["deploy"]).status, 0);
    const found = execution(p);
    assert.deepEqual(found.map((r) => r.permissions.join(", ")).sort(), [
      "",
      "LIST_CUSTJOB VIEW",
      "LIST_CUSTJOB VIEW, LIST_EMPLOYEE VIEW",
    ]);
    for (const role of found) {
      assert.match(role.id, /^customrole_suitescript_verify_[0-9a-f]{8}$/);
      assert.ok(role.id.length <= 40 && role.name.length <= 40, role.id);
      assert.equal(role.inactive, false);
      assert.match(role.xml, /<isinactive>F<\/isinactive>/);
    }
    assert.equal(new Set(found.map((r) => r.id)).size, 3);
    assert.equal(new Set(found.map((r) => r.name)).size, 3);
  });

  it("keeps ids and names within 40 characters for the longest runner id", () => {
    const p = project();
    probe(p, "a", view("LIST_CUSTJOB"));
    const id = "a".repeat(24);
    const result = cli(p, ["deploy"], { SUITESCRIPT_VERIFY_RUNNER_ID: id });
    assert.equal(result.status, 0, result.all);
    assert.equal(execution(p).length, 2);
    for (const role of execution(p)) {
      assert.ok(role.id.length <= 40, role.id);
      assert.ok(role.name.length <= 40, role.name);
    }
    for (const slot of slots(p)) {
      assert.ok(slot.id.length <= 40, slot.id);
      assert.ok(slot.title.length <= 40, slot.title);
    }
  });

  it("gives the same set the same role on every deploy, and another runner id another role", () => {
    const p = project();
    probe(p, "a", view("LIST_CUSTJOB"));
    assert.equal(cli(p, ["deploy"]).status, 0);
    const first = execution(p).map((r) => r.id);
    assert.equal(cli(p, ["deploy"]).status, 0);
    assert.deepEqual(
      execution(p).map((r) => r.id),
      first,
    );
    const other = cli(p, ["deploy"], { SUITESCRIPT_VERIFY_RUNNER_ID: "other" });
    assert.equal(other.status, 0, other.all);
    const second = execution(p).filter((r) => !r.inactive);
    assert.equal(second.length, 2);
    assert.equal(
      second.some((r) => first.includes(r.id)),
      false,
    );
  });

  it("writes the host's slots: runasrole set to the slot's role, the runner's role as audience, never online, unused slots off", () => {
    const p = project();
    probe(p, "a", view("LIST_CUSTJOB"));
    probe(p, "b", view("LIST_EMPLOYEE"));
    assert.equal(cli(p, ["deploy"]).status, 0);
    const found = slots(p);
    assert.deepEqual(
      found.map((s) => s.id),
      Array.from(
        { length: found.length },
        (_, i) => `customdeploy_suitescript_verify_s${i}`,
      ),
    );
    assert.equal(found.length, 10);
    const byId = new Map(execution(p).map((r) => [r.id, r]));
    for (const slot of found) {
      assert.equal(slot.audience, "customrole_suitescript_verify");
      assert.equal(slot.allroles, "F");
      assert.equal(slot.online, "F");
      assert.ok(slot.runAs && byId.has(slot.runAs), slot.id);
    }
    const used = found.filter((s) => s.deployed === "T");
    assert.deepEqual(
      used.map((s) => byId.get(s.runAs ?? "")?.permissions.join(",")),
      ["", "LIST_CUSTJOB VIEW", "LIST_EMPLOYEE VIEW"],
    );
    for (const slot of found.filter((s) => s.deployed === "F")) {
      assert.equal(slot.runAs, used[0]?.runAs);
    }
    assert.doesNotMatch(hostXml(p), /customdeploy_suitescript_verify_sl"/);
  });

  it("switches every slot off in cleanup", () => {
    const p = project();
    probe(p, "a", view("LIST_CUSTJOB"));
    assert.equal(cli(p, ["cleanup"]).status, 0);
    assert.deepEqual(new Set(slots(p).map((s) => s.deployed)), new Set(["F"]));
  });

  it("writes an earlier deploy's execution role that no slot uses as inactive, and a returning set active again", () => {
    const p = project();
    probe(p, "a", view("LIST_CUSTJOB"));
    assert.equal(cli(p, ["deploy"]).status, 0);
    const old = execution(p).find((r) => r.permissions.length === 1);
    assert.ok(old);
    probe(p, "a", view("LIST_EMPLOYEE"));
    assert.equal(cli(p, ["deploy"]).status, 0);
    const now = execution(p);
    assert.equal(now.find((r) => r.id === old.id)?.inactive, true);
    assert.deepEqual(
      now
        .filter((r) => !r.inactive)
        .map((r) => r.permissions.join(","))
        .sort(),
      ["", "LIST_EMPLOYEE VIEW"],
    );
    assert.equal(
      slots(p).some((s) => s.runAs === old.id),
      false,
      "nothing refers to the retired role",
    );
    probe(p, "a", view("LIST_CUSTJOB"));
    assert.equal(cli(p, ["deploy"]).status, 0);
    assert.equal(execution(p).find((r) => r.id === old.id)?.inactive, false);
  });

  it("removes a runner role object left under another role id, and keeps no execution role for it", () => {
    const p = project();
    assert.equal(cli(p, ["deploy"]).status, 0);
    const result = cli(p, ["deploy"], {
      SUITESCRIPT_VERIFY_ROLE_ID: "customrole_other_one",
    });
    assert.equal(result.status, 0, result.all);
    assert.deepEqual(
      roles(p)
        .filter((r) => !r.name.startsWith("ssv exec "))
        .map((r) => r.id),
      ["customrole_other_one"],
    );
  });

  it("refuses a deploy whose probes declare more permission sets than the host has slots", () => {
    const p = project();
    [
      "LIST_CUSTJOB",
      "LIST_EMPLOYEE",
      "LIST_CONTACT",
      "LIST_ITEM",
      "LIST_VENDOR",
      "LIST_PARTNER",
      "LIST_CLASS",
      "LIST_LOCATION",
      "LIST_DEPARTMENT",
      "LIST_CURRENCY",
    ].forEach((key, i) => {
      probe(p, `p${i}`, view(key));
    });
    const result = cli(p, ["deploy"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /11 different sets of permissions/);
    assert.equal(existsSync(join(p.dir, "calls.json")), false);
  });
});

/** Loads a generated script with a stubbed `define`, handing its factory the given modules. */
function load<T>(source: string, ...modules: unknown[]): T {
  let factory: ((...m: unknown[]) => T) | undefined;
  new Function("define", source)((_deps: string[], f: typeof factory) => {
    factory = f;
  });
  if (!factory) throw new Error("no define");
  return factory(...modules);
}

/** The deployment id of the host's slot `index`, as `getCurrentScript().deploymentId` names it. */
const slot = (index: number) => `customdeploy_suitescript_verify_s${index}`;

const sandbox = {
  EnvType: { PRODUCTION: "PRODUCTION", SANDBOX: "SANDBOX" },
  envType: "SANDBOX",
  /** Reads a steady 5,000 units, the RESTlet limit: nothing is spent. Reached through slot 0, which runs as no permissions. */
  getCurrentScript: () => ({
    deploymentId: slot(0),
    getRemainingUsage: () => 5000,
  }),
  getCurrentUser: () => ({
    getPermission: () => 0,
    roleId: "customrole_suitescript_verify",
  }),
  Permission: { CREATE: 2, EDIT: 3, FULL: 4, NONE: 0, VIEW: 1 },
  version: "2026.2",
};

describe("RESTlet probes that return a Promise", () => {
  type Answer = { error?: string; result?: unknown; probe?: string };
  type Runner = { post: (b: unknown) => Answer | Promise<Answer> };
  /** The generated runner with `run` as the one probe's body. */
  const runnerWith = (run: () => unknown): Runner => {
    const p = project();
    write(p.dir, "verification/probes/one.js", probeSource(restlet));
    assert.equal(cli(p, ["deploy"]).status, 0);
    return load<Runner>(calls(p).runner.join(""), sandbox, {}, { run });
  };
  const asked = { probe: "one" };

  it("waits for a returned Promise and reports what it resolves to", async () => {
    const runner = runnerWith(() => Promise.resolve({ found: [1, 2] }));
    const answer = runner.post(asked);
    assert.ok(answer instanceof Promise);
    assert.deepEqual(await answer, {
      probe: "one",
      result: { found: [1, 2] },
      scriptType: "RESTlet",
      usage: { RESTlet: { after: 5000, before: 5000 } },
      version: "2026.2",
    });
  });

  it("waits for any thenable", async () => {
    const runner = runnerWith(() => ({
      // biome-ignore lint/suspicious/noThenProperty: a thenable is what this tests
      then: (ok: (v: unknown) => void) => ok("later"),
    }));
    assert.equal((await runner.post(asked)).result, "later");
  });

  it("reports a rejection as REJECTS, kept apart from a synchronous throw", async () => {
    const rejects = runnerWith(() =>
      Promise.reject(Object.assign(new Error("gone"), { name: "NOT_FOUND" })),
    );
    assert.equal(
      (await rejects.post(asked)).result,
      "REJECTS: NOT_FOUND: gone",
    );
    const throws = runnerWith(() => {
      throw Object.assign(new Error("boom"), { name: "TypeError" });
    });
    const answer = throws.post(asked);
    assert.ok(!(answer instanceof Promise));
    assert.equal(answer.result, "THROWS: TypeError: boom");
  });

  it("reports a rejection that is not an Error as its text", async () => {
    for (const [reason, expected] of [
      [undefined, "REJECTS: undefined"],
      ["plain words", "REJECTS: plain words"],
      [42, "REJECTS: 42"],
      [{ code: 7 }, "REJECTS: [object Object]"],
    ] as const) {
      const runner = runnerWith(() => Promise.reject(reason));
      assert.equal((await runner.post(asked)).result, expected);
    }
  });

  it("keeps a synchronous probe and the self-check on the same path, returning no Promise", () => {
    const runner = runnerWith(() => ({ ok: true }));
    const answer = runner.post(asked);
    assert.ok(!(answer instanceof Promise));
    assert.deepEqual(answer.result, { ok: true });
  });

  it("makes a synchronous result that holds a Promise an error naming the path", () => {
    const runner = runnerWith(() => ({
      page: { items: [1, { cursor: Promise.resolve(1) }] },
    }));
    const answer = runner.post(asked) as Answer;
    assert.deepEqual(answer, {
      error:
        "the result holds a Promise that was not awaited at page.items[1].cursor",
    });
  });

  it("makes an awaited result that holds a Promise an error, and does not loop on a cycle", async () => {
    const runner = runnerWith(() =>
      // biome-ignore lint/suspicious/noThenProperty: a thenable is what this tests
      Promise.resolve({ cursor: { then() {} }, name: "x" }),
    );
    assert.equal(
      (await runner.post(asked)).error,
      "the result holds a Promise that was not awaited at cursor",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.deepEqual(
      (runnerWith(() => cyclic).post(asked) as Answer).result,
      cyclic,
    );
  });

  it("makes the CLI report the lost await as an error, not a result", () => {
    const p = project();
    write(p.dir, "verification/probes/one.js", probeSource(restlet));
    p.script(
      ...ok({
        error: "the result holds a Promise that was not awaited at cursor",
      }),
    );
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /The runner reported an error: the result holds a Promise that was not awaited at cursor/,
    );
  });
});

describe("a RESTlet probe's usage", () => {
  type Usage = { after: number; before: number };
  type Answer = {
    error?: string;
    result?: unknown;
    usage?: Record<string, Usage>;
  };
  type Runner = { post: (b: unknown) => Answer | Promise<Answer> };
  /** A runtime whose remaining units read as the given numbers, in order, then stay at the last. */
  const counting = (...readings: number[]) => {
    const left = [...readings];
    return {
      ...sandbox,
      getCurrentScript: () => ({
        getRemainingUsage: () =>
          left.length > 1 ? (left.shift() as number) : (left[0] as number),
      }),
    };
  };
  const runnerWith = (run: () => unknown, runtime: object): Runner => {
    const p = project();
    write(p.dir, "verification/probes/one.js", probeSource(restlet));
    assert.equal(cli(p, ["deploy"]).status, 0);
    return load<Runner>(calls(p).runner.join(""), runtime, {}, { run });
  };
  const asked = { probe: "one" };

  it("reports the units remaining before and after a returned result", () => {
    const runner = runnerWith(() => ({ ok: true }), counting(5000, 4990));
    const answer = runner.post(asked) as Answer;
    assert.deepEqual(answer.result, { ok: true });
    assert.deepEqual(answer.usage, { RESTlet: { after: 4990, before: 5000 } });
  });

  it("reports usage for a throw, whose result is the THROWS text", () => {
    const runner = runnerWith(
      () => {
        throw Object.assign(new Error("boom"), { name: "TypeError" });
      },
      counting(5000, 4980),
    );
    const answer = runner.post(asked) as Answer;
    assert.equal(answer.result, "THROWS: TypeError: boom");
    assert.deepEqual(answer.usage, { RESTlet: { after: 4980, before: 5000 } });
  });

  it("reports usage for a throw that is not an Error instance", () => {
    const runner = runnerWith(
      () => {
        throw { message: "out", name: "SSS_USAGE_LIMIT_EXCEEDED" };
      },
      counting(5000, 0),
    );
    const answer = runner.post(asked) as Answer;
    assert.equal(answer.result, "THROWS: SSS_USAGE_LIMIT_EXCEEDED: out");
    assert.deepEqual(answer.usage, {
      RESTlet: { after: 0, before: 5000, exceeded: true },
    });
  });

  it("reports usage for a rejection", async () => {
    const runner = runnerWith(
      () => Promise.reject(Object.assign(new Error("gone"), { name: "NOPE" })),
      counting(5000, 4000),
    );
    const answer = await runner.post(asked);
    assert.equal(answer.result, "REJECTS: NOPE: gone");
    assert.deepEqual(answer.usage, { RESTlet: { after: 4000, before: 5000 } });
  });

  it("reads after once a returned Promise has settled", async () => {
    let settle: (v: unknown) => void = () => {};
    let readings = 0;
    const runtime = {
      ...sandbox,
      getCurrentScript: () => ({
        getRemainingUsage: () => (++readings === 1 ? 5000 : 4900),
      }),
    };
    const runner = runnerWith(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
      runtime,
    );
    const pending = runner.post(asked) as Promise<Answer>;
    assert.equal(readings, 1);
    settle({ ok: true });
    const answer = await pending;
    assert.equal(readings, 2);
    assert.deepEqual(answer.usage, { RESTlet: { after: 4900, before: 5000 } });
  });

  describe("exceeded", () => {
    const limit = { message: "out", name: "SSS_USAGE_LIMIT_EXCEEDED" };

    it("is set when the probe throws the limit error", () => {
      const runner = runnerWith(
        () => {
          throw Object.assign(new Error("out"), { name: limit.name });
        },
        counting(5000, 3000),
      );
      const answer = runner.post(asked) as Answer;
      assert.deepEqual(answer.usage, {
        RESTlet: { after: 3000, before: 5000, exceeded: true },
      });
    });

    it("is set for a thrown object that is not an Error instance", () => {
      const runner = runnerWith(
        () => {
          throw limit;
        },
        counting(5000, 3000),
      );
      const answer = runner.post(asked) as Answer;
      assert.deepEqual(answer.usage, {
        RESTlet: { after: 3000, before: 5000, exceeded: true },
      });
    });

    it("is set when the probe rejects with the limit error", async () => {
      const runner = runnerWith(
        () => Promise.reject(limit),
        counting(5000, 3000),
      );
      const answer = await runner.post(asked);
      assert.deepEqual(answer.usage, {
        RESTlet: { after: 3000, before: 5000, exceeded: true },
      });
    });

    it("is set when the probe caught the limit error and returned, because after is 0", () => {
      const runner = runnerWith(() => "caught it", counting(5000, 0));
      const answer = runner.post(asked) as Answer;
      assert.equal(answer.result, "caught it");
      assert.deepEqual(answer.usage, {
        RESTlet: { after: 0, before: 5000, exceeded: true },
      });
    });

    it("is absent when neither condition holds", () => {
      const runner = runnerWith(
        () => {
          throw { message: "x", name: "OTHER" };
        },
        counting(5000, 10),
      );
      const answer = runner.post(asked) as Answer;
      assert.equal("exceeded" in (answer.usage?.RESTlet ?? {}), false);
    });
  });

  it("carries no usage on a refused request", () => {
    const runner = runnerWith(() => ({ ok: true }), counting(5000, 4990));
    for (const body of [
      { probe: "nope" },
      { params: { x: "1" }, probe: "one" },
    ]) {
      const answer = runner.post(body) as Answer;
      assert.ok(answer.error, JSON.stringify(answer));
      assert.equal("usage" in answer, false);
    }
    const lost = runnerWith(
      () => ({ cursor: Promise.resolve(1) }),
      counting(5000, 4990),
    ).post(asked) as Answer;
    assert.ok(lost.error);
    assert.equal("usage" in lost, false);
  });
});

describe("the two templates' shared helpers", () => {
  // The runner and the Suitelet host deploy as separate scripts, so each keeps
  // its own copy of these helpers. The copies must not drift apart.
  const source = (file: string) =>
    readFileSync(join(root, "templates", file), "utf8").replaceAll(
      "\r\n",
      "\n",
    );
  const helper = (text: string, name: string) => {
    const start = text.indexOf(`\n  const ${name} = `);
    assert.notEqual(start, -1, `${name} is missing`);
    return text.slice(start, text.indexOf("\n  };\n", start));
  };
  for (const name of [
    "isThenable",
    "findLostAwait",
    "lostAwait",
    "rejection",
    "usageEntry",
  ]) {
    it(`keeps ${name} identical in both`, () => {
      assert.equal(
        helper(source("runner.template.js"), name),
        helper(source("suitelet.template.js"), name),
      );
    });
  }
});

describe("Suitelet probes", () => {
  const suitelet = "@scriptType Suitelet";
  const withProbe = (p: Project, tags: string, slug: string) =>
    write(p.dir, `verification/probes/${slug}.js`, probeSource(tags));
  const hostObject = (p: Project) =>
    calls(p).objects.find((o) => o.startsWith("<suitelet")) ?? "";

  it("deploys the Suitelet host beside the runner, with only Suitelet probes in its list", () => {
    const p = project();
    withProbe(p, restlet, "one");
    withProbe(p, suitelet, "page");
    const result = cli(p, ["deploy"]);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /Probes in the runner: one\n/);
    assert.match(result.stdout, /Probes in the Suitelet host: page\n/);
    const call = calls(p);
    assert.deepEqual(
      call.files
        .map((f) => f.replaceAll("\\", "/"))
        .filter((f) => f.endsWith(".js"))
        .sort(),
      [
        "SuiteScripts/suitescript-verify/probes/one.js",
        "SuiteScripts/suitescript-verify/probes/page.js",
        "SuiteScripts/suitescript-verify/restlet.js",
        "SuiteScripts/suitescript-verify/suitelet.js",
      ],
    );
    const host = call.suitelet.join("");
    assert.match(host, /"\.\/probes\/page"/);
    assert.doesNotMatch(host, /"\.\/probes\/one"/);
    assert.match(host, /@NScriptType Suitelet/);
    assert.match(host, /EnvType\.SANDBOX/);
    assert.doesNotMatch(host, /\beval\b|new Function|require\(/);
    assert.doesNotMatch(call.runner.join(""), /"\.\/probes\/page"/);
  });

  it("gives the host a deployment never available without login, for the runner's role only, released", () => {
    const p = project();
    assert.equal(cli(p, ["deploy"]).status, 0);
    const host = hostObject(p);
    assert.match(
      host,
      /<suitelet scriptid="customscript_suitescript_verify_sl">/,
    );
    assert.match(host, /scriptid="customdeploy_suitescript_verify_s0"/);
    assert.match(host, /<name>ssv suitelet suitescript_verify<\/name>/);
    assert.match(host, /<title>ssv suitelet suitescript_verify s0<\/title>/);
    assert.match(
      host,
      /<description>[^<]*suitescript-verify[^<]*<\/description>/,
    );
    assert.match(host, /\[\/SuiteScripts\/suitescript-verify\/suitelet\.js\]/);
    assert.match(host, /<isonline>F<\/isonline>/);
    assert.match(host, /<allroles>F<\/allroles>/);
    assert.match(host, /<audslctrole>\[customrole_[a-z0-9_]+\]<\/audslctrole>/);
    assert.doesNotMatch(host, /<allemployees>T|<allpartners>T/);
    assert.match(host, /<status>RELEASED<\/status>/);
    assert.match(host, /<isdeployed>T<\/isdeployed>/);
    assert.match(calls(p).suitelet.join(""), /new Map\(\[\s*\]\)/);
  });

  it("switches the host's slots off in cleanup, with the runner", () => {
    const p = project();
    withProbe(p, suitelet, "page");
    assert.equal(cli(p, ["cleanup"]).status, 0);
    const objects = calls(p).objects.join("");
    // The runner and the host's ten slots.
    assert.equal(objects.match(/<isdeployed>F<\/isdeployed>/g)?.length, 11);
    assert.doesNotMatch(objects, /<isdeployed>T/);
  });

  it("refuses a bad tag on a Suitelet probe at deploy", () => {
    const p = project();
    withProbe(p, `${suitelet}\n * @param 1bad x`, "page");
    const result = cli(p, ["deploy"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /page: @param/);
    assert.equal(existsSync(join(p.dir, "calls.json")), false);
  });

  it("runs a Suitelet probe through the runner and reports its result and script type", () => {
    const p = project();
    withProbe(p, suitelet, "page");
    p.script(
      ...ok({
        probe: "page",
        result: { ok: true },
        scriptType: "Suitelet",
        version: "2026.2",
      }),
    );
    const result = cli(p, ["run", "page"]);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /"scriptType": "Suitelet"/);
    assert.match(result.stdout, /"ok": true/);
    const [, call] = p.requests();
    assert.match(call?.url ?? "", /script=customscript_suitescript_verify_rl&/);
    assert.equal(call?.body, JSON.stringify({ probe: "page" }));
  });

  it("compares a Suitelet probe's result with its expected output", () => {
    const p = project();
    withProbe(p, suitelet, "page");
    write(p.dir, "verification/probes/page.expect.json", '{"ok": true}');
    const answer = { probe: "page", scriptType: "Suitelet", version: "1" };
    p.script(...ok({ ...answer, result: { ok: true } }));
    assert.match(cli(p, ["run", "page"]).stdout, /Matches the expected output/);
    p.script(...ok({ ...answer, result: { ok: false } }));
    const drift = cli(p, ["run", "page"]);
    assert.equal(drift.status, 2);
    assert.match(drift.stdout, /DRIFT/);
  });

  describe("a probe that writes its own response", () => {
    const own = (response: Record<string, unknown>) =>
      ok({ probe: "page", response, scriptType: "Suitelet", version: "1" });

    it("prints usage beside the response, and an expectation on the response still matches whatever the usage", () => {
      const p = project();
      withProbe(p, suitelet, "page");
      write(
        p.dir,
        "verification/probes/page.expect.json",
        JSON.stringify({ body: "hi", headers: {}, status: 200 }),
      );
      for (const after of [900, 100]) {
        const usage = {
          RESTlet: { after: 4990, before: 5000 },
          Suitelet: { after, before: 1000 },
        };
        p.script(
          ...ok({
            probe: "page",
            response: { body: "hi", headers: {}, status: 200 },
            scriptType: "Suitelet",
            usage,
            version: "1",
          }),
        );
        const run = cli(p, ["run", "page"]);
        assert.equal(run.status, 0);
        assert.match(run.stdout, /Matches the expected output/);
        const printed = JSON.parse(
          run.stdout.slice(0, run.stdout.lastIndexOf("}") + 1),
        );
        assert.deepEqual(printed.usage, usage);
        assert.ok(printed.response);
      }
    });

    it("reports status, headers and body, with cookies but sv_* and credential-like headers redacted and the body cut at 64 KB, even from a runner that did not", () => {
      const p = project();
      withProbe(p, suitelet, "page");
      p.script(
        ...own({
          body: "y".repeat(70 * 1024),
          headers: {
            Authorization: "Bearer abc123",
            "Content-Disposition":
              "attachment; filename=\"abc123.pdf\"; filename*=UTF-8''abc123.pdf",
            "Content-Type": "text/html",
            "Set-Cookie": ["JSESSIONID=abc123; Path=/", "sv_flavor=sweet"],
            "X-Api-Token": "abc123",
            "X-Hmac": "abc123",
            "X-Signature": "abc123",
          },
          status: 200,
        }),
      );
      const result = cli(p, ["run", "page"]);
      assert.equal(result.status, 0, result.all);
      assert.equal(result.all.includes("abc123"), false);
      const { response } = JSON.parse(result.stdout);
      assert.deepEqual(response.headers, {
        authorization: "<redacted>",
        "content-disposition":
          "attachment; filename=<redacted>; filename*=<redacted>",
        "content-type": "text/html",
        "set-cookie": ["JSESSIONID=<redacted>", "sv_flavor=sweet"],
        "x-api-token": "<redacted>",
        "x-hmac": "<redacted>",
        "x-signature": "<redacted>",
      });
      assert.equal(response.body, "y".repeat(64 * 1024));
      assert.equal(response.truncated, true);
      assert.equal(response.status, 200);
    });

    it("drops NetSuite's HTML trailer, the host's X-SSV- headers and header case variants even from a runner that did not", () => {
      const p = project();
      withProbe(p, suitelet, "page");
      p.script(
        ...own({
          body: `<p>hello</p>${trailer}`,
          headers: {
            "Content-Type": "text/html; charset=UTF-8",
            "content-type": "text/html; charset=UTF-8",
            "Set-Cookie": "JSESSIONID=abc123; Path=/",
            "set-cookie": "JSESSIONID=abc123; Path=/",
            "X-SSV-Headers": "[]",
            "x-ssv-mode": "own",
          },
          status: 200,
        }),
      );
      const result = cli(p, ["run", "page"]);
      assert.equal(result.status, 0, result.all);
      assert.deepEqual(JSON.parse(result.stdout).response, {
        body: "<p>hello</p>",
        headers: {
          "content-type": "text/html; charset=UTF-8",
          "set-cookie": "JSESSIONID=<redacted>",
        },
        status: 200,
      });
    });

    it("refuses to print a response that still looks like an identifier", () => {
      const p = project();
      withProbe(p, suitelet, "page");
      p.script(
        ...own({
          body: "",
          headers: { "X-Link": "https://x.app.netsuite.com/app/center" },
          status: 200,
        }),
      );
      const result = cli(p, ["run", "page"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Refusing to print or record the output/);
    });

    it("compares status, body and every reported header with the expected output, by lower-cased name", () => {
      const p = project();
      withProbe(p, suitelet, "page");
      write(
        p.dir,
        "verification/probes/page.expect.json",
        JSON.stringify({
          body: "<p>hi</p>",
          headers: { "Content-Type": "text/html", "X-Probe": "1" },
          status: 200,
        }),
      );
      const answer = {
        body: "<p>hi</p>",
        headers: { "content-type": "text/html", "x-probe": "1" },
        status: 200,
      };
      p.script(...own(answer));
      const same = cli(p, ["run", "page"]);
      assert.equal(same.status, 0, same.all);
      assert.match(same.stdout, /Matches the expected output/);
      for (const changed of [
        { ...answer, body: "<p>bye</p>" },
        { ...answer, status: 302 },
        { ...answer, headers: { ...answer.headers, "x-probe": "2" } },
        { ...answer, headers: { ...answer.headers, "x-other": "1" } },
        { ...answer, headers: { ...answer.headers, date: "today" } },
      ]) {
        p.script(...own(changed));
        const drift = cli(p, ["run", "page"]);
        assert.equal(drift.status, 2, JSON.stringify(changed));
        assert.match(drift.stdout, /DRIFT/);
      }
      p.script(
        ...own({
          ...answer,
          headers: { "content-type": "text/html", "x-other": "1" },
        }),
      );
      assert.match(
        cli(p, ["run", "page"]).stdout,
        /differs from page\.expect\.json at response\.headers\.x-other, response\.headers\.x-probe\./,
      );
    });

    it("records the response in a draft results page", () => {
      const p = project();
      withProbe(p, suitelet, "page");
      p.script(...own({ body: "<p>hi</p>", headers: {}, status: 200 }));
      assert.equal(cli(p, ["run", "page", "--draft"]).status, 0);
      const text = readFileSync(
        join(p.dir, "docs", "verification", "results", "page.md"),
        "utf8",
      );
      assert.match(text, /"body": "<p>hi<\/p>"/);
      assert.match(text, /"status": 200/);
    });
  });

  it("drafts a results page that names the method as a deployed Suitelet called by the runner", () => {
    const p = project();
    withProbe(p, suitelet, "page");
    p.script(...ok({ result: 1, scriptType: "Suitelet", version: "2026.2" }));
    assert.equal(cli(p, ["run", "page", "--draft"]).status, 0);
    const text = readFileSync(
      join(p.dir, "docs", "verification", "results", "page.md"),
      "utf8",
    );
    assert.match(
      text,
      /\*\*Method:\*\* deployed Suitelet \(the suitescript-verify Suitelet host, called by the runner\)/,
    );
  });

  it("reports a failed host call the runner saw, without crashing", () => {
    const p = project();
    withProbe(p, suitelet, "page");
    p.script(
      ...ok({ error: "the Suitelet host answered HTTP 500: Internal error" }),
    );
    const result = cli(p, ["run", "page"]);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /The runner reported an error: the Suitelet host answered HTTP 500: Internal error/,
    );
  });

  describe("the generated runner", () => {
    type Runner = {
      post: (b: unknown) => {
        error?: string;
        probe?: string;
        response?: unknown;
        result?: unknown;
        scriptType?: string;
        version?: string;
      };
    };
    const runnerFor = (
      p: Project,
      requestSuitelet: (options: unknown) => unknown,
      runtime: object = sandbox,
    ) => {
      withProbe(p, restlet, "one");
      withProbe(p, `${suitelet}\n * @param id ^[0-9]+$`, "page");
      assert.equal(cli(p, ["deploy"]).status, 0);
      return load<Runner>(
        calls(p).runner.join(""),
        runtime,
        { requestSuitelet },
        { run: () => "restlet" },
      );
    };
    /** A runtime whose remaining units read as the given numbers, in order, then stay at the last. */
    const counting = (...readings: number[]) => {
      const left = [...readings];
      return {
        ...sandbox,
        getCurrentScript: () => ({
          getRemainingUsage: () =>
            left.length > 1 ? (left.shift() as number) : (left[0] as number),
        }),
      };
    };
    const usageOf = (answer: unknown) => (answer as { usage?: unknown }).usage;

    it("calls the host with requestSuitelet, the host's ids and the probe and parameters as urlParams", () => {
      const p = project();
      const seen: unknown[] = [];
      const runner = runnerFor(p, (options) => {
        seen.push(options);
        return {
          body: JSON.stringify({ probe: "page", result: { ok: 1 } }),
          code: 200,
          headers: { "X-SSV-Mode": "wrapped" },
        };
      });
      assert.deepEqual(runner.post({ params: { id: "42" }, probe: "page" }), {
        probe: "page",
        result: { ok: 1 },
        scriptType: "Suitelet",
        usage: { RESTlet: { after: 5000, before: 5000 } },
        version: "2026.2",
      });
      assert.deepEqual(seen, [
        {
          deploymentId: "customdeploy_suitescript_verify_s0",
          scriptId: "customscript_suitescript_verify_sl",
          urlParams: { params: JSON.stringify({ id: "42" }), probe: "page" },
        },
      ]);
      assert.equal(runner.post({ probe: "one" }).scriptType, "RESTlet");
    });

    it("checks a Suitelet probe's parameters before calling the host", () => {
      const p = project();
      let count = 0;
      const runner = runnerFor(p, () => {
        count++;
        return { body: "{}", code: 200 };
      });
      for (const params of [{ id: "x" }, { extra: "1", id: "1" }, {}]) {
        assert.match(
          runner.post({ params, probe: "page" }).error ?? "",
          /param/,
        );
      }
      assert.equal(count, 0);
      assert.equal(runner.post({ probe: "nope" }).error, "unknown probe");
    });

    it("reports a thrown error, a non-200 status, a missing marker and a non-JSON body, never throwing", () => {
      const p = project();
      const wrapped = { "x-ssv-mode": "wrapped" };
      const answers: (() => unknown)[] = [
        () => {
          const e = new Error("An unexpected SuiteScript error has occurred");
          e.name = "UNEXPECTED_ERROR";
          throw e;
        },
        () => ({ body: "Internal error", code: 500 }),
        () => ({ body: '{"result":"forged"}', code: 200, headers: {} }),
        () => ({ body: "<html>login</html>", code: 200, headers: wrapped }),
        () => ({
          body: JSON.stringify({ error: "unknown probe" }),
          code: 200,
          headers: wrapped,
        }),
      ];
      let next = 0;
      const runner = runnerFor(p, () => answers[next++]?.());
      const errors = answers.map(
        () => runner.post({ params: { id: "1" }, probe: "page" }).error,
      );
      assert.deepEqual(errors, [
        "the Suitelet host call failed: UNEXPECTED_ERROR: An unexpected SuiteScript error has occurred",
        "the Suitelet host answered HTTP 500: Internal error",
        'the Suitelet host answered HTTP 200 without its X-SSV-Mode header (a followed redirect or a login page does this): {"result":"forged"}',
        "the Suitelet host's answer was not JSON: <html>login</html>",
        "the Suitelet host refused: unknown probe",
      ]);
    });

    describe("its slots", () => {
      const wrapped = { "x-ssv-mode": "wrapped" };
      const deployAll = (p: Project) => {
        withProbe(p, restlet, "one");
        withProbe(p, `${restlet}\n * @permission LIST_CUSTJOB VIEW`, "gated");
        withProbe(p, suitelet, "plain");
        withProbe(p, `${suitelet}\n * @permission LIST_CUSTJOB VIEW`, "seen");
        withProbe(
          p,
          `${suitelet}\n * @permission LIST_CUSTJOB VIEW\n * @permission LIST_EMPLOYEE VIEW`,
          "both",
        );
        assert.equal(cli(p, ["deploy"]).status, 0);
        return calls(p).runner.join("");
      };

      it("sends each Suitelet probe to the slot of its permission set", () => {
        const p = project();
        const seen: { deploymentId: string; probe: string }[] = [];
        const runner = load<Runner>(
          deployAll(p),
          sandbox,
          {
            requestSuitelet: (options: {
              deploymentId: string;
              urlParams: { probe: string };
            }) => {
              seen.push({
                deploymentId: options.deploymentId,
                probe: options.urlParams.probe,
              });
              return {
                body: JSON.stringify({ result: 1 }),
                code: 200,
                headers: wrapped,
              };
            },
          },
          { run: () => "restlet" },
        );
        for (const probe of ["plain", "seen", "both"]) runner.post({ probe });
        // Sets sort by their text: none, then LIST_CUSTJOB, then LIST_CUSTJOB with LIST_EMPLOYEE.
        assert.deepEqual(seen, [
          { deploymentId: slot(0), probe: "plain" },
          { deploymentId: slot(1), probe: "seen" },
          { deploymentId: slot(2), probe: "both" },
        ]);
      });

      it("reports the role's levels the host answered with, for a wrapped answer and an own one", () => {
        const p = project();
        const levels = { LIST_CUSTJOB: "VIEW", LIST_EMPLOYEE: "NONE" };
        const answers = [
          {
            body: JSON.stringify({ permissions: levels, result: 1 }),
            code: 200,
            headers: wrapped,
          },
          {
            body: "hi",
            code: 200,
            headers: {
              "content-type": "text/plain",
              "x-ssv-mode": "own",
              "x-ssv-permissions": JSON.stringify(levels),
            },
          },
        ];
        const runner = load<Runner>(
          deployAll(p),
          sandbox,
          { requestSuitelet: () => answers.shift() },
          { run: () => "restlet" },
        );
        for (let i = 0; i < 2; i++) {
          const answer = runner.post({ probe: "both" }) as {
            permissions?: unknown;
          };
          assert.deepEqual(answer.permissions, levels);
        }
      });

      it("drops a levels report that is not a map of strings, rather than trusting it", () => {
        const p = project();
        const runner = load<Runner>(
          deployAll(p),
          sandbox,
          {
            requestSuitelet: () => ({
              body: JSON.stringify({ permissions: { A: 1 }, result: 1 }),
              code: 200,
              headers: wrapped,
            }),
          },
          { run: () => "restlet" },
        );
        assert.equal(
          "permissions" in (runner.post({ probe: "both" }) as object),
          false,
        );
      });

      it("refuses a RESTlet probe that declares a permission, which the runner's role cannot give it, without running it", () => {
        const p = project();
        let ran = 0;
        const runner = load<Runner>(
          deployAll(p),
          sandbox,
          { requestSuitelet: () => ({ body: "{}", code: 200 }) },
          { run: () => ran++ },
        );
        assert.match(
          runner.post({ probe: "gated" }).error ?? "",
          /RESTlet probe that declares a permission/,
        );
        assert.equal(ran, 0);
        assert.equal(runner.post({ probe: "one" }).scriptType, "RESTlet");
      });
    });

    describe("usage", () => {
      const wrapped = { "x-ssv-mode": "wrapped" };
      const asked = { params: { id: "1" }, probe: "page" };

      it("reports the host's reading beside the runner's, which surrounds the call and so includes what it spends", () => {
        const p = project();
        const runner = runnerFor(
          p,
          () => ({
            body: JSON.stringify({
              result: 1,
              usage: { after: 990, before: 1000 },
            }),
            code: 200,
            headers: wrapped,
          }),
          counting(5000, 4990),
        );
        assert.deepEqual(usageOf(runner.post(asked)), {
          RESTlet: { after: 4990, before: 5000 },
          Suitelet: { after: 990, before: 1000 },
        });
      });

      it("reads the host's reading of an own response from X-SSV-Usage, never reporting that header", () => {
        const p = project();
        const runner = runnerFor(
          p,
          () => ({
            body: "<p>hi</p>",
            code: 200,
            headers: {
              "X-SSV-Mode": "own",
              "X-SSV-Usage": JSON.stringify({ after: 900, before: 1000 }),
            },
          }),
          counting(5000, 4990),
        );
        const answer = runner.post(asked) as {
          response: { headers: Record<string, unknown> };
        };
        assert.deepEqual(usageOf(answer), {
          RESTlet: { after: 4990, before: 5000 },
          Suitelet: { after: 900, before: 1000 },
        });
        assert.deepEqual(answer.response.headers, {});
      });

      it("never reports X-SSV-Usage even when a probe's header report names it", () => {
        const p = project();
        const runner = runnerFor(p, () => ({
          body: "x",
          code: 200,
          headers: {
            "X-SSV-Headers": JSON.stringify([
              { name: "X-SSV-Usage", value: "forged" },
            ]),
            "X-SSV-Mode": "own",
          },
        }));
        const answer = runner.post(asked) as {
          response: { headers: Record<string, unknown> };
        };
        assert.deepEqual(answer.response.headers, {});
      });

      it("reports only the runner's entry when the host call fails or the host does not answer", () => {
        const answers: (() => unknown)[] = [
          () => {
            const e = new Error("the request took too long");
            e.name = "SSS_REQUEST_TIME_EXCEEDED";
            throw e;
          },
          () => ({ body: "Internal error", code: 500 }),
          () => ({ body: "{}", code: 200, headers: {} }),
          () => ({ body: "nope", code: 200, headers: wrapped }),
          () => ({
            body: JSON.stringify({ error: "unknown probe" }),
            code: 200,
            headers: wrapped,
          }),
        ];
        for (const reply of answers) {
          const runner = runnerFor(project(), reply, counting(5000, 4000));
          const answer = runner.post(asked);
          assert.ok(answer.error);
          assert.deepEqual(usageOf(answer), {
            RESTlet: { after: 4000, before: 5000 },
          });
        }
      });

      it("keeps the host's reading when it refused after the probe ran", () => {
        const p = project();
        const runner = runnerFor(
          p,
          () => ({
            body: JSON.stringify({
              error: "the probe both wrote a response and returned a value",
              usage: { after: 940, before: 1000 },
            }),
            code: 200,
            headers: wrapped,
          }),
          counting(5000, 4990),
        );
        const answer = runner.post(asked);
        assert.match(answer.error ?? "", /both wrote/);
        assert.deepEqual(usageOf(answer), {
          RESTlet: { after: 4990, before: 5000 },
          Suitelet: { after: 940, before: 1000 },
        });
      });

      it("keeps a host answer's usage when the probe threw or rejected, and drops a malformed reading", () => {
        const p = project();
        const answers = [
          { result: "THROWS: TypeError: boom", usage: { after: 5, before: 9 } },
          { result: "REJECTS: Error: no", usage: { after: 0, before: 9 } },
          { result: 1, usage: { after: "x", before: 9 } },
          { result: 1, usage: null },
        ];
        let next = 0;
        const runner = runnerFor(p, () => ({
          body: JSON.stringify(answers[next++]),
          code: 200,
          headers: wrapped,
        }));
        const suitelets = answers.map(
          () =>
            (usageOf(runner.post(asked)) as { Suitelet?: unknown }).Suitelet,
        );
        assert.deepEqual(suitelets, [
          { after: 5, before: 9 },
          { after: 0, before: 9 },
          undefined,
          undefined,
        ]);
      });
    });

    describe("usage exceeded", () => {
      const asked = { params: { id: "1" }, probe: "page" };

      it("passes a host's exceeded flag through, and drops one that is not true", () => {
        const p = project();
        const answers = [
          { result: 1, usage: { after: 0, before: 9, exceeded: true } },
          { result: 1, usage: { after: 5, before: 9, exceeded: "yes" } },
        ];
        let next = 0;
        const runner = runnerFor(p, () => ({
          body: JSON.stringify(answers[next++]),
          code: 200,
          headers: { "x-ssv-mode": "wrapped" },
        }));
        const suitelets = answers.map(
          () =>
            (usageOf(runner.post(asked)) as { Suitelet?: unknown }).Suitelet,
        );
        assert.deepEqual(suitelets, [
          { after: 0, before: 9, exceeded: true },
          { after: 5, before: 9 },
        ]);
      });

      it("passes the flag from X-SSV-Usage for an own response", () => {
        const p = project();
        const runner = runnerFor(p, () => ({
          body: "x",
          code: 200,
          headers: {
            "X-SSV-Mode": "own",
            "X-SSV-Usage": JSON.stringify({
              after: 0,
              before: 1000,
              exceeded: true,
            }),
          },
        }));
        assert.deepEqual(
          (usageOf(runner.post(asked)) as { Suitelet?: unknown }).Suitelet,
          { after: 0, before: 1000, exceeded: true },
        );
      });

      it("flags the runner's entry when its own units reach 0 during the host call", () => {
        const p = project();
        const runner = runnerFor(
          p,
          () => ({
            body: JSON.stringify({ result: 1, usage: { after: 9, before: 9 } }),
            code: 200,
            headers: { "x-ssv-mode": "wrapped" },
          }),
          counting(5, 0),
        );
        assert.deepEqual(usageOf(runner.post(asked)), {
          RESTlet: { after: 0, before: 5, exceeded: true },
          Suitelet: { after: 9, before: 9 },
        });
      });

      it("flags the runner's entry when the host call itself throws the limit error", () => {
        const p = project();
        const runner = runnerFor(
          p,
          () => {
            throw { message: "out", name: "SSS_USAGE_LIMIT_EXCEEDED" };
          },
          counting(5, 2),
        );
        assert.deepEqual(usageOf(runner.post(asked)), {
          RESTlet: { after: 2, before: 5, exceeded: true },
        });
      });
    });

    it("reports a probe's own response as status, headers and body, cutting the body", () => {
      const p = project();
      const big = "x".repeat(70 * 1024);
      const answers = [
        {
          body: "<p>hi</p>",
          code: 201,
          headers: {
            "Content-Type": "text/html",
            "X-SSV-Headers": JSON.stringify([{ name: "X-Probe", value: "1" }]),
            "X-SSV-Mode": "own",
          },
        },
        { body: big, code: 200, headers: { "x-ssv-mode": ["own"] } },
      ];
      let next = 0;
      const runner = runnerFor(p, () => answers[next++]);
      assert.deepEqual(runner.post({ params: { id: "1" }, probe: "page" }), {
        probe: "page",
        response: {
          body: "<p>hi</p>",
          headers: { "content-type": "text/html", "x-probe": "1" },
          status: 201,
        },
        scriptType: "Suitelet",
        usage: { RESTlet: { after: 5000, before: 5000 } },
        version: "2026.2",
      });
      const cut = runner.post({ params: { id: "1" }, probe: "page" });
      assert.deepEqual(cut.response, {
        body: "x".repeat(64 * 1024),
        headers: {},
        status: 200,
        truncated: true,
      });
    });

    describe("reports the headers that are safe to commit", () => {
      /** The headers the runner reports for an own answer with these platform headers and, if given, this X-SSV-Headers report. */
      const reported = (
        platform: Record<string, unknown>,
        probe?: { name: string; value: string }[] | string,
      ) => {
        const p = project();
        const runner = runnerFor(p, () => ({
          body: "hi",
          code: 200,
          headers: {
            ...platform,
            "X-SSV-Mode": "own",
            ...(probe === undefined
              ? {}
              : {
                  "X-SSV-Headers":
                    typeof probe === "string" ? probe : JSON.stringify(probe),
                }),
          },
        }));
        const { response } = runner.post({
          params: { id: "1" },
          probe: "page",
        });
        return (response as { headers: Record<string, unknown> }).headers;
      };
      /** Platform headers of one call: per-call ids, routing, a session cookie and an unknown NetSuite header. */
      const perCall = {
        "Akamai-GRN": "0.1",
        Date: "Tue, 17 Nov 2026 10:00:00 GMT",
        "Set-Cookie": "JSESSIONID=abc123; Path=/; Secure",
        Via: "1.1 edge002",
        "X-Cache": "TCP_MISS from edge-b",
        "X-N-OperationId": "op-2",
        "x-ns-foo": "bar",
      };

      it("keeps only the platform headers that describe the content, one lower-cased key each", () => {
        assert.deepEqual(
          reported(
            {
              ...perCall,
              "Cache-Control": "no-store",
              "Content-Disposition": "inline",
              "Content-Encoding": "gzip",
              "Content-Language": "en",
              "Content-Type": "text/plain",
              "content-language": "fr",
              "content-type": "text/plain",
            },
            [],
          ),
          {
            "cache-control": "no-store",
            "content-disposition": "inline",
            "content-encoding": "gzip",
            "content-language": ["en", "fr"],
            "content-type": "text/plain",
          },
        );
      });

      it("keeps every header the probe set, with both values of two addHeader calls of one name", () => {
        assert.deepEqual(
          reported({ ...perCall, "X-Sv-Multi": "a" }, [
            { name: "X-Sv-Multi", value: "a" },
            { name: "X-Sv-Multi", value: "b" },
            { name: "Date", value: "today" },
          ]),
          { date: "today", "x-sv-multi": ["a", "b"] },
        );
      });

      it("redacts the value of a probe header whose name looks like a credential", () => {
        const names = [
          "Authorization",
          "Proxy-Authorization",
          "Cookie",
          "X-Api-Token",
          "X-Client-Secret",
          "X-Session-Id",
          "X-Password",
          "X-Auth-User",
          "X-API-KEY",
          "X-Signature",
          "X-Hmac",
          "X-Credentials",
          "X-Nonce",
          "X-Jwt",
          "X-Csrf",
        ];
        assert.deepEqual(
          reported(
            {},
            names.map((name) => ({ name, value: "s3cr3t" })),
          ),
          Object.fromEntries(
            names.map((name) => [name.toLowerCase(), "<redacted>"]),
          ),
        );
      });

      it("redacts the file name in a Content-Disposition, whether the platform or the probe set it", () => {
        assert.deepEqual(
          reported({
            "Content-Disposition": 'attachment; filename="Acme invoice.pdf"',
          }),
          { "content-disposition": "attachment; filename=<redacted>" },
        );
        assert.deepEqual(
          reported({}, [
            {
              name: "Content-Disposition",
              value: "attachment; filename*=UTF-8''Acme%20invoice.pdf; size=3",
            },
          ]),
          {
            "content-disposition": "attachment; filename*=<redacted>; size=3",
          },
        );
      });

      it("reports only the probe's cookies, redacting all but sv_*", () => {
        assert.deepEqual(
          reported(perCall, [
            { name: "Set-Cookie", value: "sv_flavor=sweet; Path=/" },
            { name: "Set-Cookie", value: "other=x; Path=/" },
          ]),
          { "set-cookie": ["sv_flavor=sweet; Path=/", "other=<redacted>"] },
        );
      });

      it("replaces the platform's value of a name the probe set", () => {
        assert.deepEqual(
          reported({ "Content-Type": "text/html;charset=utf-8" }, [
            { name: "content-type", value: "text/plain" },
          ]),
          { "content-type": "text/plain" },
        );
      });

      it("falls back to the allowlisted platform headers when the report is missing or not valid JSON, and never reports it", () => {
        for (const probe of [undefined, "not json", '{"name":"x"}']) {
          assert.deepEqual(
            reported(
              { ...perCall, "Content-Type": "text/plain", "X-Sv-Multi": "a" },
              probe,
            ),
            { "content-type": "text/plain" },
            String(probe),
          );
        }
      });
    });

    it("strips NetSuite's trailing comments from an own HTML body before cutting it, and nothing else", () => {
      const p = project();
      const answers = [
        ["text/html; charset=UTF-8", `<p>hello</p>${trailer}`],
        ["text/html", `${"y".repeat(64 * 1024)}${trailer}`],
        ["text/plain", `<p>hello</p>${trailer}`],
        ["text/html", "<!-- keep --><p>hello</p><!-- this too -->\n<b>end</b>"],
      ].map(([type, body]) => ({
        body,
        code: 200,
        headers: { "Content-Type": type, "X-SSV-Mode": "own" },
      }));
      let next = 0;
      const runner = runnerFor(p, () => answers[next++]);
      const bodies = answers.map(() => {
        const { response } = runner.post({
          params: { id: "1" },
          probe: "page",
        });
        return response as { body: string; truncated?: true };
      });
      assert.deepEqual(bodies[0], {
        body: "<p>hello</p>",
        headers: { "content-type": "text/html; charset=UTF-8" },
        status: 200,
      });
      assert.equal(bodies[1]?.body, "y".repeat(64 * 1024));
      assert.equal(bodies[1]?.truncated, undefined);
      assert.equal(bodies[2]?.body, `<p>hello</p>${trailer}`);
      assert.equal(
        bodies[3]?.body,
        "<!-- keep --><p>hello</p><!-- this too -->\n<b>end</b>",
      );
    });
  });

  describe("the generated Suitelet host", () => {
    type Host = { onRequest: (context: unknown) => unknown };
    type Context = {
      request: Record<string, unknown>;
      response: Record<
        | "addHeader"
        | "getHeader"
        | "sendRedirect"
        | "setHeader"
        | "write"
        | "writePage",
        (options: unknown) => unknown
      > & { headers: Record<string, unknown> };
    };
    const hostFor = (
      p: Project,
      run: (params: unknown, context: Context) => unknown,
    ) => {
      withProbe(p, `${suitelet}\n * @param id ^[0-9]+$`, "page");
      assert.equal(cli(p, ["deploy"]).status, 0);
      return (runtime: unknown) =>
        load<Host>(calls(p).suitelet.join(""), runtime, { run });
    };
    /** Calls the host with a fake server response that records every call it gets, in order. */
    const serve = (
      host: Host,
      parameters: Record<string, string>,
      request: Record<string, unknown> = {},
      fails?: string,
    ) => {
      const seen: [string, unknown][] = [];
      const record =
        (method: string) =>
        (arg: unknown): undefined => {
          if (method === fails) {
            throw Object.assign(new Error("cannot write a page now"), {
              name: "SSS_INVALID_PAGE",
            });
          }
          seen.push([method, arg]);
        };
      const done = host.onRequest({
        request: { method: "GET", parameters, ...request },
        response: Object.fromEntries(
          [
            "addHeader",
            "sendRedirect",
            "setHeader",
            "write",
            "writeFile",
            "writeLine",
            "writePage",
          ].map((method) => [method, record(method)]),
        ),
      });
      return {
        done,
        // Read when asked, so a probe that returns a Promise can be awaited first.
        get marker() {
          return seen
            .filter(([m]) => m.endsWith("Header"))
            .map(([, arg]) => arg as { name: string; value: string })
            .filter(({ name }) => name.toLowerCase() === "x-ssv-mode")
            .map(({ value }) => value);
        },
        seen,
      };
    };
    /** The JSON a host wrote, from its recorded calls. */
    const written = (seen: [string, unknown][]) =>
      JSON.parse(
        seen
          .filter(([m]) => m === "write")
          .map(([, o]) => (o as { output: string }).output)
          .join(""),
      );
    const call = (host: Host, parameters: Record<string, string>) => {
      const { marker, seen } = serve(host, parameters);
      assert.deepEqual(marker, ["wrapped"]);
      return JSON.parse(
        seen
          .filter(([m]) => m === "write")
          .map(([, o]) =>
            typeof o === "string" ? o : (o as { output: string }).output,
          )
          .join(""),
      );
    };

    it("returns the probe's value, or THROWS, for a known probe with valid parameters", () => {
      const p = project();
      const seen: unknown[] = [];
      let fail = false;
      const host = hostFor(p, (params) => {
        seen.push(params);
        if (fail) {
          throw Object.assign(new Error("boom"), { name: "TypeError" });
        }
        return { got: params };
      })(sandbox);
      const params = JSON.stringify({ id: "7" });
      assert.deepEqual(call(host, { params, probe: "page" }), {
        permissions: {},
        probe: "page",
        result: { got: { id: "7" } },
        scriptType: "Suitelet",
        usage: { after: 5000, before: 5000 },
        version: "2026.2",
      });
      fail = true;
      assert.equal(
        call(host, { params, probe: "page" }).result,
        "THROWS: TypeError: boom",
      );
      assert.deepEqual(seen, [{ id: "7" }, { id: "7" }]);
    });

    it("refuses outside a sandbox, an unknown probe and invalid parameters, without running the probe", () => {
      const p = project();
      let ran = 0;
      const make = hostFor(p, () => ran++);
      const prod = make({ ...sandbox, envType: "PRODUCTION" });
      assert.match(
        call(prod, { params: '{"id":"1"}', probe: "page" }).error,
        /sandbox/,
      );
      const host = make(sandbox);
      assert.equal(call(host, { probe: "nope" }).error, "unknown probe");
      for (const params of [
        '{"id":"x"}',
        '{"id":"1","extra":"2"}',
        "{}",
        '{"id":1}',
        "not json",
        "[]",
      ]) {
        assert.match(call(host, { params, probe: "page" }).error, /param/);
      }
      assert.equal(ran, 0);
    });

    describe("its execution role", () => {
      const two = [
        "@permission LIST_CUSTJOB VIEW",
        "@permission LIST_EMPLOYEE VIEW",
      ];
      /** Deploys a probe with no permission and one with two, and loads the host as slot `index` runs it, holding `held`. */
      const hostAs = (
        p: Project,
        index: number,
        held: Record<string, number> = {},
        run: (params: unknown, context: Context) => unknown = () => "ok",
      ) => {
        write(
          p.dir,
          "verification/probes/plain.js",
          probeSource(` * ${suitelet}`),
        );
        write(
          p.dir,
          "verification/probes/two.js",
          probeSource([suitelet, ...two].map((l) => ` * ${l}`).join("\n")),
        );
        assert.equal(cli(p, ["deploy"]).status, 0);
        return load<Host>(
          calls(p).suitelet.join(""),
          {
            ...sandbox,
            getCurrentScript: () => ({
              deploymentId: slot(index),
              getRemainingUsage: () => 5000,
            }),
            getCurrentUser: () => ({
              getPermission: ({ name }: { name: string }) => held[name] ?? 0,
              roleId: "customrole_suitescript_verify",
            }),
          },
          { run },
          { run },
        );
      };
      // Sets sort by their text, the empty set first: slot 0 has none, slot 1 has two.

      it("reports the role's level for each key the probe declares, read with getPermission", () => {
        const p = project();
        const host = hostAs(p, 1, { LIST_CUSTJOB: 1 });
        const answer = call(host, { probe: "two" });
        assert.deepEqual(answer.permissions, {
          LIST_CUSTJOB: "VIEW",
          LIST_EMPLOYEE: "NONE",
        });
        assert.equal(answer.result, "ok");
      });

      it("reports no levels for a probe that declares nothing", () => {
        const p = project();
        const answer = call(hostAs(p, 0), { probe: "plain" });
        assert.deepEqual(answer.permissions, {});
      });

      it("reports a level it cannot read as it found it, never throwing", () => {
        const p = project();
        write(
          p.dir,
          "verification/probes/two.js",
          probeSource(` * ${suitelet}\n * ${two[0]}`),
        );
        assert.equal(cli(p, ["deploy"]).status, 0);
        const host = load<Host>(
          calls(p).suitelet.join(""),
          {
            ...sandbox,
            getCurrentScript: () => ({
              deploymentId: slot(1),
              getRemainingUsage: () => 5000,
            }),
            getCurrentUser: () => ({
              getPermission: () => {
                throw Object.assign(new Error("bad key"), { name: "SSS_X" });
              },
            }),
          },
          { run: () => "ok" },
        );
        assert.deepEqual(call(host, { probe: "two" }).permissions, {
          LIST_CUSTJOB: "UNREADABLE: SSS_X: bad key",
        });
      });

      it("refuses a probe whose set does not match the slot it was reached through, without running it", () => {
        const p = project();
        let ran = 0;
        const asSlot = (index: number) => hostAs(p, index, {}, () => ran++);
        for (const [index, name] of [
          [0, "two"],
          [1, "plain"],
          [2, "plain"],
          [9, "two"],
        ] as const) {
          assert.match(
            call(asSlot(index), { probe: name }).error,
            /does not match the slot/,
            `${name} through slot ${index}`,
          );
        }
        assert.equal(ran, 0);
        assert.equal(call(asSlot(0), { probe: "plain" }).result, 0);
        assert.equal(call(asSlot(1), { probe: "two" }).result, 1);
      });

      it("takes its slot from the deployment id, never from the role id", () => {
        const p = project();
        const host = hostAs(p, 0);
        const lying = load<Host>(
          calls(p).suitelet.join(""),
          {
            ...sandbox,
            getCurrentScript: () => ({
              deploymentId: slot(1).toUpperCase(),
              getRemainingUsage: () => 5000,
            }),
            getCurrentUser: () => ({
              getPermission: () => 0,
              roleId: "customrole_suitescript_verify_s0",
            }),
          },
          { run: () => "ok" },
          { run: () => "ok" },
        );
        assert.equal(call(lying, { probe: "two" }).result, "ok");
        assert.match(call(host, { probe: "two" }).error, /does not match/);
      });

      it("sends the levels of an own response in X-SSV-Permissions", () => {
        const p = project();
        const host = hostAs(
          p,
          1,
          { LIST_EMPLOYEE: 1 },
          (_params, { response }) => {
            response.write({ output: "hi" });
          },
        );
        const { marker, seen } = serve(host, { probe: "two" });
        assert.deepEqual(marker, ["own"]);
        const header = seen
          .map(([, arg]) => arg as { name?: string; value?: string })
          .find(({ name }) => name === "X-SSV-Permissions")?.value;
        assert.deepEqual(JSON.parse(header ?? ""), {
          LIST_CUSTJOB: "NONE",
          LIST_EMPLOYEE: "VIEW",
        });
      });
    });

    const params = JSON.stringify({ id: "7" });

    const usageHeader = JSON.stringify({ after: 5000, before: 5000 });

    it("replays a probe's own response after it returns nothing, behind the own marker", () => {
      const p = project();
      const reads: unknown[] = [];
      const host = hostFor(p, (_params, { response }) => {
        response.setHeader({ name: "X-Probe", value: "1" });
        reads.push(response.getHeader({ name: "x-probe" }));
        response.write({ output: "<p>hello</p>" });
        response.addHeader({ name: "Set-Cookie", value: "sv_a=1; Path=/" });
        reads.push(response.headers);
      })(sandbox);
      const { marker, seen } = serve(host, { params, probe: "page" });
      assert.deepEqual(marker, ["own"]);
      assert.deepEqual(seen, [
        ["setHeader", { name: "X-SSV-Mode", value: "own" }],
        ["setHeader", { name: "X-SSV-Usage", value: usageHeader }],
        ["setHeader", { name: "X-SSV-Permissions", value: "{}" }],
        [
          "setHeader",
          {
            name: "X-SSV-Headers",
            value: JSON.stringify([
              { name: "X-Probe", value: "1" },
              { name: "Set-Cookie", value: "sv_a=1; Path=/" },
            ]),
          },
        ],
        ["setHeader", { name: "X-Probe", value: "1" }],
        ["write", { output: "<p>hello</p>" }],
        ["addHeader", { name: "Set-Cookie", value: "sv_a=1; Path=/" }],
      ]);
      assert.deepEqual(reads, [
        "1",
        { "Set-Cookie": "sv_a=1; Path=/", "X-Probe": "1" },
      ]);
    });

    it("reports the probe's headers in X-SSV-Headers, setHeader replacing a name's values and addHeader appending", () => {
      const p = project();
      const host = hostFor(p, (_params, { response }) => {
        response.addHeader({ name: "X-Sv-Multi", value: "a" });
        response.addHeader({ name: "x-sv-multi", value: "b" });
        response.addHeader({ name: "X-Sv-Once", value: "old" });
        response.setHeader({ name: "X-SV-ONCE", value: "new" });
        response.setHeader({ name: "Set-Cookie", value: "sv_single=one" });
        response.write({ output: "hi" });
      })(sandbox);
      const { seen } = serve(host, { params, probe: "page" });
      const reported = seen
        .map(([, arg]) => arg as { name?: string; value?: string })
        .find(({ name }) => name === "X-SSV-Headers");
      assert.deepEqual(JSON.parse(reported?.value ?? ""), [
        { name: "X-Sv-Multi", value: "a" },
        { name: "X-Sv-Multi", value: "b" },
        { name: "X-Sv-Once", value: "new" },
        { name: "Set-Cookie", value: "sv_single=one" },
      ]);
    });

    it("refuses a probe that both writes a response and returns a value, replaying nothing", () => {
      const p = project();
      const host = hostFor(p, (_params, { response }) => {
        response.write({ output: "partial" });
        return { ok: true };
      })(sandbox);
      assert.match(
        call(host, { params, probe: "page" }).error,
        /both wrote a response and returned a value/,
      );
      const { seen } = serve(host, { params, probe: "page" });
      assert.equal(JSON.stringify(seen).includes("partial"), false);
    });

    describe("a probe that returns a Promise", () => {
      const nope = Object.assign(new Error("gone"), { name: "NOT_FOUND" });

      it("waits for the Promise and reports a resolved value as wrapped", async () => {
        const p = project();
        const host = hostFor(p, async () => {
          await Promise.resolve();
          return { found: [1] };
        })(sandbox);
        const run = serve(host, { params, probe: "page" });
        assert.ok(run.done instanceof Promise);
        assert.equal(run.seen.length, 0);
        await run.done;
        assert.deepEqual(run.marker, ["wrapped"]);
        assert.deepEqual(written(run.seen), {
          permissions: {},
          probe: "page",
          result: { found: [1] },
          scriptType: "Suitelet",
          usage: { after: 5000, before: 5000 },
          version: "2026.2",
        });
      });

      it("replays a response written after an await as own, once it resolves undefined", async () => {
        const p = project();
        const host = hostFor(p, async (_params, { response }) => {
          await Promise.resolve();
          response.write({ output: "late" });
        })(sandbox);
        const run = serve(host, { params, probe: "page" });
        assert.equal(run.seen.length, 0);
        await run.done;
        assert.deepEqual(run.marker, ["own"]);
        assert.deepEqual(
          run.seen.filter(([m]) => m === "write"),
          [["write", { output: "late" }]],
        );
      });

      it("refuses a Promise that resolves a value after response calls, replaying nothing", async () => {
        const p = project();
        const host = hostFor(p, async (_params, { response }) => {
          response.write({ output: "partial" });
          return { ok: true };
        })(sandbox);
        const run = serve(host, { params, probe: "page" });
        await run.done;
        assert.match(
          written(run.seen).error,
          /both wrote a response and returned a value/,
        );
        assert.equal(JSON.stringify(run.seen).includes("partial"), false);
      });

      it("reports a rejection as REJECTS and replays nothing, including a rejection with no error", async () => {
        for (const [reason, expected] of [
          [nope, "REJECTS: NOT_FOUND: gone"],
          [undefined, "REJECTS: undefined"],
          ["plain words", "REJECTS: plain words"],
        ] as const) {
          const p = project();
          const host = hostFor(p, async (_params, { response }) => {
            response.setHeader({ name: "X-Probe", value: "1" });
            response.write({ output: "partial" });
            throw reason;
          })(sandbox);
          const run = serve(host, { params, probe: "page" });
          await run.done;
          assert.deepEqual(run.marker, ["wrapped"]);
          assert.equal(written(run.seen).result, expected);
          assert.equal(/partial|X-Probe/.test(JSON.stringify(run.seen)), false);
        }
      });

      it("seals the recorder when the Promise settles: a later response call is ignored", async () => {
        const p = project();
        let later = () => {};
        const host = hostFor(p, (_params, { response }) => {
          later = () => {
            response.write({ output: "stray" });
            response.setHeader({ name: "X-Stray", value: "1" });
          };
          return Promise.resolve({ ok: true });
        })(sandbox);
        const run = serve(host, { params, probe: "page" });
        await run.done;
        later();
        assert.equal(/stray|X-Stray/.test(JSON.stringify(run.seen)), false);
        assert.deepEqual(run.marker, ["wrapped"]);
      });

      it("ignores a stray call after an own probe settles instead of landing it mid-replay", async () => {
        const p = project();
        let later = () => {};
        const host = hostFor(p, async (_params, { response }) => {
          later = () => response.write({ output: "stray" });
          response.write({ output: "real" });
        })(sandbox);
        const run = serve(host, { params, probe: "page" });
        await run.done;
        later();
        assert.deepEqual(
          run.seen.filter(([m]) => m === "write"),
          [["write", { output: "real" }]],
        );
      });

      it("makes a result that holds a Promise an error naming the path, for a Promise or a synchronous probe", async () => {
        const nested = { page: { items: [1, { cursor: Promise.resolve(1) }] } };
        for (const result of [Promise.resolve(nested), nested]) {
          const p = project();
          const host = hostFor(p, () => result)(sandbox);
          const run = serve(host, { params, probe: "page" });
          await run.done;
          assert.deepEqual(written(run.seen), {
            error:
              "the result holds a Promise that was not awaited at page.items[1].cursor",
          });
        }
      });

      it("answers with an error, never an unhandled rejection, when the host fails after the Promise settles", async () => {
        const p = project();
        // A cyclic value cannot be serialized, so answering throws inside the handler.
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        const host = hostFor(p, async () => cyclic)(sandbox);
        const run = serve(host, { params, probe: "page" });
        await run.done;
        assert.equal(run.marker.at(-1), "wrapped");
        assert.match(
          written(run.seen).error,
          /the host could not answer after the probe settled: TypeError/,
        );
      });

      it("keeps a synchronous probe synchronous, returning no Promise", () => {
        const p = project();
        const host = hostFor(p, () => ({ ok: true }))(sandbox);
        const run = serve(host, { params, probe: "page" });
        assert.ok(!(run.done instanceof Promise));
        assert.deepEqual(run.marker, ["wrapped"]);
      });
    });

    it("drops everything a probe wrote when it throws, before or after writing", () => {
      for (const writeFirst of [false, true]) {
        const p = project();
        const host = hostFor(p, (_params, { response }) => {
          if (writeFirst) {
            response.setHeader({ name: "X-Probe", value: "1" });
            response.write({ output: "partial" });
          }
          throw Object.assign(new Error("boom"), { name: "TypeError" });
        })(sandbox);
        assert.equal(
          call(host, { params, probe: "page" }).result,
          "THROWS: TypeError: boom",
        );
        const { seen } = serve(host, { params, probe: "page" });
        assert.equal(/partial|X-Probe/.test(JSON.stringify(seen)), false);
      }
    });

    it("answers THROWS behind the wrapped marker when the replay fails part-way, never as own output", () => {
      for (const writeFirst of [false, true]) {
        const p = project();
        const host = hostFor(p, (_params, { response }) => {
          response.setHeader({ name: "X-Probe", value: "1" });
          if (writeFirst) response.write({ output: "partial" });
          response.writePage({ pageObject: {} });
        })(sandbox);
        const { marker, seen } = serve(
          host,
          { params, probe: "page" },
          {},
          "writePage",
        );
        assert.equal(marker.at(-1), "wrapped");
        const writes = seen
          .filter(([m]) => m === "write")
          .map(([, o]) => (o as { output: string }).output);
        const answer = writes.at(-1) ?? "";
        assert.deepEqual(JSON.parse(answer), {
          permissions: {},
          probe: "page",
          result: "THROWS: SSS_INVALID_PAGE: cannot write a page now",
          scriptType: "Suitelet",
          usage: { after: 5000, before: 5000 },
          version: "2026.2",
        });
        // What was written before the failure cannot be taken back, so the
        // runner reads partial output plus the answer as a body that is not
        // JSON: an error, never a result or own output.
        assert.equal(writes.join("").startsWith("partial"), writeFirst);
      }
    });

    it("refuses a redirect as the probe's error, since requestSuitelet follows it, replaying nothing", () => {
      const p = project();
      const host = hostFor(p, (_params, { response }) => {
        response.setHeader({ name: "X-Probe", value: "1" });
        response.sendRedirect({ identifier: "x", type: "SUITELET" });
      })(sandbox);
      assert.match(
        call(host, { params, probe: "page" }).result,
        /^THROWS: SSV_REDIRECT_REFUSED: .*requestSuitelet follows redirects/,
      );
      const { seen } = serve(host, { params, probe: "page" });
      assert.equal(/X-Probe|sendRedirect/.test(JSON.stringify(seen)), false);
    });

    it("refuses a probe's attempt to set the marker or any X-SSV- header, whatever the case or call", () => {
      for (const reserved of [
        " x-ssv-MODE",
        "X-SSV-Headers",
        "x-ssv-usage",
        "X-SSV-Permissions",
        "x-ssv-other",
      ]) {
        const p = project();
        let caught = 0;
        let swallow = false;
        const host = hostFor(p, (_params, { response }) => {
          for (const method of ["setHeader", "addHeader"] as const) {
            try {
              response[method]({ name: reserved, value: "wrapped" });
            } catch (e) {
              caught++;
              if (!swallow) throw e;
            }
          }
          response.write({ output: '{"result":"forged"}' });
        })(sandbox);
        assert.match(
          call(host, { params, probe: "page" }).result,
          /^THROWS: SSV_RESERVED_HEADER: .*X-SSV-/,
          reserved,
        );
        swallow = true;
        const { marker, seen } = serve(host, { params, probe: "page" });
        assert.deepEqual(marker, ["own"]);
        assert.deepEqual(seen.slice(3), [
          ["setHeader", { name: "X-SSV-Headers", value: "[]" }],
          ["write", { output: '{"result":"forged"}' }],
        ]);
        assert.equal(caught, 3);
      }
    });

    describe("usage", () => {
      /** A runtime whose remaining units read as the given numbers, in order, then stay at the last. */
      const counting = (...readings: number[]) => {
        const left = [...readings];
        return {
          ...sandbox,
          getCurrentScript: () => ({
            deploymentId: slot(0),
            getRemainingUsage: () =>
              left.length > 1 ? (left.shift() as number) : (left[0] as number),
          }),
        };
      };
      const headerValue = (seen: [string, unknown][]) =>
        seen
          .map(([, arg]) => arg as { name?: string; value?: string })
          .find(({ name }) => name === "X-SSV-Usage")?.value;

      it("reports the units remaining before and after a returned value", () => {
        const p = project();
        const host = hostFor(p, () => "ok")(counting(1000, 990));
        assert.deepEqual(call(host, { params, probe: "page" }).usage, {
          after: 990,
          before: 1000,
        });
      });

      it("reports usage for a throw, with the THROWS result", () => {
        const p = project();
        const host = hostFor(p, () => {
          throw Object.assign(new Error("boom"), { name: "TypeError" });
        })(counting(1000, 700));
        const answer = call(host, { params, probe: "page" });
        assert.equal(answer.result, "THROWS: TypeError: boom");
        assert.deepEqual(answer.usage, { after: 700, before: 1000 });
      });

      it("reports usage for a rejection, read once the Promise settles", async () => {
        const p = project();
        const host = hostFor(p, async () => {
          await Promise.resolve();
          throw Object.assign(new Error("gone"), { name: "NOT_FOUND" });
        })(counting(1000, 400));
        const run = serve(host, { params, probe: "page" });
        await run.done;
        const answer = written(run.seen);
        assert.match(answer.result, /^REJECTS: NOT_FOUND: gone/);
        assert.deepEqual(answer.usage, { after: 400, before: 1000 });
      });

      it("reads the after units once a resolved Promise settles", async () => {
        const p = project();
        let spent = false;
        const host = hostFor(p, async () => {
          await Promise.resolve();
          spent = true;
          return 1;
        })({
          ...sandbox,
          getCurrentScript: () => ({
            deploymentId: slot(0),
            getRemainingUsage: () => (spent ? 900 : 1000),
          }),
        });
        const run = serve(host, { params, probe: "page" });
        await run.done;
        assert.deepEqual(written(run.seen).usage, { after: 900, before: 1000 });
      });

      it("sends the reading of an own response in X-SSV-Usage", () => {
        const p = project();
        const host = hostFor(p, (_params, { response }) => {
          response.write({ output: "hi" });
        })(counting(1000, 950));
        const { marker, seen } = serve(host, { params, probe: "page" });
        assert.deepEqual(marker, ["own"]);
        assert.deepEqual(JSON.parse(headerValue(seen) ?? ""), {
          after: 950,
          before: 1000,
        });
      });

      it("still carries usage when the replay fails and the answer switches to wrapped", () => {
        const p = project();
        const host = hostFor(p, (_params, { response }) => {
          response.writePage({ pageObject: {} });
        })(counting(1000, 950));
        const { seen } = serve(
          host,
          { params, probe: "page" },
          {},
          "writePage",
        );
        const answer = written(seen);
        assert.match(answer.result, /^THROWS: SSS_INVALID_PAGE/);
        assert.deepEqual(answer.usage, { after: 950, before: 1000 });
      });

      describe("exceeded", () => {
        const limit = { message: "out", name: "SSS_USAGE_LIMIT_EXCEEDED" };

        it("is set when the probe throws the limit error, even a non-Error object", () => {
          const p = project();
          const host = hostFor(p, () => {
            throw limit;
          })(counting(1000, 400));
          assert.deepEqual(call(host, { params, probe: "page" }).usage, {
            after: 400,
            before: 1000,
            exceeded: true,
          });
        });

        it("is set when the probe rejects with the limit error", async () => {
          const p = project();
          const host = hostFor(p, async () => {
            await Promise.resolve();
            throw limit;
          })(counting(1000, 400));
          const run = serve(host, { params, probe: "page" });
          await run.done;
          assert.deepEqual(written(run.seen).usage, {
            after: 400,
            before: 1000,
            exceeded: true,
          });
        });

        it("is set when the probe caught the limit error and returned, because after is 0", () => {
          const p = project();
          const host = hostFor(p, () => "caught")(counting(1000, 0));
          assert.deepEqual(call(host, { params, probe: "page" }).usage, {
            after: 0,
            before: 1000,
            exceeded: true,
          });
        });

        it("is sent in X-SSV-Usage for an own response", () => {
          const p = project();
          const host = hostFor(p, (_params, { response }) => {
            response.write({ output: "hi" });
          })(counting(1000, 0));
          const { seen } = serve(host, { params, probe: "page" });
          assert.deepEqual(JSON.parse(headerValue(seen) ?? ""), {
            after: 0,
            before: 1000,
            exceeded: true,
          });
        });

        it("is absent when neither condition holds", () => {
          const p = project();
          const host = hostFor(p, () => {
            throw { message: "x", name: "OTHER" };
          })(counting(1000, 5));
          assert.equal(
            "exceeded" in (call(host, { params, probe: "page" }).usage ?? {}),
            false,
          );
        });
      });

      it("carries the host's reading on an error answer after the probe ran: both wrote a response and returned a value", () => {
        const p = project();
        const both = hostFor(p, (_params, { response }) => {
          response.write({ output: "partial" });
          return { ok: true };
        })(counting(1000, 940));
        assert.deepEqual(call(both, { params, probe: "page" }).usage, {
          after: 940,
          before: 1000,
        });
      });

      it("carries no usage on a refusal that never ran the probe", () => {
        const p = project();
        const host = hostFor(p, () => 1)(counting(1000, 990));
        const refused: Record<string, string>[] = [
          { probe: "nope" },
          { params: "{}", probe: "page" },
        ];
        for (const sent of refused) {
          assert.equal("usage" in call(host, sent), false);
        }
      });
    });

    it("shows the probe only the method and its declared parameters, never headers, cookies or body", () => {
      const p = project();
      const views: unknown[] = [];
      const host = hostFor(p, (params, { request }) => {
        views.push(request, Object.isFrozen(request), params);
        return 1;
      })(sandbox);
      serve(
        host,
        { params, probe: "page" },
        {
          body: "secret-body",
          clientIpAddress: "10.0.0.1",
          getHeader: () => "x",
          headers: { cookie: "JSESSIONID=abc" },
          method: "POST",
          url: "/app/site/hosting/scriptlet.nl",
        },
      );
      assert.deepEqual(views, [
        { method: "POST", parameters: { id: "7" } },
        true,
        { id: "7" },
      ]);
    });
  });
});

const packageVersion = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;

describe("the self-check", () => {
  const levels = { CREATE: 2, EDIT: 3, FULL: 4, NONE: 0, VIEW: 1 };
  /** A runtime whose current user runs as `role`, holding `held` (a permission key to a level). */
  const runtimeFor = (
    held: Record<string, number>,
    role = "customrole_suitescript_verify",
    env = sandbox,
  ) => ({
    ...env,
    getCurrentUser: () => ({
      getPermission: ({ name }: { name: string }) => held[name] ?? 0,
      roleId: role,
    }),
    Permission: levels,
  });
  const deployed = (p: Project) => {
    write(
      p.dir,
      "verification/probes/one.js",
      probeSource(`${restlet}\n * @permission LIST_EMPLOYEE VIEW`),
    );
    write(
      p.dir,
      "verification/probes/page.js",
      probeSource("@scriptType Suitelet"),
    );
    assert.equal(cli(p, ["deploy"]).status, 0);
    return calls(p);
  };
  const full = { ADMI_LOGIN_OAUTH2: 4, ADMI_RESTWEBSERVICES: 4 };

  describe("the generated Suitelet host", () => {
    const ask = (source: string, runtime: unknown) => {
      const written: string[] = [];
      let ran = 0;
      load<{ onRequest: (c: unknown) => void }>(source, runtime, {
        run: () => ran++,
      }).onRequest({
        request: { method: "GET", parameters: { selfCheck: "1" } },
        response: {
          setHeader: () => undefined,
          write: (o: { output: string } | string) =>
            written.push(typeof o === "string" ? o : o.output),
        },
      });
      assert.equal(ran, 0);
      return JSON.parse(written.join(""));
    };

    it("answers the reserved self-check with the sandbox check, the package version, the build and its probes, running none", () => {
      const p = project();
      const host = deployed(p).suitelet.join("");
      const { build } = ask(host, sandbox).selfCheck;
      assert.match(build, /^[0-9a-f]{12}$/);
      assert.deepEqual(ask(host, sandbox), {
        selfCheck: {
          build,
          packageVersion,
          probes: ["page"],
          sandbox: true,
        },
      });
      assert.deepEqual(ask(host, { ...sandbox, envType: "PRODUCTION" }), {
        selfCheck: { sandbox: false },
      });
    });
  });

  describe("the generated runner", () => {
    type Runner = { post: (b: unknown) => Record<string, unknown> };
    const runnerFrom = (
      source: string,
      runtime: unknown,
      requestSuitelet: (o: unknown) => unknown,
    ) => {
      let ran = 0;
      const runner = load<Runner>(
        source,
        runtime,
        { requestSuitelet },
        {
          run: () => ran++,
        },
      );
      return { ran: () => ran, runner };
    };
    const hostAnswer = {
      body: JSON.stringify({
        selfCheck: { packageVersion, probes: ["page"], sandbox: true },
      }),
      code: 200,
      headers: {},
    };

    it("answers the reserved self-check with the sandbox check, its role, each written permission's held level, the deployed version and probes, and the host's answer", () => {
      const p = project();
      const seen: unknown[] = [];
      const { ran, runner } = runnerFrom(
        deployed(p).runner.join(""),
        runtimeFor({ ...full, LIST_EMPLOYEE: 1 }),
        (options) => {
          seen.push(options);
          return hostAnswer;
        },
      );
      const answer = runner.post({ selfCheck: true }) as {
        selfCheck: { build: string };
      };
      const { build } = answer.selfCheck;
      assert.match(build, /^[0-9a-f]{12}$/);
      assert.deepEqual(answer, {
        selfCheck: {
          build,
          host: { packageVersion, probes: ["page"], sandbox: true },
          packageVersion,
          permissions: {
            ADMI_LOGIN_OAUTH2: "FULL",
            ADMI_RESTWEBSERVICES: "FULL",
          },
          probes: ["one", "page"],
          role: "customrole_suitescript_verify",
          sandbox: true,
          version: "2026.2",
        },
      });
      assert.deepEqual(seen, [
        {
          deploymentId: "customdeploy_suitescript_verify_s0",
          scriptId: "customscript_suitescript_verify_sl",
          urlParams: { selfCheck: "1" },
        },
      ]);
      assert.equal(ran(), 0);
    });

    it("bakes one build fingerprint into the runner and the host, which changes when a probe's code changes", () => {
      const p = project();
      const build = () => {
        const call = calls(p);
        const { runner } = runnerFrom(
          call.runner.join(""),
          runtimeFor(full),
          () => hostAnswer,
        );
        const fromRunner = (
          runner.post({ selfCheck: true }).selfCheck as { build: string }
        ).build;
        const fromHost = /build: "([0-9a-f]{12})"/.exec(
          call.suitelet.join(""),
        )?.[1];
        assert.equal(fromHost, fromRunner);
        return fromRunner;
      };
      deployed(p);
      const first = build();
      assert.equal(cli(p, ["deploy"]).status, 0);
      assert.equal(build(), first);
      write(
        p.dir,
        "verification/probes/page.js",
        probeSource("@scriptType Suitelet").replace("ok: true", "ok: false"),
      );
      assert.equal(cli(p, ["deploy"]).status, 0);
      assert.notEqual(build(), first);
    });

    it("reports a permission the role lacks, or cannot read, as it found it", () => {
      const p = project();
      const runtime = runtimeFor({});
      const user = runtime.getCurrentUser();
      runtime.getCurrentUser = () => ({
        ...user,
        getPermission: ({ name }: { name: string }) => {
          if (name === "ADMI_RESTWEBSERVICES") {
            throw Object.assign(new Error("bad key"), { name: "SSS_X" });
          }
          return user.getPermission({ name });
        },
      });
      const { runner } = runnerFrom(
        deployed(p).runner.join(""),
        runtime,
        () => hostAnswer,
      );
      const answer = runner.post({ selfCheck: true }).selfCheck as {
        permissions: unknown;
      };
      assert.deepEqual(answer.permissions, {
        ADMI_LOGIN_OAUTH2: "NONE",
        ADMI_RESTWEBSERVICES: "UNREADABLE: SSS_X: bad key",
      });
    });

    it("reports a host that does not answer, never throwing", () => {
      const p = project();
      const source = deployed(p).runner.join("");
      for (const [reply, error] of [
        [
          () => {
            throw Object.assign(new Error("An unexpected error"), {
              name: "UNEXPECTED_ERROR",
            });
          },
          "the Suitelet host call failed: UNEXPECTED_ERROR: An unexpected error",
        ],
        [
          () => ({ body: "Server error", code: 500 }),
          "the Suitelet host answered HTTP 500: Server error",
        ],
        [
          () => ({ body: "<html>login</html>", code: 200 }),
          "the Suitelet host's answer was not JSON: <html>login</html>",
        ],
        [
          () => ({ body: '{"error":"unknown probe"}', code: 200 }),
          'the Suitelet host has no self-check: {"error":"unknown probe"}',
        ],
      ] as const) {
        const { runner } = runnerFrom(source, runtimeFor(full), reply);
        const answer = runner.post({ selfCheck: true }).selfCheck as {
          host: unknown;
          sandbox: boolean;
        };
        assert.deepEqual(answer.host, { error });
        assert.equal(answer.sandbox, true);
      }
    });

    it("answers only the sandbox check outside a sandbox", () => {
      const p = project();
      let called = 0;
      const { runner } = runnerFrom(
        deployed(p).runner.join(""),
        runtimeFor(full, "customrole_suitescript_verify", {
          ...sandbox,
          envType: "PRODUCTION",
        }),
        () => {
          called++;
          return hostAnswer;
        },
      );
      assert.deepEqual(runner.post({ selfCheck: true }), {
        selfCheck: { sandbox: false },
      });
      assert.equal(called, 0);
    });
  });
});

describe("doctor calls the self-check", () => {
  const step = /The deployed runner passes its self-check/;
  const lineOf = (out: string) =>
    out.split("\n").find((l) => /^(ok|FAIL) /.test(l) && step.test(l)) ?? "";
  const withProbes = (p: Project) => {
    write(
      p.dir,
      "verification/probes/one.js",
      probeSource(`${restlet}\n * @permission LIST_EMPLOYEE VIEW`),
    );
    write(
      p.dir,
      "verification/probes/page.js",
      probeSource("@scriptType Suitelet"),
    );
  };
  const deployedProject = () => {
    const p = project();
    withProbes(p);
    assert.equal(cli(p, ["deploy"]).status, 0);
    return p;
  };
  /** The build fingerprint the last deploy baked into the runner. */
  const builtAs = (p: Project) =>
    /build: "([0-9a-f]{12})"/.exec(calls(p).runner.join(""))?.[1] ?? "";
  const healthy = (p: Project) => ({
    build: builtAs(p),
    host: {
      build: builtAs(p),
      packageVersion,
      probes: ["page"],
      sandbox: true,
    },
    packageVersion,
    permissions: {
      ADMI_LOGIN_OAUTH2: "FULL",
      ADMI_RESTWEBSERVICES: "FULL",
    },
    probes: ["one", "page"],
    role: "customrole_suitescript_verify",
    sandbox: true,
    version: "2026.2",
  });
  /** Runs doctor and checks it printed no identifier. */
  const doctor = (p: Project) => {
    const out = cli(p, ["doctor"]).all;
    for (const id of [
      "1234567",
      clientId,
      "cert-runner-id",
      "cert-sdf-id",
      "tok-abc",
      "netsuite.com",
    ]) {
      assert.equal(out.includes(id), false, id);
    }
    return out;
  };

  it("passes when the deployed version, probes, host and role match the project, asking through the token flow run uses", () => {
    const p = deployedProject();
    p.script(...ok({ selfCheck: healthy(p) }));
    const out = doctor(p);
    assert.match(lineOf(out), /^ok {3}/);
    const [token, call] = p.requests();
    assert.match(token?.url ?? "", /\/oauth2\/v1\/token$/);
    assert.match(call?.url ?? "", /script=customscript_suitescript_verify_rl&/);
    assert.equal(call?.body, JSON.stringify({ selfCheck: true }));
  });

  it("says to deploy first before any deploy", () => {
    const p = project();
    withProbes(p);
    p.script(
      { body: { error: "invalid_grant" }, status: 400 },
      { body: {}, status: 200 },
    );
    const out = doctor(p);
    assert.match(lineOf(out), /^FAIL /);
    assert.match(out, /Maintainer's own step: Deploy first/);
  });

  it("says to redeploy when the deployed version, probe list or host differs", () => {
    for (const [change, why] of [
      [{ packageVersion: "0.0.1" }, /version 0\.0\.1/],
      [{ probes: ["one"] }, /probes/],
      [
        { host: { error: "the Suitelet host answered HTTP 500: x" } },
        /HTTP 500/,
      ],
      [
        { host: { packageVersion, probes: [], sandbox: true } },
        /Suitelet host/,
      ],
    ] as const) {
      const p = deployedProject();
      p.script(...ok({ selfCheck: { ...healthy(p), ...change } }));
      const out = doctor(p);
      assert.match(lineOf(out), /^FAIL /, String(why));
      assert.match(out, /Maintainer's own step: Redeploy/, String(why));
      assert.match(out, why);
    }
  });

  it("says to redeploy a runner or host of the same version built from other templates or probes, naming the builds", () => {
    for (const change of [
      (answer: ReturnType<typeof healthy>) => {
        answer.build = "abcdef0abcde";
      },
      (answer: ReturnType<typeof healthy>) => {
        answer.host.build = "abcdef0abcde";
      },
    ]) {
      const p = deployedProject();
      const answer = healthy(p);
      change(answer);
      p.script(...ok({ selfCheck: answer }));
      const out = doctor(p);
      assert.match(lineOf(out), /^FAIL /);
      assert.match(out, /Maintainer's own step: Redeploy/);
      assert.match(out, /abcdef0abcde/);
      assert.ok(out.includes(builtAs(p)), out);
      assert.ok(out.includes(packageVersion), out);
    }
  });

  it("says a runner or host deployed before build fingerprints has none, never `build undefined`", () => {
    const p = deployedProject();
    const { build: _runner, ...answer } = healthy(p);
    const { build: _host, ...host } = answer.host;
    p.script(...ok({ selfCheck: { ...answer, host } }));
    const out = doctor(p);
    assert.match(out, /Maintainer's own step: Redeploy/);
    assert.doesNotMatch(out, /undefined/);
    assert.match(
      out,
      /the deployed runner is version \S+ with no build fingerprint \(deployed by an older build\)/,
    );
    assert.match(
      out,
      /the Suitelet host is version \S+ with no build fingerprint \(deployed by an older build\)/,
    );
  });

  it("says to redeploy a runner that has no self-check", () => {
    const p = deployedProject();
    p.script(...ok({ error: "unknown probe", known: ["one"] }));
    const out = doctor(p);
    assert.match(lineOf(out), /^FAIL /);
    assert.match(out, /Maintainer's own step: Redeploy/);
  });

  it("reports drift when the role lacks a permission the deploy wrote", () => {
    const p = deployedProject();
    const answer = healthy(p);
    answer.permissions.ADMI_RESTWEBSERVICES = "NONE";
    p.script(...ok({ selfCheck: answer }));
    const out = doctor(p);
    assert.match(lineOf(out), /^FAIL /);
    assert.match(out, /Maintainer's own step: Drift/);
    assert.match(out, /ADMI_RESTWEBSERVICES \(wants FULL, holds NONE\)/);
    assert.doesNotMatch(out, /ADMI_LOGIN_OAUTH2 \(/);
  });

  it("expects only the login and REST web services permissions on the runner's role", () => {
    const p = deployedProject();
    const answer = healthy(p);
    p.script(
      ...ok({
        selfCheck: {
          ...answer,
          permissions: { ...answer.permissions, LIST_EMPLOYEE: "VIEW" },
        },
      }),
    );
    const out = doctor(p);
    assert.match(lineOf(out), /^FAIL /);
    assert.match(out, /Redeploy: [^\n]*role permissions/);
    p.script(...ok({ selfCheck: answer }));
    assert.match(lineOf(doctor(p)), /^ok /);
  });

  it("fails when the runner runs as another role or outside a sandbox", () => {
    const p = deployedProject();
    p.script(...ok({ selfCheck: { ...healthy(p), role: "customrole_other" } }));
    assert.match(doctor(p), /customrole_other/);
    p.script(...ok({ selfCheck: { sandbox: false } }));
    const out = doctor(p);
    assert.match(lineOf(out), /^FAIL /);
    assert.match(out, /sandbox/);
  });

  it("refuses to print an answer that looks like an identifier", () => {
    const p = deployedProject();
    p.script(
      ...ok({
        selfCheck: {
          ...healthy(p),
          host: { error: "failed at 7654321-sb2.app.netsuite.com" },
        },
      }),
    );
    const out = doctor(p);
    assert.match(lineOf(out), /^FAIL /);
    assert.equal(out.includes("7654321"), false);
  });

  it("calls nothing before the runner's settings pass", () => {
    const p = deployedProject();
    p.script(...ok({ selfCheck: healthy(p) }));
    const out = cli(p, ["doctor"], {
      SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH: join(p.dir, "missing.pem"),
    }).all;
    assert.match(lineOf(out), /^FAIL /);
    assert.deepEqual(p.requests(), []);
  });
});

describe("probe timeouts", () => {
  const withTags = (p: Project, tags: string[]) =>
    write(
      p.dir,
      "verification/probes/one.js",
      probeSource([restlet, ...tags.map((line) => ` * ${line}`)].join("\n")),
    );
  const slow = (delayMs: number): [Answer, Answer] => [
    { body: { access_token: "tok-abc" }, status: 200 },
    {
      body: { probe: "one", result: { ok: true }, version: "2026.2" },
      delayMs,
      status: 200,
    },
  ];

  it("stops waiting at the limit: exit 1, a message, no result and no draft", () => {
    const p = project();
    withTags(p, ["@timeout 1"]);
    p.script(...slow(1500));
    const result = cli(p, ["run", "one", "--draft"]);
    assert.equal(result.status, 1, result.all);
    assert.match(result.stderr, /one timed out after 1 seconds/);
    assert.match(result.stderr, /may still be running in NetSuite\./);
    assert.match(result.stderr, /@timeout <seconds> \(up to 300\)/);
    assert.equal(result.stdout.includes('"ok"'), false);
    assert.deepEqual(readdirSync(join(p.dir, "docs/verification/results")), []);
  });

  it("does not report drift for a timeout", () => {
    const p = project();
    withTags(p, ["@timeout 1"]);
    write(p.dir, "verification/probes/one.expect.json", '{"ok": true}');
    p.script(...slow(1500));
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 1, result.all);
    assert.doesNotMatch(result.all, /DRIFT/);
  });

  it("lets a longer @timeout wait for a slower answer", () => {
    const p = project();
    withTags(p, ["@timeout 5"]);
    p.script(...slow(1500));
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 0, result.all);
    assert.match(result.stdout, /"ok": true/);
  });

  // No test waits a real minute, and the CLI has no test-only setting for it:
  // the default is checked where it is read, and the wait is the same code the
  // @timeout cases above exercise.
  it("reads 60 seconds when a probe declares no @timeout", () => {
    const p = project();
    withTags(p, []);
    const [one] = listProbes(join(p.dir, "verification/probes"), []);
    assert.equal(one?.timeoutSeconds, 60);
  });

  it("reports NetSuite's own answer at @timeout 300, not a CLI timeout", () => {
    const p = project();
    withTags(p, ["@timeout 300"]);
    p.script(
      ...ok({
        error: "SSS_TIME_LIMIT_EXCEEDED: Script Execution Time Exceeded.",
      }),
    );
    const result = cli(p, ["run", "one"]);
    assert.equal(result.status, 1, result.all);
    assert.match(
      result.stderr,
      /The runner reported an error: SSS_TIME_LIMIT_EXCEEDED/,
    );
    assert.doesNotMatch(result.stderr, /timed out/);
  });

  it("keeps the HTTP client from giving up before 300 seconds", () => {
    const p = project();
    withTags(p, []);
    p.script(...ok({ result: {}, version: "1" }));
    assert.equal(cli(p, ["run", "one"]).status, 0);
    const [, call] = p.requests() as { dispatcher?: boolean }[];
    assert.equal(call?.dispatcher, true);
  });

  it("can build the patient dispatcher on this Node, so fetch's own 300-second cut-off is lifted", async () => {
    // undici's global dispatcher appears once the first fetch has run. If a Node
    // release removes the symbol or its class, this fails instead of the CLI
    // silently going back to giving up after 300 seconds.
    await fetch("http://127.0.0.1:1").catch(() => {});
    const dispatcher = patientDispatcher();
    assert.equal(typeof dispatcher, "object");
    assert.equal(patientDispatcher(), dispatcher, "it is built once");
  });

  it("states in the README the same grace the CLI waits past 300", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    assert.ok(readme.includes(`waits ${graceSeconds} seconds longer`));
  });

  it("refuses a bad @timeout at run and at deploy, before anything is generated or sent", () => {
    const p = project();
    p.script(...ok({ result: {}, version: "1" }));
    for (const lines of [
      ["@timeout"],
      ["@timeout soon"],
      ["@timeout 1.5"],
      ["@timeout 60s"],
      ["@timeout -5"],
      ["@timeout 0"],
      ["@timeout 301"],
      ["@timeout 60 61"],
      ["@timeout 60", "@timeout 90"],
    ]) {
      withTags(p, lines);
      const run = cli(p, ["run", "one"]);
      assert.equal(run.status, 1, lines.join());
      assert.match(run.stderr, /one has invalid tags[\s\S]*@timeout/);
      const deploy = cli(p, ["deploy"]);
      assert.equal(deploy.status, 1, lines.join());
      assert.match(deploy.stderr, /one: @timeout/);
    }
    assert.deepEqual(p.requests(), []);
    assert.equal(existsSync(join(p.dir, "calls.json")), false);
  });

  it("accepts the limits 1 and 300", () => {
    const p = project();
    p.script(...ok({ result: {}, version: "1" }));
    for (const value of ["1", "300"]) {
      withTags(p, [`@timeout ${value}`]);
      assert.equal(cli(p, ["run", "one"]).status, 0, value);
    }
  });

  // A real wait at a ceiling is 60 to 315 seconds, too long for a test run, so
  // the wait and the message are checked where run computes them.
  it("waits the grace past a script type's ceiling, and says how long it waited", () => {
    const probe = (lines: string[]) =>
      parseProbe("one", probeSource(lines.join("\n * ")));
    const restletAt = probe([restlet, "@timeout 300"]);
    const suiteletAt = probe(["@scriptType suitelet"]);
    const below = probe(["@scriptType Suitelet", "@timeout 44"]);
    assert.equal(secondsToWait(restletAt), 300 + graceSeconds);
    assert.equal(secondsToWait(suiteletAt), 45 + graceSeconds);
    assert.equal(secondsToWait(probe([restlet, "@timeout 299"])), 299);
    assert.equal(secondsToWait(below), 44);
    assert.match(
      timedOutMessage(suiteletAt),
      /timed out after 60 seconds.*Its limit is the most a Suitelet probe allows/,
    );
    assert.match(
      timedOutMessage(restletAt),
      /timed out after 315 seconds.*Its limit is the most a RESTlet probe allows/,
    );
    assert.doesNotMatch(timedOutMessage(suiteletAt), /@timeout/);
    assert.match(
      timedOutMessage(below),
      /timed out after 44 seconds.*up to 45/,
    );
  });

  describe("a Suitelet probe, which requestSuitelet gave up on at about 45 seconds at 2026.2", () => {
    const withSuiteletTags = (p: Project, tags: string[]) =>
      write(
        p.dir,
        "verification/probes/one.js",
        probeSource(
          ["@scriptType Suitelet", ...tags.map((line) => ` * ${line}`)].join(
            "\n",
          ),
        ),
      );

    it("reads 45 seconds when it declares no @timeout", () => {
      const p = project();
      withSuiteletTags(p, []);
      const [one] = listProbes(join(p.dir, "verification/probes"), []);
      assert.equal(one?.timeoutSeconds, 45);
    });

    it("refuses a @timeout over 45 at run and at deploy, naming the cut-off", () => {
      const p = project();
      p.script(...ok({ result: {}, version: "1" }));
      withSuiteletTags(p, ["@timeout 46"]);
      const run = cli(p, ["run", "one"]);
      assert.equal(run.status, 1, run.all);
      assert.match(run.stderr, /@timeout "46"[^\n]*1 to 45/);
      assert.match(run.stderr, /requestSuitelet/);
      const deploy = cli(p, ["deploy"]);
      assert.equal(deploy.status, 1, deploy.all);
      assert.match(deploy.stderr, /one: @timeout "46"/);
      assert.deepEqual(p.requests(), []);
    });

    it("accepts 45", () => {
      const p = project();
      p.script(...ok({ result: {}, version: "1" }));
      withSuiteletTags(p, ["@timeout 45"]);
      const result = cli(p, ["run", "one"]);
      assert.equal(result.status, 0, result.all);
    });

    it("tells a timed-out Suitelet probe its own limit, not 300", () => {
      const p = project();
      withSuiteletTags(p, ["@timeout 1"]);
      p.script(...slow(1500));
      const result = cli(p, ["run", "one"]);
      assert.equal(result.status, 1, result.all);
      assert.match(result.stderr, /one timed out after 1 seconds/);
      assert.match(result.stderr, /up to 45/);
      assert.doesNotMatch(result.stderr, /300/);
    });

    it("reports NetSuite's SSS_REQUEST_TIME_EXCEEDED at 45, not a CLI timeout", () => {
      const p = project();
      withSuiteletTags(p, []);
      p.script(
        ...ok({
          error:
            "the Suitelet host call failed: SSS_REQUEST_TIME_EXCEEDED: The host you are trying to connect to has exceeded the maximum allowed response time.",
        }),
      );
      const result = cli(p, ["run", "one"]);
      assert.equal(result.status, 1, result.all);
      assert.match(result.stderr, /SSS_REQUEST_TIME_EXCEEDED/);
      assert.doesNotMatch(result.stderr, /timed out/);
    });

    it("states the Suitelet cut-off in the README", () => {
      const readme = readFileSync(join(root, "README.md"), "utf8");
      assert.match(readme, /`SSS_REQUEST_TIME_EXCEEDED`/);
      assert.ok(readme.includes("from 1 to 45"));
    });
  });
});

describe("module allowlist", () => {
  const restletTags = "@scriptType Restlet";
  const source = (body: string, tags = restletTags) =>
    `/**\n * A probe.\n *\n * ${tags}\n */\n${body}\n`;
  const setup = (body: string, tags = restletTags) => {
    const p = project();
    write(p.dir, "verification/probes/one.js", source(body, tags));
    p.script(...ok({ probe: "one", result: {}, version: "1" }));
    return p;
  };
  const refused = (p: Project) => {
    const run = cli(p, ["run", "one"]);
    assert.equal(run.status, 1, run.all);
    assert.deepEqual(p.requests(), []);
    const deploy = cli(p, ["deploy"]);
    assert.equal(deploy.status, 1, deploy.all);
    return { deploy: deploy.stderr, run: run.stderr };
  };

  it("classifies every module as allowed or writing", () => {
    const entries = Object.entries(moduleClasses);
    assert.ok(entries.length > 20);
    for (const [name, kind] of entries) {
      assert.match(name, /^N\//);
      assert.ok(kind === "allowed" || kind === "writing", name);
    }
    assert.equal(moduleClasses["N/record"], "allowed");
    assert.equal(moduleClasses["N/search"], "allowed");
    assert.equal(moduleClasses["N/email"], "writing");
  });

  it("runs and deploys a probe that imports only allowed modules", () => {
    const p = setup(
      `define(["N/record", "N/search", "N/runtime"], (record, search, runtime) => ({ run() { return {}; } }));`,
    );
    const run = cli(p, ["run", "one"]);
    assert.equal(run.status, 0, run.all);
    const deploy = cli(p, ["deploy"]);
    assert.equal(deploy.status, 0, deploy.all);
  });

  it("allows a literal require of an allowed module, inside define or as an async call", () => {
    const p = setup(
      `define(["require"], (require) => ({ run() { const r = require("N/record"); require(["N/query"], () => {}); return {}; } }));`,
    );
    assert.equal(cli(p, ["run", "one"]).status, 0);
  });

  it("ignores a module named in a comment or a string", () => {
    const p = setup(
      `// define(["N/email"])\ndefine([], () => ({ run() { return "require('N/email')"; } }));`,
    );
    assert.equal(cli(p, ["run", "one"]).status, 0);
  });

  it("refuses a writing module in define, naming the probe, module and tags to add", () => {
    const p = setup(`define(["N/email"], (email) => ({ run() {} }));`);
    const { deploy, run } = refused(p);
    for (const text of [run, deploy]) {
      assert.match(text, /one/);
      assert.match(text, /N\/email/);
      assert.match(text, /@writes/);
      assert.match(text, /above VIEW/);
    }
  });

  it("refuses a writing module reached through require", () => {
    const p = setup(
      `define([], () => ({ run() { return require("N/https"); } }));`,
    );
    assert.match(refused(p).run, /N\/https/);
  });

  it("refuses a module the package does not know with a pre-filled new-issue link, and makes no request", () => {
    const p = setup(`define(["N/madeUp"], (m) => ({ run() {} }));`);
    const { deploy, run } = refused(p);
    for (const text of [run, deploy]) {
      assert.match(text, /N\/madeUp/);
      const link =
        /https:\/\/github\.com\/nemchik\/suitescript-verify\/issues\/new\?\S+/.exec(
          text,
        )?.[0];
      assert.ok(link, text);
      const url = new URL(link);
      assert.match(url.searchParams.get("body") ?? "", /N\/madeUp/);
      assert.match(
        url.searchParams.get("body") ?? "",
        /2\.\d+\.\d+|\d+\.\d+\.\d+/,
      );
      assert.match(text, /ask the person/i);
    }
  });

  it("puts nothing but the module name and version in the link", () => {
    const p = setup(
      `define(["N/madeUp"], (m) => ({ run() { return "secret-token-123"; } }));`,
      `${restletTags}\n * @param secretParam ^x$`,
    );
    const link = /issues\/new\?\S+/.exec(refused(p).run)?.[0] ?? "";
    assert.doesNotMatch(decodeURIComponent(link), /secret|one\b/);
  });

  it("refuses a module that is not an N/ module, with no link", () => {
    const p = setup(
      `define(["./helper", "/SuiteScripts/x"], () => ({ run() {} }));`,
    );
    const { run } = refused(p);
    assert.match(run, /\.\/helper/);
    assert.doesNotMatch(run, /issues\/new/);
  });

  it("refuses a require whose module name is not a literal", () => {
    for (const body of [
      `define([], () => ({ run() { const n = "N/record"; return require(n); } }));`,
      `define([], () => ({ run() { return require("N/" + "record"); } }));`,
      `define([], () => ({ run() { return require(\`N/\${x}\`); } }));`,
      `define([], () => ({ run() { return require(["N/record", name]); } }));`,
    ]) {
      const p = setup(body);
      assert.match(refused(p).run, /not a literal/, body);
    }
  });

  it("refuses define dependencies that are not a literal list of strings", () => {
    for (const body of [
      `const deps = ["N/record"];\ndefine(deps, () => ({ run() {} }));`,
      `define(["N/rec" + "ord"], () => ({ run() {} }));`,
    ]) {
      const p = setup(body);
      assert.match(refused(p).run, /not a literal/, body);
    }
  });

  it("does not apply to a probe that declares @writes, which is still refused as before", () => {
    const p = setup(
      `define(["N/email"], () => ({ run() {} }));`,
      `${restletTags}\n * @writes`,
    );
    const run = cli(p, ["run", "one"]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /declares @writes/);
    assert.doesNotMatch(run.stderr, /N\/email/);
  });
});
