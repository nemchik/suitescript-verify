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
 * The scratch area: what a deploy writes for it, the permissions writing
 * probes get, and what the generated hosts do with it. Driven through the
 * built CLI in a temporary project with a fake SuiteCloud CLI and fake `N/`
 * modules, like run-probe.test.ts.
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
  scratch: read("scratch.js"),
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
  const dir = mkdtempSync(join(tmpdir(), "suitescript-verify-scratch-"));
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
    files: string[];
    objects: string[];
    restletHost: string[];
    scratch: string[];
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

const suitelet = "@scriptType Suitelet";
const restlet = "@scriptType Restlet";
const recordType = "customrecord_suitescript_verify_sc";
const slot = (index: number) => `customdeploy_suitescript_verify_s${index}`;
const runtimeAt = (deploymentId: string) => ({
  EnvType: { PRODUCTION: "PRODUCTION", SANDBOX: "SANDBOX" },
  envType: "SANDBOX",
  getCurrentScript: () => ({ deploymentId, getRemainingUsage: () => 5000 }),
  getCurrentUser: () => ({ getPermission: () => 0 }),
  Permission: { CREATE: 2, EDIT: 3, FULL: 4, NONE: 0, VIEW: 1 },
  version: "2026.2",
});

type Item = { folder?: number; id: string; kind: string; name: string };

/** A fake account's scratch area: items with names, and fake `N/file`, `N/record` and `N/search` over them. */
function fakeAccount() {
  const items: Item[] = [];
  let next = 1;
  const add = (kind: string, name: string, folder?: number) => {
    items.push({ folder, id: String(next++), kind, name });
  };
  const remove = (kind: string, id: string) => {
    const at = items.findIndex((i) => i.kind === kind && i.id === id);
    if (at === -1) throw Object.assign(new Error("gone"), { name: "GONE" });
    items.splice(at, 1);
  };
  const file = {
    delete: ({ id }: { id: string }) => remove("file", id),
    load: ({ id }: { id: string }) => {
      if (!id.endsWith("/scratch/readme.txt")) throw new Error(`no ${id}`);
      return { folder: 77 };
    },
  };
  const record = {
    delete: ({ id, type }: { id: string; type: string }) => remove(type, id),
  };
  const search = {
    create: ({ filters, type }: { filters: unknown[]; type: string }) => ({
      run: () => ({
        each: (cb: (row: unknown) => boolean) => {
          const flat = filters.flat(2) as string[];
          const start = flat[flat.indexOf("startswith") + 1] ?? "";
          const folder = flat.includes("folder")
            ? flat[flat.indexOf("anyof") + 1]
            : undefined;
          for (const item of [...items]) {
            if (item.kind !== type || !item.name.startsWith(start)) continue;
            if (folder !== undefined && String(item.folder) !== folder)
              continue;
            cb({ getValue: () => item.name, id: item.id });
          }
        },
      }),
    }),
  };
  return { add, items, modules: [file, record, search] };
}

const hex = "[0-9a-f]{8}";
const prefixPattern = new RegExp(`^ssv-[0-9a-z]{8}${hex}-$`);
/** A scratch item's name for a run that started `ageMs` ago. */
const runName = (ageMs: number, rest: string) =>
  `ssv-${(Date.now() - ageMs).toString(36).padStart(8, "0")}${"0".repeat(8)}-${rest}`;

