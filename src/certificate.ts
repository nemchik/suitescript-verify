import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "./config.ts";
import { names } from "./doctor.ts";
import { allowReplace, flagValue, saveEnv, UsageError } from "./shared.ts";

/** Oracle's documented `openssl` commands: ES256 (EC P-256) and RSA-PSS (RSA-4096, PS256). */
function generatePair(options: {
  kind: "ec" | "rsa";
  openssl: string;
  privateKey: string;
  publicKey: string;
}) {
  const keyArgs =
    options.kind === "ec"
      ? [
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-pkeyopt",
          "ec_param_enc:named_curve",
        ]
      : [
          "-newkey",
          "rsa:4096",
          "-sigopt",
          "rsa_padding_mode:pss",
          "-sha256",
          "-sigopt",
          "rsa_pss_saltlen:64",
        ];
  const result = spawnSync(
    options.openssl,
    [
      "req",
      "-new",
      "-x509",
      ...keyArgs,
      "-nodes",
      "-days",
      "365",
      "-subj",
      "/CN=suitescript-verify",
      "-out",
      options.publicKey,
      "-keyout",
      options.privateKey,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new UsageError("openssl failed to generate the key pair.");
  }
  try {
    chmodSync(options.privateKey, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
  if (process.platform === "win32" && process.env.USERNAME) {
    spawnSync("icacls", [
      options.privateKey,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERNAME}:F`,
    ]);
  }
}

/** Generates the runner (EC P-256) and SDF (RSA-4096) key pairs outside the project and saves their paths in .env.local. */
export async function certificate(
  project: string,
  config: Config,
  args: string[],
) {
  const dir = resolve(
    flagValue(args, "--keys-dir") ?? join(homedir(), ".suitescript-verify"),
  );
  const rel = relative(project, dir);
  if (rel === "" || !(rel.startsWith("..") || isAbsolute(rel))) {
    throw new UsageError("Choose a --keys-dir outside the project.");
  }
  const openssl = [
    "openssl",
    ...(process.platform === "win32"
      ? ["C:\\Program Files\\Git\\usr\\bin\\openssl.exe"]
      : []),
  ].find(
    (candidate) =>
      spawnSync(candidate, ["version"], { encoding: "utf8" }).status === 0,
  );
  if (!openssl) {
    throw new UsageError(
      "openssl was not found. Generate the key pairs by hand with Oracle's documented openssl commands.",
    );
  }
  // The runner token is signed here (ES256, EC P-256). Oracle's SDK signs the
  // SDF login with PS256 and an RSA key only, so that pair is RSA-4096.
  const kinds = { runner: "ec", sdf: "rsa" } as const;
  const only = flagValue(args, "--only");
  if (only !== undefined && only !== "runner" && only !== "sdf") {
    throw new UsageError("--only takes runner or sdf.");
  }
  const which = (["runner", "sdf"] as const).filter(
    (name) => only === undefined || only === name,
  );
  const paths = (name: string) => ({
    privateKey: join(dir, `${name}-private.pem`),
    publicKey: join(dir, `${name}-public.pem`),
  });
  mkdirSync(dir, { mode: 0o700, recursive: true });
  for (const name of which) {
    const pair = paths(name);
    const exists = existsSync(pair.privateKey) || existsSync(pair.publicKey);
    const mapped =
      config.values[
        name === "runner" ? names.certificateId : names.sdfCertificateId
      ];
    if (exists && mapped) {
      console.log(
        `Warning: a ${name} certificate id is already saved. A mapping cannot be recreated with the same certificate, and replacing this pair makes that mapping unusable (its private key is lost).`,
      );
    }
    if (!exists || (await allowReplace(args, `The ${name} key pair`))) {
      generatePair({ kind: kinds[name], openssl, ...pair });
      console.log(
        `Generated the ${name} key pair (${kinds[name] === "ec" ? "EC P-256" : "RSA-4096, RSA-PSS certificate"}, valid for 365 days).`,
      );
    } else console.log(`Kept the existing ${name} key pair.`);
  }
  await saveEnv(config, args, {
    ...(which.includes("runner")
      ? { [names.privateKeyPath]: paths("runner").privateKey }
      : {}),
    ...(which.includes("sdf")
      ? { [names.sdfPrivateKeyPath]: paths("sdf").privateKey }
      : {}),
  });
  console.log(
    [
      "",
      "Upload these public certificates in your sandbox (Setup > Integration > Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup):",
      ...which.map((name) => `  ${name}: ${paths(name).publicKey}`),
    ].join("\n"),
  );
}
