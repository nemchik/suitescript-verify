import { createPrivateKey, sign } from "node:crypto";

export const runnerScriptId = "customscript_suitescript_verify_runner";
export const runnerDeployId = "customdeploy_suitescript_verify_runner";
export const fileCabinetFolder = "suitescript-verify";

const host = (account: string) =>
  account.trim().toLowerCase().replace(/_/g, "-");

export const tokenUrl = (account: string) =>
  `https://${host(account)}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;

export const restletUrl = (account: string) =>
  `https://${host(account)}.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${runnerScriptId}&deploy=${runnerDeployId}`;

const base64url = (data: Buffer | string) =>
  Buffer.from(data).toString("base64url");

/** The signed JWT NetSuite's OAuth 2.0 client credentials flow expects: ES256 with an EC P-256 key. */
export function clientAssertion(options: {
  certificateId: string;
  clientId: string;
  now?: number;
  privateKeyPem: string;
  tokenEndpoint: string;
}): string {
  const key = createPrivateKey(options.privateKeyPem);
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
    throw new Error(
      "The runner private key must be an EC P-256 key (ES256). Generate one with `suitescript-verify certificate`.",
    );
  }
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const header = { alg: "ES256", kid: options.certificateId, typ: "JWT" };
  const claims = {
    aud: options.tokenEndpoint,
    exp: iat + 55 * 60,
    iat,
    iss: options.clientId,
    scope: "restlets",
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(input), {
    dsaEncoding: "ieee-p1363",
    key,
  });
  return `${input}.${base64url(signature)}`;
}

const identifierPatterns: Array<[string, RegExp]> = [
  ["an account number", /\b\d{5,8}[_-](?:SB|RP|TSTDRV)\w*\b/i],
  ["an account number", /\bTSTDRV\d+\b/i],
  ["a NetSuite host", /[a-z0-9-]+\.[a-z0-9.-]*netsuite\.com/i],
  ["a JWT", /\beyJ[\w-]{10,}\.[\w-]{10,}\./],
  ["a long hex token", /\b[a-f0-9]{40,}\b/i],
  ["a PEM block", /-----BEGIN [A-Z ]+-----/],
  ["an email address", /[\w.+-]+@[\w-]+\.[\w.-]+/],
];

export interface KnownIds {
  account?: string;
  certificateId?: string;
  clientId?: string;
  sdfCertificateId?: string;
}

/**
 * Replaces the configured account, client and certificate ids with
 * placeholders, then reports anything that still looks like an identifier.
 * Callers fail closed: they print or write nothing when `problems` is not empty.
 */
export function scrub(
  text: string,
  known: KnownIds,
): { problems: string[]; text: string } {
  let out = text;
  const replacements: Array<[string | undefined, string]> = [
    [known.account, "<ACCOUNT>"],
    [known.clientId, "<CLIENT-ID>"],
    [known.certificateId, "<CERTIFICATE-ID>"],
    [known.sdfCertificateId, "<SDF-CERTIFICATE-ID>"],
  ];
  for (const [value, placeholder] of replacements) {
    if (value && value.length >= 4) {
      out = out.split(value).join(placeholder);
      out = out.split(value.toLowerCase()).join(placeholder);
      out = out.split(value.replace(/_/g, "-").toLowerCase()).join(placeholder);
    }
  }
  const problems = identifierPatterns
    .filter(([, pattern]) => pattern.test(out))
    .map(([label]) => `the output looks like it contains ${label}`);
  return { problems: [...new Set(problems)], text: out };
}