describe("deploy writes the scratch area", () => {
  it("writes a scratch record type with permission-list access, the scratch folder's marker file and the scratch module", () => {
    const p = project();
    assert.equal(cli(p, ["deploy"]).status, 0);
    const call = calls(p);
    const record = call.objects.find((o) => o.startsWith("<customrecordtype"));
    assert.ok(record);
    assert.match(
      record,
      new RegExp(`<customrecordtype scriptid="${recordType}">`),
    );
    assert.match(record, /<accesstype>USEPERMISSIONLIST<\/accesstype>/);
    assert.doesNotMatch(record, /enablemailmerge/);
    // No role is named in the record: the roles that hold its permission use it.
    assert.doesNotMatch(record, /<permittedrole>|<permissions>/);
    const files = call.files.map((f) => f.replaceAll("\\", "/"));
    assert.ok(
      files.includes("SuiteScripts/suitescript-verify/scratch/readme.txt"),
      files.join(),
    );
    assert.ok(files.includes("SuiteScripts/suitescript-verify/scratch.js"));
    const module = call.scratch.join("");
    assert.match(module, new RegExp(recordType));
    assert.match(
      module,
      /\/SuiteScripts\/suitescript-verify\/scratch\/readme\.txt/,
    );
  });

  it("keeps the record type's id within 40 characters for the longest runner id, and drops another runner id's", () => {
    const p = project();
    const id = "a".repeat(24);
    const result = cli(p, ["deploy"], { SUITESCRIPT_VERIFY_RUNNER_ID: id });
    assert.equal(result.status, 0, result.all);
    const record = calls(p).objects.find((o) =>
      o.startsWith("<customrecordtype"),
    );
    const scriptId = /scriptid="([^"]+)"/.exec(record ?? "")?.[1] ?? "";
    assert.equal(scriptId, `customrecord_${id}_sc`);
    assert.ok(scriptId.length <= 40);
    assert.equal(cli(p, ["deploy"]).status, 0);
    const records = calls(p).objects.filter((o) =>
      o.startsWith("<customrecordtype"),
    );
    assert.equal(records.length, 1);
    assert.match(records[0] ?? "", new RegExp(recordType));
  });

  const perms = (xml: string) =>
    [...xml.matchAll(/<permkey>([^<]+)<\/permkey>\s*<permlevel>([^<]+)</g)]
      .map((m) => `${m[1]} ${m[2]}`)
      .join(", ");
  const executionRoles = (p: Project) =>
    calls(p)
      .objects.filter(
        (o) => o.startsWith("<role ") && o.includes("<name>ssv exec "),
      )
      .map(perms)
      .sort();

  it("gives every writing probe's execution role FULL on the scratch record type and folder, and no other role", () => {
    const p = project();
    write(
      p.dir,
      "verification/probes/mail.js",
      probeSource([suitelet, "@writes"]),
    );
    write(
      p.dir,
      "verification/probes/edit.js",
      probeSource([suitelet, "@permission LIST_CUSTJOB EDIT"]),
    );
    write(
      p.dir,
      "verification/probes/low.js",
      probeSource([suitelet, "@permission LIST_CUSTJOB VIEW"]),
    );
    write(p.dir, "verification/probes/plain.js", probeSource([suitelet]));
    assert.equal(cli(p, ["deploy"]).status, 0);
    assert.deepEqual(
      executionRoles(p),
      [
        "",
        "LIST_CUSTJOB VIEW",
        `LIST_CUSTJOB EDIT, LIST_FILECABINET FULL, ${recordType} FULL`,
        `LIST_FILECABINET FULL, ${recordType} FULL`,
      ].sort(),
    );
  });

  it("lifts a lower level a writing probe declares for a scratch key to FULL", () => {
    const p = project();
    write(
      p.dir,
      "verification/probes/mail.js",
      probeSource([suitelet, "@writes", "@permission LIST_FILECABINET VIEW"]),
    );
    assert.equal(cli(p, ["deploy"]).status, 0);
    assert.ok(
      executionRoles(p).includes(`LIST_FILECABINET FULL, ${recordType} FULL`),
      executionRoles(p).join(" | "),
    );
  });
});

