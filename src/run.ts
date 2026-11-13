import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "./config.ts";
import { clientAssertion, restletUrl, scrub, tokenUrl } from "./netsuite.ts";
import {
  isRestlet,
  isSlug,
  listProbes,
  matchesExpect,
  read,
  readExpect,
} from "./probes.ts";
import { resultsDraft } from "./results.ts";
import { positionals, requireSandbox, UsageError } from "./shared.ts";

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
  const creds = requireSandbox(config);
  const name = positionals(args)[0] ?? "";
  const probes = listProbes(config.probesDir);
  const probe = isSlug(name)
    ? probes.find((candidate) => candidate.slug === name)
    : undefined;
  if (!probe) {
    throw new UsageError(
      `Unknown probe "${name}". Known: ${probes.map((p) => p.slug).join(", ") || "(none)"}`,
    );
  }
  if (!isRestlet(probe)) {
    throw new UsageError(
      `${probe.slug} needs a ${probe.scriptType || "(undeclared)"} script. The runner only runs RESTlet probes (declare @scriptType Restlet); ask the user to run it by hand (docs/verification/README.md).`,
    );
  }
  if (probe.writes) {
    throw new UsageError(
      `${probe.slug} declares @writes, which needs the user's separate approval. That path is not automated.`,
    );
  }
  if (!existsSync(creds.privateKeyPath)) {
    throw new UsageError("The runner private key file does not exist.");
  }
  const known = {
    account: creds.account,
    certificateId: creds.certificateId,
    clientId: creds.clientId,
    sdfCertificateId: creds.sdfCertificateId,
  };
  const safe = (text: string) => scrub(text, known).text;

  const endpoint = tokenUrl(creds.account);
  const assertion = clientAssertion({
    certificateId: creds.certificateId,
    clientId: creds.clientId,
    privateKeyPem: readFileSync(creds.privateKeyPath, "utf8"),
    tokenEndpoint: endpoint,
  });
  let text: string;
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
    const response = await fetch(restletUrl(creds.account), {
      body: JSON.stringify({ probe: probe.slug }),
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    text = await response.text();
    if (!response.ok) {
      throw new UsageError(
        `The runner call failed: HTTP ${response.status}\n${safe(text.slice(0, 500))}`,
      );
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      safe(`The request failed: ${(error as Error).message}`),
    );
  }

  const scrubbed = scrub(text, known);
  if (scrubbed.problems.length > 0) {
    throw new UsageError(
      `Refusing to print or record the output: ${scrubbed.problems.join("; ")}. Review it by hand.`,
    );
  }
  let body: { error?: string; result?: unknown; version?: string };
  try {
    body = JSON.parse(scrubbed.text);
  } catch {
    throw new UsageError("The runner's answer was not JSON.");
  }
  if (body.error) throw new UsageError(`The runner refused: ${body.error}`);
  console.log(JSON.stringify(body, null, 2));

  let status = 0;
  const expected = readExpect(probe.slug, config.probesDir);
  if (expected !== undefined) {
    if (matchesExpect(body.result, expected)) {
      console.log("\nMatches the expected output.");
    } else {
      status = 2;
      console.log(
        `\nDRIFT: the output differs from ${probe.slug}.expect.json. The platform changed, or the expectation is wrong.`,
      );
    }
  }

  if (args.includes("--draft")) {
    const probeFile = join(config.probesDir, `${probe.slug}.js`);
    const page = join(config.resultsDir, `${probe.slug}.md`);
    const shown = relative(project, page).replaceAll("\\", "/");
    if (existsSync(page)) {
      console.log(`\n${shown} already exists; not overwriting.`);
    } else {
      const draft = scrub(
        resultsDraft({
          date: new Date().toISOString().slice(0, 10),
          output: body.result,
          probe,
          probeFile,
          resultsDir: config.resultsDir,
          scriptSource: read(probeFile),
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
