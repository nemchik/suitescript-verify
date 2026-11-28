import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "./config.ts";
import {
  clientAssertion,
  type KnownIds,
  restletUrl,
  scrub,
  tokenUrl,
} from "./netsuite.ts";
import {
  anchored,
  ceilingOf,
  differingPaths,
  isRestletHosted,
  isRunnable,
  isSlug,
  isSuitelet,
  listDifferences,
  listProbes,
  type Probe,
  read,
  readExpect,
  sortKeys,
  tagProblems,
} from "./probes.ts";
import {
  ownResponse,
  responseDifferences,
  withOwnResponse,
} from "./response.ts";
import { resultsDraft } from "./results.ts";
import {
  type Creds,
  positionals,
  requireResultsDir,
  requireSandbox,
  UsageError,
} from "./shared.ts";
import { governanceWarning, readUsage, type Usage } from "./usage.ts";

/** Every `--param name=value` in the arguments, in order. The value may start with anything. */
function suppliedParams(args: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--param") continue;
    const text = args[++i] ?? "";
    const at = text.indexOf("=");
    if (at < 1) {
      throw new UsageError(`--param needs name=value, got "${text}".`);
    }
    out.push([text.slice(0, at), text.slice(at + 1)]);
  }
  return out;
}

/**
 * Checks the supplied parameters against what the probe declares, before any
 * request. A value is only ever data: it goes into the JSON body, and the
 * runner passes it to the probe as a string, never evaluating it.
 */
function validateParams(probe: Probe, args: string[]): Record<string, string> {
  const problems = tagProblems(probe);
  if (problems.length > 0) {
    throw new UsageError(
      `${probe.slug} has invalid tags:\n${problems.map((m) => `- ${m}`).join("\n")}`,
    );
  }
  const supplied = suppliedParams(args);
  if (probe.params.length === 0) {
    if (supplied.length > 0) {
      throw new UsageError(
        `${probe.slug} takes no parameters; it declares no @param tags.`,
      );
    }
    return {};
  }
  const values = new Map<string, string>();
  for (const [name, value] of supplied) {
    if (!probe.params.some((param) => param.name === name)) {
      throw new UsageError(
        `Parameter "${name}" is not declared by ${probe.slug}. Declared: ${probe.params.map((p) => p.name).join(", ")}`,
      );
    }
    if (values.has(name)) {
      throw new UsageError(`Parameter "${name}" was given more than once.`);
    }
    values.set(name, value);
  }
  for (const { name, pattern } of probe.params) {
    const value = values.get(name);
    if (value === undefined) {
      throw new UsageError(
        `${probe.slug} needs --param ${name}=<value> matching ${pattern}`,
      );
    }
    if (!anchored(pattern).test(value)) {
      throw new UsageError(`Parameter "${name}" does not match ${pattern}`);
    }
  }
  return Object.fromEntries(
    probe.params.map(({ name }) => [name, values.get(name) ?? ""]),
  );
}

/** The configured ids the scrubber replaces with placeholders. */
export const knownIds = (creds: Creds): KnownIds => ({
  account: creds.account,
  certificateId: creds.certificateId,
  clientId: creds.clientId,
  sdfCertificateId: creds.sdfCertificateId,
});

/**
 * How many seconds the CLI waits past NetSuite's own limit for the probe's
 * script type, so that NetSuite's answer arrives and is reported instead of
 * the CLI giving up in the same instant: SSS_REQUEST_TIME_EXCEEDED from
 * requestSuitelet at about 45 seconds (seen in a sandbox). A RESTlet probe got
 * no answer within it in a sandbox at 2026.2 (still running at 331 seconds);
 * the grace stays so the CLI reports a RESTlet limit if NetSuite ever answers.
 */
export const graceSeconds = 15;

/** Whether a probe's limit is the most its script type allows, where NetSuite answers itself. */
const atCeiling = (probe: Probe) => probe.timeoutSeconds >= ceilingOf(probe);

/** How long the CLI waits for a probe, in seconds: its limit, plus the grace at its ceiling. */
export const secondsToWait = (probe: Probe) =>
  atCeiling(probe) ? probe.timeoutSeconds + graceSeconds : probe.timeoutSeconds;