describe("the Suitelet host's scratch area", () => {
  type Host = { onRequest: (c: unknown) => unknown };
  type Ctx = {
    scratch?: { folderId: number; prefix: string; recordType: string };
  };
  type Account = ReturnType<typeof fakeAccount>;
  const setup = (run: (context: Ctx, account: Account) => unknown) => {
    const p = project();
    write(p.dir, "verification/probes/plain.js", probeSource([suitelet]));
    write(
      p.dir,
      "verification/probes/page.js",
      probeSource([suitelet, "@writes"]),
    );
    assert.equal(cli(p, ["deploy"]).status, 0);
    const account = fakeAccount();
    const scratch = load<unknown>(
      calls(p).scratch.join(""),
      ...account.modules,
    );
    // Slot 0 runs as no permissions (plain); slot 1 is the writing probe's set.
    const probes = [
      { run: (_a: unknown, c: Ctx) => run(c, account) },
      { run: () => "plain" },
    ];
    const host = (index: number) =>
      load<Host>(
        calls(p).suitelet.join(""),
        runtimeAt(slot(index)),
        {},
        ...probes,
        scratch,
      );
    return { account, host };
  };
  const ask = async (host: Host, probe: string) => {
    const written: string[] = [];
    await host.onRequest({
      request: { method: "GET", parameters: { probe } },
      response: {
        addHeader: () => undefined,
        setHeader: () => undefined,
        write: (o: { output: string }) => written.push(o.output),
      },
    });
    return JSON.parse(written.join(""));
  };

  it("hands a writing probe context.scratch with the record type, the folder id and a prefix unique to each run", async () => {
    const seen: Ctx[] = [];
    const { host } = setup((context) => {
      seen.push(context);
      return "ok";
    });
    const h = host(1);
    await ask(h, "page");
    await ask(h, "page");
    assert.equal(seen.length, 2);
    for (const { scratch } of seen) {
      assert.equal(scratch?.recordType, recordType);
      assert.equal(scratch?.folderId, 77);
      assert.match(scratch?.prefix ?? "", prefixPattern);
    }
    assert.notEqual(seen[0]?.scratch?.prefix, seen[1]?.scratch?.prefix);
  });

  it("gives a probe that does not write no scratch context, and never opens the scratch area", async () => {
    const { account, host } = setup(() => "unused");
    account.add(recordType, runName(3_600_000, "old"));
    const answer = await ask(host(0), "plain");
    assert.equal(answer.result, "plain");
    assert.equal("scratch" in answer, false);
    // Not even the sweep ran: the old item is still there.
    assert.equal(account.items.length, 1);
  });

  it("deletes the run's prefixed records and files after the probe returns, and leaves other items", async () => {
    const { account, host } = setup(({ scratch }, a) => {
      const prefix = scratch?.prefix ?? "";
      a.add(recordType, `${prefix}one`);
      a.add(recordType, `${prefix}two`);
      a.add("file", `${prefix}note.txt`, 77);
      a.add("file", `${prefix}elsewhere.txt`, 5);
      a.add(recordType, "not the run's");
      return "ok";
    });
    const answer = await ask(host(1), "page");
    assert.deepEqual(answer.scratch.cleanup, { files: 1, records: 2 });
    assert.deepEqual(
      account.items.map((i) => i.name.replace(/^ssv-\w+-/, "")).sort(),
      ["elsewhere.txt", "not the run's"],
    );
  });

  it("deletes them when the probe throws, and when it rejects", async () => {
    let how = "throw";
    const { account, host } = setup(({ scratch }, a) => {
      a.add(recordType, `${scratch?.prefix}x`);
      if (how === "throw") throw new Error("boom");
      return Promise.reject(new Error("nope"));
    });
    const h = host(1);
    const thrown = await ask(h, "page");
    assert.equal(thrown.result, "THROWS: Error: boom");
    assert.equal(account.items.length, 0);
    how = "reject";
    const rejected = await ask(h, "page");
    assert.equal(rejected.result, "REJECTS: Error: nope");
    assert.equal(account.items.length, 0);
    assert.deepEqual(rejected.scratch.cleanup, { files: 0, records: 1 });
  });

  it("sweeps items older than the longest timeout plus the margin at the start of a write run, and leaves newer ones", async () => {
    const { account, host } = setup(() => "ok");
    account.add(recordType, runName(10 * 60_000, "old-record"));
    account.add(recordType, runName(60_000, "new-record"));
    account.add("file", runName(10 * 60_000, "old-file"), 77);
    account.add("file", runName(60_000, "new-file"), 77);
    account.add(recordType, "ssv-not-a-run-name");
    const answer = await ask(host(1), "page");
    assert.deepEqual(answer.scratch.sweep, { files: 1, records: 1 });
    assert.deepEqual(
      account.items.map((i) => i.name.replace(/^ssv-\w{16}-/, "")).sort(),
      ["new-file", "new-record", "ssv-not-a-run-name"],
    );
  });

  it("reports a delete that fails without replacing the probe's answer", async () => {
    const { account, host } = setup(({ scratch }, a) => {
      a.add(recordType, `${scratch?.prefix}x`);
      return "ok";
    });
    // The platform refuses every delete.
    const real = account.modules[1] as { delete: (o: never) => void };
    real.delete = () => {
      throw Object.assign(new Error("in use"), { name: "RCRD_IN_USE" });
    };
    const answer = await ask(host(1), "page");
    assert.equal(answer.result, "ok");
    assert.match(answer.scratch.cleanup.error, /RCRD_IN_USE: in use/);
  });
});

describe("the RESTlet host's scratch area", () => {
  it("sends a @writes RESTlet probe through its slot to the RESTlet host, which gives it context.scratch and cleans up", async () => {
    const p = project();
    write(
      p.dir,
      "verification/probes/mail.js",
      probeSource([restlet, "@writes"]),
    );
    write(p.dir, "verification/probes/plain.js", probeSource([restlet]));
    assert.equal(cli(p, ["deploy"]).status, 0);
    // The runner sends the writing probe to its slot and never runs it itself.
    let ran = 0;
    let slots = 0;
    const runner = load<{ post: (b: object) => { scriptType?: string } }>(
      calls(p).runner.join(""),
      runtimeAt(slot(0)),
      {
        requestSuitelet: () => {
          slots++;
          return {
            body: JSON.stringify({ result: 1, scriptType: "RESTlet" }),
            code: 200,
            headers: { "x-ssv-mode": "wrapped" },
          };
        },
      },
      { run: () => ran++ },
    );
    runner.post({ probe: "mail" });
    assert.equal(slots, 1);
    assert.equal(ran, 0);
    // The RESTlet host runs it with the scratch area.
    const account = fakeAccount();
    const scratch = load<unknown>(
      calls(p).scratch.join(""),
      ...account.modules,
    );
    let seen: Ctx | undefined;
    type Ctx = { scratch?: { prefix: string; recordType: string } };
    const host = load<{ post: (b: object) => unknown }>(
      calls(p).restletHost.join(""),
      runtimeAt(slot(1)),
      {
        run: (_params: unknown, context: Ctx) => {
          seen = context;
          account.add(recordType, `${context.scratch?.prefix}r`);
          return "ok";
        },
      },
      scratch,
    );
    const answer = (await host.post({ probe: "mail", slot: slot(1) })) as {
      error?: string;
      result?: unknown;
      scratch?: { cleanup: unknown };
    };
    assert.equal(answer.error, undefined);
    assert.equal(answer.result, "ok");
    assert.equal(seen?.scratch?.recordType, recordType);
    assert.match(seen?.scratch?.prefix ?? "", prefixPattern);
    assert.deepEqual(answer.scratch?.cleanup, { files: 0, records: 1 });
    assert.equal(account.items.length, 0);
  });
});
