import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const bin = join(
  import.meta.dirname,
  "..",
  "dist",
  "bin",
  "suitescript-verify.js",
);
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { force: true, recursive: true });
});

/** Settings every command that reaches the sandbox needs; none is a real account. */
const sandboxEnv = {
  SUITESCRIPT_VERIFY_ACCOUNT: "1234567_SB1",
  SUITESCRIPT_VERIFY_CERTIFICATE_ID: "cert-runner-id",
  SUITESCRIPT_VERIFY_CLIENT_ID: "client-id-value",
  SUITESCRIPT_VERIFY_PRIVATE_KEY_PATH: "unused.pem",
  SUITESCRIPT_VERIFY_SDF_CERTIFICATE_ID: "cert-sdf-id",
  SUITESCRIPT_VERIFY_SDF_PRIVATE_KEY_PATH: "unused-sdf.pem",
};

/** Runs the built CLI in `cwd`, with the SuiteCloud license variable removed from the environment. */
function cli(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SUITECLOUD_CLI_ACCEPT_LICENSE;
  for (const name of Object.keys(env)) {
    if (name.startsWith("SUITESCRIPT_VERIFY_")) delete env[name];
  }
  Object.assign(env, sandboxEnv, extraEnv);
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input: "",
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

/**
 * A temporary project whose `@oracle/suitecloud-cli` is a fake that records
 * how it was called (arguments, working folder and whether the license variable
 * was set) to `calls.json` in the project, instead of touching NetSuite.
 */
function fakeProject({ withCli = true } = {}) {
  const project = mkdtempSync(join(tmpdir(), "suitescript-verify-"));
  temps.push(project);
  mkdirSync(join(project, "verification", "sdf"), { recursive: true });
  if (withCli) {
    const dir = join(
      project,
      "node_modules",
      "@oracle",
      "suitecloud-cli",
      "src",
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(
        project,
        "node_modules",
        "@oracle",
        "suitecloud-cli",
        "package.json",
      ),
      '{"name":"@oracle/suitecloud-cli","version":"0.0.0"}',
    );
    writeFileSync(
      join(dir, "suitecloud.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(join(project, "calls.json"))}, JSON.stringify({
        args: process.argv.slice(2),
        cwd: process.cwd(),
        license: process.env.SUITECLOUD_CLI_ACCEPT_LICENSE ?? null,
        passkey: process.env.SUITECLOUD_CI_PASSKEY ?? null,
      }));`,
    );
  }
  return project;
}

const calls = (project: string) =>
  JSON.parse(readFileSync(join(project, "calls.json"), "utf8")) as {
    args: string[];
    cwd: string;
    license: string | null;
    passkey: string | null;
  };

describe("help", () => {
  it("lists the commands", () => {
    const result = cli(["help"], tmpdir());
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: suitescript-verify/);
    assert.match(result.stdout, /deploy/);
  });

  it("is what a bare run and --help show", () => {
    assert.equal(cli([], tmpdir()).stdout, cli(["--help"], tmpdir()).stdout);
  });

  it("rejects an unknown command", () => {
    const result = cli(["frobnicate"], tmpdir());
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command "frobnicate"/);
  });
});

describe("deploy", () => {
  it("dry-runs through the project's SuiteCloud CLI, from the SDF folder, without the license variable", () => {
    const project = fakeProject();
    const result = cli(["deploy"], project);
    assert.equal(result.status, 0, result.stderr);
    const call = calls(project);
    assert.deepEqual(call.args, ["project:deploy", "--dryrun"]);
    assert.match(call.cwd.replaceAll("\\", "/"), /verification\/sdf$/);
    assert.equal(call.license, null);
  });

  it("moves the verification folder with --dir", () => {
    const project = fakeProject();
    mkdirSync(join(project, "elsewhere", "sdf"), { recursive: true });
    const result = cli(["deploy", "--dir", "elsewhere"], project);
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls(project).cwd.replaceAll("\\", "/"), /elsewhere\/sdf$/);
  });

  it("refuses a real deploy without a terminal and never calls the CLI", () => {
    const project = fakeProject();
    const result = cli(["deploy", "--approved"], project);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs the user at a terminal/);
    assert.equal(existsSync(join(project, "calls.json")), false);
  });

  it("says what to install when the SuiteCloud CLI is missing", () => {
    const result = cli(["deploy"], fakeProject({ withCli: false }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@oracle\/suitecloud-cli/);
  });
});

const norm = (path: string) => path.replaceAll("\\", "/");
const git = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });
const write = (project: string, file: string, text: string) => {
  mkdirSync(join(project, file, ".."), { recursive: true });
  writeFileSync(join(project, file), text);
};
const sdfKey = "SUITESCRIPT_VERIFY_SDF_DIR";

describe("layered configuration", () => {
  it("falls back to the default SDF folder, then each layer overrides the last", () => {
    const project = fakeProject();
    for (const dir of ["one", "two", "three"]) {
      mkdirSync(join(project, dir), { recursive: true });
    }
    const cwdAfter = (env: Record<string, string> = {}) => {
      assert.equal(cli(["deploy"], project, env).status, 0);
      return norm(calls(project).cwd);
    };
    assert.match(cwdAfter(), /verification\/sdf$/);
    write(project, "verification/.env", `${sdfKey}=one\n`);
    assert.match(cwdAfter(), /\/one$/);
    write(project, "verification/.env.local", `${sdfKey}=two\n`);
    assert.match(cwdAfter(), /\/two$/);
    assert.match(cwdAfter({ [sdfKey]: "three" }), /\/three$/);
  });

  it("hands a passkey from .env.local to the SuiteCloud CLI for the child only", () => {
    const project = fakeProject();
    write(
      project,
      "verification/.env.local",
      "SUITESCRIPT_VERIFY_PASSKEY=local-pass\n",
    );
    assert.equal(cli(["deploy"], project).status, 0);
    assert.equal(calls(project).passkey, "local-pass");
  });

  it("moves the env files with --dir", () => {
    const project = fakeProject();
    mkdirSync(join(project, "elsewhere", "custom"), { recursive: true });
    write(project, "elsewhere/.env", `${sdfKey}=elsewhere/custom\n`);
    write(project, "verification/.env", `${sdfKey}=nowhere\n`);
    const result = cli(["deploy", "--dir", "elsewhere"], project);
    assert.equal(result.status, 0, result.stderr);
    assert.match(norm(calls(project).cwd), /elsewhere\/custom$/);
  });
});

describe("the committed .env allowlist", () => {
  const secret = "s3cr3t-VALUE-0123456789abcdef0123456789abcdef";
  const bad: Record<string, [string, string]> = {
    "a credential key": [
      "SUITESCRIPT_VERIFY_PASSKEY",
      `SUITESCRIPT_VERIFY_PASSKEY=${secret}`,
    ],
    "a path outside the project": [sdfKey, `${sdfKey}=../${secret}`],
    "a secret-looking value": [
      "SUITESCRIPT_VERIFY_PROBES_DIR",
      `SUITESCRIPT_VERIFY_PROBES_DIR=${secret}`,
    ],
    "an unknown key": [
      "SUITESCRIPT_VERIFY_MYSTERY",
      `SUITESCRIPT_VERIFY_MYSTERY=${secret}`,
    ],
  };
  for (const [name, [key, line]] of Object.entries(bad)) {
    it(`refuses ${name}, names the key and never prints the value`, () => {
      const project = fakeProject();
      write(project, "verification/.env", `${line}\n`);
      const result = cli(["deploy"], project);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(key), result.stderr);
      assert.equal((result.stdout + result.stderr).includes(secret), false);
      assert.equal(existsSync(join(project, "calls.json")), false);
    });
  }

  it("accepts the layout keys", () => {
    const project = fakeProject();
    write(
      project,
      "verification/.env",
      "SUITESCRIPT_VERIFY_PROBES_DIR=verification/probes\nSUITESCRIPT_VERIFY_RESULTS_DIR=docs/verification/results\n",
    );
    assert.equal(cli(["deploy"], project).status, 0);
  });

  for (const command of ["doctor", "init"]) {
    it(`${command} reports a bad key instead of refusing`, () => {
      const project = fakeProject();
      write(
        project,
        "verification/.env",
        `SUITESCRIPT_VERIFY_RESULTS_DIR=docs/verification/results\nSUITESCRIPT_VERIFY_MYSTERY=${secret}\n`,
      );
      const result = cli([command], project);
      assert.equal(result.status, command === "doctor" ? 1 : 0);
      assert.match(result.stdout, /SUITESCRIPT_VERIFY_MYSTERY/);
      assert.equal((result.stdout + result.stderr).includes(secret), false);
    });
  }
});

describe(".env.local must be gitignored", () => {
  const repo = () => {
    const project = fakeProject();
    git(project, ["init", "-q"]);
    return project;
  };

  it("flags a .env.local that is not ignored, in every command", () => {
    const project = repo();
    write(project, "verification/.env.local", "SUITESCRIPT_VERIFY_ACCOUNT=1\n");
    const result = cli(["deploy"], project);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.local/);
    assert.match(result.stderr, /gitignore/);
    assert.match(cli(["doctor"], project).stdout, /\.env\.local/);
  });

  it("flags a tracked .env.local even when it is ignored", () => {
    const project = repo();
    write(project, "verification/.env.local", "SUITESCRIPT_VERIFY_ACCOUNT=1\n");
    git(project, ["add", "-f", "verification/.env.local"]);
    write(project, ".gitignore", "verification/.env.local\n");
    const result = cli(["deploy"], project);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tracked/);
  });

  it("passes when .env.local is ignored", () => {
    const project = repo();
    write(project, ".gitignore", "verification/.env.local\n");
    write(project, "verification/.env.local", "SUITESCRIPT_VERIFY_ACCOUNT=1\n");
    assert.equal(cli(["deploy"], project).status, 0);
  });
});

describe("SUITESCRIPT_VERIFY_ROLE_ID", () => {
  const roleKey = "SUITESCRIPT_VERIFY_ROLE_ID";
  const sdfFile = (project: string, file: string) =>
    readFileSync(join(project, "verification", "sdf", "src", file), "utf8");
  const runner = "Objects/customscript_suitescript_verify_rl.xml";

  const role = (project: string, id: string) =>
    sdfFile(project, `Objects/${id}.xml`);
  const permissions = (xml: string) =>
    [
      ...xml.matchAll(
        /<permission>\s*<permkey>([^<]+)<\/permkey>\s*<permlevel>([^<]+)<\/permlevel>\s*<\/permission>/g,
      ),
    ].map((match) => `${match[1]} ${match[2]}`);

  it("writes the role as an SDF object with only the token-login and REST permissions, at FULL", () => {
    const project = fakeProject();
    assert.equal(cli(["deploy"], project).status, 0);
    const xml = role(project, "customrole_suitescript_verify");
    assert.match(xml, /^<role scriptid="customrole_suitescript_verify">/);
    assert.match(xml, /<centertype>ACCOUNTCENTER<\/centertype>/);
    assert.match(xml, /<name>ssv runner role suitescript_verify<\/name>/);
    // Fields SDF warns about on every deploy are left at their defaults by leaving them out.
    for (const field of ["coreadminpermissions", "iswebserviceonlyrole"]) {
      assert.equal(xml.includes(field), false, field);
    }
    assert.equal(xml.includes("subsidiaryoption"), false);
    assert.deepEqual(permissions(xml), [
      "ADMI_LOGIN_OAUTH2 FULL",
      "ADMI_RESTWEBSERVICES FULL",
    ]);
    assert.equal((xml.match(/<permission>/g) ?? []).length, 2);
  });

  it("leaves the role out of the manifest's dependencies, since the project holds it", () => {
    const project = fakeProject();
    assert.equal(cli(["deploy"], project).status, 0);
    const manifest = sdfFile(project, "manifest.xml");
    assert.equal(manifest.includes("customrole_"), false);
    assert.equal(manifest.includes("<objects>"), false);
    assert.match(
      manifest,
      /<feature required="true">SERVERSIDESCRIPTING<\/feature>/,
    );
  });

  it("defaults to customrole_<runner id>, in the role object and the runner's audience", () => {
    const project = fakeProject();
    write(
      project,
      "verification/.env",
      "SUITESCRIPT_VERIFY_RUNNER_ID=my_project\n",
    );
    assert.equal(cli(["deploy"], project).status, 0);
    assert.match(
      role(project, "customrole_my_project"),
      /<role scriptid="customrole_my_project">/,
    );
    assert.match(
      sdfFile(project, "Objects/customscript_my_project_rl.xml"),
      /<audslctrole>\[customrole_my_project\]<\/audslctrole>/,
    );
    const out = cli(["doctor"], project).stdout;
    assert.match(out, /customrole_my_project/);
  });

  it("follows a 24-character runner id and stays within the platform's 40 characters", () => {
    const project = fakeProject();
    const id = `r${"a".repeat(23)}`;
    write(project, "verification/.env", `SUITESCRIPT_VERIFY_RUNNER_ID=${id}\n`);
    assert.equal(cli(["deploy"], project).status, 0);
    const xml = role(project, `customrole_${id}`);
    const scriptId = /<role scriptid="([^"]+)">/.exec(xml)?.[1] ?? "";
    assert.equal(scriptId, `customrole_${id}`);
    assert.ok(scriptId.length <= 40);
    const name = /<name>([^<]+)<\/name>/.exec(xml)?.[1] ?? "";
    assert.ok(name.length <= 40, name);
  });

  it("is overridden from the committed .env, in the role object and the runner", () => {
    const project = fakeProject();
    write(
      project,
      "verification/.env",
      `${roleKey}=customrole_my_runner\nSUITESCRIPT_VERIFY_RUNNER_ID=other\n`,
    );
    assert.equal(cli(["deploy"], project).status, 0);
    assert.match(
      role(project, "customrole_my_runner"),
      /<role scriptid="customrole_my_runner">/,
    );
    assert.equal(
      existsSync(
        join(project, "verification/sdf/src/Objects/customrole_other.xml"),
      ),
      false,
    );
    assert.match(
      sdfFile(project, "Objects/customscript_other_rl.xml"),
      /<audslctrole>\[customrole_my_runner\]<\/audslctrole>/,
    );
  });

  it("layers: .env.local and then the process environment win over .env", () => {
    const project = fakeProject();
    write(project, "verification/.env", `${roleKey}=customrole_from_file\n`);
    write(
      project,
      "verification/.env.local",
      `${roleKey}=customrole_from_local\n`,
    );
    assert.equal(cli(["deploy"], project).status, 0);
    assert.match(
      role(project, "customrole_from_local"),
      /scriptid="customrole_from_local"/,
    );
    assert.equal(
      cli(["deploy"], project, { [roleKey]: "customrole_from_env" }).status,
      0,
    );
    assert.match(
      role(project, "customrole_from_env"),
      /scriptid="customrole_from_env"/,
    );
  });

  it("removes a role object generated under another id, so it is not deployed again", () => {
    const project = fakeProject();
    write(project, "verification/.env", `${roleKey}=customrole_old_role\n`);
    assert.equal(cli(["deploy"], project).status, 0);
    write(project, "verification/.env", `${roleKey}=customrole_new_role\n`);
    assert.equal(cli(["deploy"], project).status, 0);
    const objects = join(project, "verification/sdf/src/Objects");
    assert.equal(existsSync(join(objects, "customrole_old_role.xml")), false);
    assert.ok(existsSync(join(objects, "customrole_new_role.xml")));
  });

  it("cleanup leaves the role as deploy wrote it and only switches the runner off", () => {
    const project = fakeProject();
    assert.equal(cli(["deploy"], project).status, 0);
    const deployed = role(project, "customrole_suitescript_verify");
    assert.equal(cli(["cleanup"], project).status, 0);
    assert.equal(role(project, "customrole_suitescript_verify"), deployed);
    assert.match(sdfFile(project, runner), /<isdeployed>F<\/isdeployed>/);
  });

  for (const value of [
    "role_without_prefix",
    "customrole_Upper",
    "customrole_-",
    "customrole_a</object>",
  ]) {
    it(`refuses ${JSON.stringify(value)}, names the key and never prints the value`, () => {
      const project = fakeProject();
      write(project, "verification/.env", `${roleKey}=${value}\n`);
      const result = cli(["deploy"], project);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(roleKey), result.stderr);
      assert.equal((result.stdout + result.stderr).includes(value), false);
      assert.equal(existsSync(join(project, "calls.json")), false);
    });
  }

  it("refuses a bad value from the process environment too", () => {
    const project = fakeProject();
    const result = cli(["deploy"], project, { [roleKey]: "nope" });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(roleKey));
    assert.equal(result.stderr.includes("nope"), false);
  });

  it("accepts the longest id the platform allows, 40 characters with the prefix, though it looks like a token", () => {
    const project = fakeProject();
    write(
      project,
      "verification/.env",
      `${roleKey}=customrole_${"a".repeat(29)}\n`,
    );
    assert.equal(cli(["deploy"], project).status, 0);
  });

  it("refuses an id of 41 characters, which the platform rejects, naming the key and not the value", () => {
    const id = `customrole_${"a".repeat(30)}`;
    const fromFile = fakeProject();
    write(fromFile, "verification/.env", `${roleKey}=${id}\n`);
    const fromEnv = fakeProject();
    for (const result of [
      cli(["deploy"], fromFile),
      cli(["deploy"], fromEnv, { [roleKey]: id }),
    ]) {
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(roleKey));
      assert.equal(result.stderr.includes(id), false);
    }
  });

  it("doctor reports the role id in use", () => {
    const project = fakeProject();
    write(project, "verification/.env", `${roleKey}=customrole_my_runner\n`);
    const out = cli(["doctor"], project).stdout;
    assert.match(out, /Runner role id: customrole_my_runner/);
  });
});

describe("SUITESCRIPT_VERIFY_RUNNER_ID", () => {
  const key = "SUITESCRIPT_VERIFY_RUNNER_ID";
  const src = (project: string, file: string) =>
    join(project, "verification", "sdf", "src", file);
  const read = (project: string, file: string) =>
    readFileSync(src(project, file), "utf8");

  it("defaults to the runner ids, file, name and folder of suitescript_verify", () => {
    const project = fakeProject();
    assert.equal(cli(["deploy"], project).status, 0);
    const runner = read(
      project,
      "Objects/customscript_suitescript_verify_rl.xml",
    );
    assert.match(
      runner,
      /<restlet scriptid="customscript_suitescript_verify_rl">/,
    );
    assert.match(runner, /scriptid="customdeploy_suitescript_verify_rl"/);
    assert.match(runner, /<name>ssv runner suitescript_verify<\/name>/);
    assert.match(runner, /<title>ssv runner suitescript_verify<\/title>/);
    assert.match(
      runner,
      /<description>[^<]*suitescript-verify[^<]*<\/description>/,
    );
    assert.match(runner, /\[\/SuiteScripts\/suitescript-verify\/restlet\.js\]/);
    assert.ok(
      existsSync(
        src(project, "FileCabinet/SuiteScripts/suitescript-verify/restlet.js"),
      ),
    );
    assert.match(
      read(project, "deploy.xml"),
      /~\/FileCabinet\/SuiteScripts\/suitescript-verify\/\*/,
    );
  });

  it("names the runner, its deployment and its folder from the committed .env", () => {
    const project = fakeProject();
    write(project, "verification/.env", `${key}=my_project\n`);
    assert.equal(cli(["deploy"], project).status, 0);
    const runner = read(project, "Objects/customscript_my_project_rl.xml");
    assert.match(runner, /scriptid="customscript_my_project_rl"/);
    assert.match(runner, /scriptid="customdeploy_my_project_rl"/);
    assert.match(runner, /<name>ssv runner my_project<\/name>/);
    assert.match(runner, /\[\/SuiteScripts\/my-project\/restlet\.js\]/);
    assert.match(
      read(project, "deploy.xml"),
      /~\/FileCabinet\/SuiteScripts\/my-project\/\*/,
    );
    assert.ok(existsSync(src(project, "FileCabinet/SuiteScripts/my-project")));
    assert.equal(
      existsSync(
        src(project, "Objects/customscript_suitescript_verify_rl.xml"),
      ),
      false,
    );
  });

  it("replaces a runner generated under another id, and warns that the old one may still be deployed", () => {
    const project = fakeProject();
    write(project, "verification/.env", `${key}=old_one\n`);
    const first = cli(["deploy"], project);
    assert.equal(first.status, 0);
    assert.equal(first.stderr.includes("still be deployed"), false);
    write(project, "verification/.env", `${key}=new_one\n`);
    const second = cli(["deploy"], project);
    assert.equal(second.status, 0);
    assert.equal(
      existsSync(src(project, "Objects/customscript_old_one_rl.xml")),
      false,
    );
    assert.ok(existsSync(src(project, "Objects/customscript_new_one_rl.xml")));
    assert.equal(
      existsSync(src(project, "Objects/customscript_old_one_sl.xml")),
      false,
    );
    assert.ok(existsSync(src(project, "Objects/customscript_new_one_sl.xml")));
    assert.equal(second.stderr.match(/still be deployed/g)?.length, 1);
    assert.match(second.stderr, /old_one/);
    assert.match(second.stderr, /still be deployed/);
    assert.match(second.stderr, /cleanup/);
    assert.equal(cli(["deploy"], project).stderr.includes("old_one"), false);
  });

  for (const command of ["deploy", "cleanup"]) {
    it(`${command} removes a 1.x _runner object, even of the same id, and warns with its id`, () => {
      const project = fakeProject();
      write(project, "verification/.env", `${key}=my_project\n`);
      const legacy = "Objects/customscript_my_project_runner.xml";
      const other = "Objects/customscript_older_runner.xml";
      mkdirSync(src(project, "Objects"), { recursive: true });
      writeFileSync(src(project, legacy), "<restlet/>");
      writeFileSync(src(project, other), "<restlet/>");
      const result = cli([command], project);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(src(project, legacy)), false);
      assert.equal(existsSync(src(project, other)), false);
      assert.ok(
        existsSync(src(project, "Objects/customscript_my_project_rl.xml")),
      );
      assert.match(
        result.stderr,
        /"my_project"[^\n]*still be deployed[^\n]*1\.x/,
      );
      assert.match(result.stderr, /"older"[^\n]*still be deployed[^\n]*1\.x/);
      // 1.x cleanup cannot build this folder while it holds the 2.0 objects.
      assert.match(
        result.stderr,
        /first delete customrole_\*\.xml, customscript_\*_rl\.xml and customscript_\*_sl\.xml from [^\n]*Objects[^\n]*"Upgrading from 1\.x"/,
      );
      assert.equal(
        cli([command], project).stderr.includes("still be deployed"),
        false,
      );
    });
  }

  it("turns the named runner's deployment off in cleanup", () => {
    const project = fakeProject();
    write(project, "verification/.env", `${key}=my_project\n`);
    assert.equal(cli(["cleanup"], project).status, 0);
    assert.match(
      read(project, "Objects/customscript_my_project_rl.xml"),
      /<isdeployed>F<\/isdeployed>/,
    );
  });

  it("layers: the process environment wins over .env", () => {
    const project = fakeProject();
    write(project, "verification/.env", `${key}=from_file\n`);
    assert.equal(cli(["deploy"], project, { [key]: "from_env" }).status, 0);
    assert.ok(existsSync(src(project, "Objects/customscript_from_env_rl.xml")));
  });

  it("accepts 24 characters, and every generated id and name fits the platform's 40", () => {
    const project = fakeProject();
    const id = "a".repeat(24);
    write(project, "verification/.env", `${key}=${id}\n`);
    assert.equal(cli(["deploy"], project).status, 0);
    const script = "customscript_aaaaaaaaaaaaaaaaaaaaaaaa_rl";
    assert.equal(script.length, 40);
    const runner = read(project, `Objects/${script}.xml`);
    const values = [
      ...runner.matchAll(/scriptid="([^"]+)"|<(?:name|title)>([^<]+)</g),
    ].map((m) => m[1] ?? m[2] ?? "");
    assert.deepEqual(values.sort(), [
      "customdeploy_aaaaaaaaaaaaaaaaaaaaaaaa_rl",
      "customscript_aaaaaaaaaaaaaaaaaaaaaaaa_rl",
      "ssv runner aaaaaaaaaaaaaaaaaaaaaaaa",
      "ssv runner aaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    for (const value of values) assert.ok(value.length <= 40, value);
    const host = read(
      project,
      "Objects/customscript_aaaaaaaaaaaaaaaaaaaaaaaa_sl.xml",
    );
    const hostValues = [
      ...host.matchAll(/scriptid="([^"]+)"|<(?:name|title)>([^<]+)</g),
    ].map((m) => m[1] ?? m[2] ?? "");
    assert.deepEqual(hostValues.sort(), [
      "customdeploy_aaaaaaaaaaaaaaaaaaaaaaaa_sl",
      "customscript_aaaaaaaaaaaaaaaaaaaaaaaa_sl",
      "ssv suitelet aaaaaaaaaaaaaaaaaaaaaaaa",
      "ssv suitelet aaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    for (const value of hostValues) assert.ok(value.length <= 40, value);
  });

  for (const bad of ["Nope", "has-dash", "x".repeat(25), "1abc"]) {
    it(`refuses ${JSON.stringify(bad)} from the committed .env, naming the key and not the value`, () => {
      const project = fakeProject();
      write(project, "verification/.env", `${key}=${bad}\n`);
      const result = cli(["deploy"], project);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(key));
      assert.equal(result.stderr.includes(bad), false);
    });
  }

  it("refuses a bad value from the process environment too", () => {
    const project = fakeProject();
    const result = cli(["deploy"], project, { [key]: "Bad-Value" });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(key));
    assert.equal(result.stderr.includes("Bad-Value"), false);
  });

  it("doctor reports the runner id in use", () => {
    const project = fakeProject();
    write(project, "verification/.env", `${key}=my_project\n`);
    assert.match(cli(["doctor"], project).stdout, /Runner id: my_project/);
  });
});

describe("a project nested in a subfolder of a repository", () => {
  /**
   * A repository whose verification tooling is its own npm project in `tools/`
   * (its own `node_modules`, with the fake SuiteCloud CLI), as when the
   * repository root publishes a package of its own.
   */
  function nestedProject({ ignoreLocal = true } = {}) {
    const repo = fakeProject();
    const tools = join(repo, "tools");
    mkdirSync(tools, { recursive: true });
    cpSync(join(repo, "node_modules"), join(tools, "node_modules"), {
      recursive: true,
    });
    rmSync(join(repo, "node_modules"), { force: true, recursive: true });
    rmSync(join(repo, "verification"), { force: true, recursive: true });
    writeFileSync(join(tools, "package.json"), '{"private":true}');
    git(repo, ["init", "-q"]);
    if (ignoreLocal) write(repo, ".gitignore", ".env.local\n");
    return { repo, tools };
  }

  it("runs init, doctor and deploy from the subfolder with --dir .", () => {
    const { repo, tools } = nestedProject();
    const init = cli(["init", "--dir", ".", "--results-dir", "results"], tools);
    assert.equal(init.status, 0, init.stderr);
    for (const folder of ["probes", "results", "sdf"]) {
      assert.ok(existsSync(join(tools, folder)), folder);
    }
    assert.match(
      readFileSync(join(tools, ".env"), "utf8"),
      /SUITESCRIPT_VERIFY_RESULTS_DIR=results/,
    );

    const doctor = cli(["doctor", "--dir", "."], tools);
    assert.match(
      doctor.stdout,
      /ok {3}SuiteCloud CLI \(@oracle\/suitecloud-cli\) is installed/,
    );
    assert.equal(doctor.stdout.includes("not gitignored"), false);

    const deploy = cli(["deploy", "--dir", "."], tools);
    assert.equal(deploy.status, 0, deploy.stderr);
    assert.ok(existsSync(join(tools, "sdf", "src", "manifest.xml")));
    assert.equal(norm(calls(repo).cwd), norm(join(tools, "sdf")));
  });

  it("checks .env.local against the repository's .gitignore", () => {
    const { tools } = nestedProject({ ignoreLocal: false });
    write(tools, ".env.local", "SUITESCRIPT_VERIFY_ACCOUNT=1234567_SB1\n");
    const result = cli(["deploy", "--dir", "."], tools);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.env\.local is not gitignored/);
  });
});