/** What `run` says when the CLI stopped waiting for a probe. */
export const timedOutMessage = (probe: Probe) =>
  `${probe.slug} timed out after ${secondsToWait(probe)} seconds, so there is no result. It may still be running in NetSuite. ${
    atCeiling(probe)
      ? `Its limit is the most a ${isSuitelet(probe) ? "Suitelet" : isRestletHosted(probe) ? "RESTlet probe that declares a permission" : "RESTlet"} probe allows: split it, or narrow what it reads.`
      : `To give it more time, declare @timeout <seconds> (up to ${ceilingOf(probe)}) in its JSDoc block.`
  }`;

/** Raised when the runner did not answer within the probe's time limit. */
export class RunnerTimeout extends Error {}

let patient: object | undefined;

/**
 * A dispatcher for the runner call that never gives up waiting for headers or
 * body, built once. Node's global fetch (undici) does so after 300 seconds,
 * which would cut in before a RESTlet probe's ceiling (300, plus the grace);
 * the CLI's limit is the only one that applies. Node does
 * not expose undici's Agent, so this copies the global dispatcher's class,
 * which exists once the first fetch has run. A test fails if a Node release
 * removes it; undefined here would silently restore the 300-second cut-off.
 */
export function patientDispatcher(): object | undefined {
  if (patient) return patient;
  try {
    const global = (globalThis as Record<symbol, unknown>)[
      Symbol.for("undici.globalDispatcher.1")
    ] as { constructor: new (options: object) => object } | undefined;
    if (global) {
      patient = new global.constructor({ bodyTimeout: 0, headersTimeout: 0 });
    }
  } catch {
    // Leaves fetch's own default.
  }
  return patient;
}

/**
 * Gets a token with the runner's certificate (OAuth 2.0 client credentials)
 * and posts `body` to the deployed runner. Returns the runner's answer as text;
 * a failed token request, a failed call or a non-OK status is a UsageError
 * whose message is scrubbed of the configured ids. With `waitSeconds`, it
 * stops waiting for the runner after that long and throws a RunnerTimeout.
 */
