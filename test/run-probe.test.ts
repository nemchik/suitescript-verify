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

interface Answer {
  body: unknown;
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
    .filter((f) => f.endsWith("runner.js"))
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

function cli(p: Project, args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.SUITECLOUD_CLI_ACCEPT_LICENSE;
  for (const name of Object.keys(base)) {
    if (name.startsWith("SUITESCRIPT_VERIFY_")) delete base[name];
  }
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: p.dir,
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
      "SuiteScripts/suitescript-verify/runner.js",
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
    assert.match(cli(p, ["run", "client"]).stderr, /RESTlet probes/);
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
    assert.match(result.stderr, /The runner refused/);
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

    it("flags a difference with exit 2", () => {
      const p = project();
      withProbe(p);
      write(p.dir, "verification/probes/one.expect.json", '{"ok": false}');
      p.script(...ok({ result: { ok: true }, version: "2026.2" }));
      const result = cli(p, ["run", "one"]);
      assert.equal(result.status, 2);
      assert.match(result.stdout, /DRIFT/);
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
      version: "1",
    };
    const runner = factory(runtime, {
      run: (params: unknown) => {
        seen.push(params);
        return "done";
      },
    });
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
