// Preloaded into the CLI under test (NODE_OPTIONS=--import): replaces fetch with
// canned NetSuite answers, so no test reaches a network or an account.
import { appendFileSync, readFileSync } from "node:fs";

const script = JSON.parse(
  readFileSync(process.env.FAKE_NETSUITE_SCRIPT, "utf8"),
);

globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? String(init.body) : "";
  appendFileSync(
    process.env.FAKE_NETSUITE_LOG,
    `${JSON.stringify({ body, headers: init.headers, url: String(url) })}\n`,
  );
  const answer = String(url).includes("/oauth2/v1/token")
    ? script.token
    : script.restlet;
  return new Response(
    typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
    { status: answer.status },
  );
};