export async function callRunner(
  creds: Creds,
  runnerId: string,
  body: unknown,
  waitSeconds?: number,
): Promise<string> {
  const safe = (text: string) => scrub(text, knownIds(creds)).text;
  const endpoint = tokenUrl(creds.account);
  const assertion = clientAssertion({
    certificateId: creds.certificateId,
    clientId: creds.clientId,
    privateKeyPem: readFileSync(creds.privateKeyPath, "utf8"),
    tokenEndpoint: endpoint,
  });
  try {
    const tokenResponse = await fetch(endpoint, {
      body: new URLSearchParams({
        client_assertion: assertion,
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        grant_type: "client_credentials",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const tokenBody = (await tokenResponse.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!tokenResponse.ok || !tokenBody.access_token) {
      throw new UsageError(
        safe(
          `Token request failed: HTTP ${tokenResponse.status} ${tokenBody.error ?? ""} ${tokenBody.error_description ?? ""}`.trim(),
        ),
      );
    }
    const dispatcher = patientDispatcher();
    const response = await fetch(restletUrl(creds.account, runnerId), {
      body: JSON.stringify(body),
      // biome-ignore lint/suspicious/noExplicitAny: undici's Dispatcher type is not exposed by Node
      ...(dispatcher ? ({ dispatcher } as any) : {}),
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      method: "POST",
      ...(waitSeconds === undefined
        ? {}
        : {
            signal: AbortSignal.timeout(waitSeconds * 1000),
          }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new UsageError(
        `The runner call failed: HTTP ${response.status}
${safe(text.slice(0, 500))}`,
      );
    }
    return text;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    if ((error as Error).name === "TimeoutError") throw new RunnerTimeout();
    throw new UsageError(
      safe(`The request failed: ${(error as Error).message}`),
    );
  }
}

/**
 * Runs one probe, by name from the fixed list in the probes folder, through
 * the deployed runner. Nothing from a request or an argument is ever run as
 * code: the runner only knows the probes generated into it by `deploy`.
 */
export async function runProbe(
  project: string,
  config: Config,
  args: string[],
): Promise<number> {
  // A missing results key is the project's own layout choice: report it before the credentials.
  const resultsDir = args.includes("--draft")
    ? requireResultsDir(config)
    : undefined;
  const creds = requireSandbox(config);
  const name = positionals(args)[0] ?? "";
  const probes = listProbes(config.probesDir, config.extraTags);
  const probe = isSlug(name)
    ? probes.find((candidate) => candidate.slug === name)
    : undefined;
  if (!probe) {
    throw new UsageError(
      `Unknown probe "${name}". Known: ${probes.map((p) => p.slug).join(", ") || "(none)"}`,
    );
  }
  if (!isRunnable(probe)) {
    throw new UsageError(
      `${probe.slug} needs a ${probe.scriptType || "(undeclared)"} script. The runner only runs RESTlet and Suitelet probes (declare @scriptType Restlet or @scriptType Suitelet); ask the user to run it by hand in a sandbox console.`,
    );
  }
  const params = validateParams(probe, args);
  if (!existsSync(creds.privateKeyPath)) {
    throw new UsageError("The runner private key file does not exist.");
  }
  const known = knownIds(creds);

  let text: string;
  try {
    text = await callRunner(
      creds,
      config.runnerId,
      probe.params.length > 0
        ? { params, probe: probe.slug }
        : { probe: probe.slug },
      secondsToWait(probe),
    );
  } catch (error) {
    if (!(error instanceof RunnerTimeout)) throw error;
    throw new UsageError(timedOutMessage(probe));
  }

  const scrubbed = scrub(withOwnResponse(text), known);
  if (scrubbed.problems.length > 0) {
    throw new UsageError(
      `Refusing to print or record the output: ${scrubbed.problems.join("; ")}. Review it by hand.`,
    );
  }
  let body: {
    error?: string;
    permissions?: Record<string, string>;
    response?: unknown;
    result?: unknown;
    usage?: unknown;
    version?: string;
  };
  try {
    body = JSON.parse(scrubbed.text);
  } catch {
    throw new UsageError("The runner's answer was not JSON.");
  }
  const usage: Usage | undefined = readUsage(body.usage);
  if (body.error) {
    // The usage and any governance warning go beside the error, already scrubbed with the rest.
    const warning = governanceWarning(usage);
    throw new UsageError(
      [
        `The runner reported an error: ${body.error}`,
        ...(usage ? [`Usage: ${JSON.stringify(usage)}`] : []),
        ...(warning ? [warning] : []),
      ].join("\n"),
    );
  }
  if (usage) body.usage = usage;
  else delete body.usage;
  // A Suitelet probe that wrote its own response is reported as that response, not a result.
  const own = "response" in body ? ownResponse(body.response) : undefined;
  if (own) body.response = own;
  // Sorted as an expectation is written, so the printed output can be copied as one.
  console.log(JSON.stringify(sortKeys(body), null, 2));
  const warning = governanceWarning(usage);
  if (warning) console.log(`\n${warning}`);

  let status = 0;
  const expected = readExpect(probe.slug, config.probesDir);
  if (expected !== undefined) {
    const differences = own
      ? responseDifferences(own, expected)
      : differingPaths(body.result, expected, "result");
    if (differences.length === 0) {
      console.log("\nMatches the expected output.");
    } else {
      status = 2;
      console.log(
        `\nDRIFT: the output differs from ${probe.slug}.expect.json at ${listDifferences(differences)}. The platform changed, or the expectation is wrong.`,
      );
    }
  }

  if (resultsDir !== undefined) {
    const probeFile = join(config.probesDir, `${probe.slug}.js`);
    const page = join(resultsDir, `${probe.slug}.md`);
    const shown = relative(project, page).replaceAll("\\", "/");
    if (existsSync(page)) {
      console.log(`\n${shown} already exists; not overwriting.`);
    } else {
      const draft = scrub(
        resultsDraft({
          date: new Date().toISOString().slice(0, 10),
          output: sortKeys(own ?? body.result),
          permissions: body.permissions,
          probe,
          probeFile,
          resultsDir,
          scriptSource: read(probeFile),
          usage: usage,
          version: body.version ?? "unknown",
        }),
        known,
      );
      if (draft.problems.length > 0) {
        throw new UsageError(
          `Refusing to write ${shown}: ${draft.problems.join("; ")}. Review it by hand.`,
        );
      }
      writeFileSync(page, draft.text);
      console.log(
        `\nWrote the draft ${shown}. Fill in each TODO(verify), then ask the user to review it.`,
      );
    }
  }
  return status;
}
