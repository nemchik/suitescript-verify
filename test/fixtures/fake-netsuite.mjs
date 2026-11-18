// Preloaded into the CLI under test (NODE_OPTIONS=--import): replaces fetch with
// canned NetSuite answers, so no test reaches a network or an account. With no
// FAKE_NETSUITE_SCRIPT (or a missing file), every call fails as an unreachable
// host would. The script is read on every call, so a fake deploy in the same
// run can change what the runner answers.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const unreachable = { body: "no fake answer", status: 599 };
const answers = () => {
  const file = process.env.FAKE_NETSUITE_SCRIPT;
  return file && existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { restlet: unreachable, token: unreachable };
};

globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? String(init.body) : "";
  if (process.env.FAKE_NETSUITE_LOG) {
    appendFileSync(
      process.env.FAKE_NETSUITE_LOG,
      `${JSON.stringify({ body, headers: init.headers, url: String(url) })}\n`,
    );
  }
  const script = answers();
  const answer = String(url).includes("/oauth2/v1/token")
    ? script.token
    : script.restlet;
  return new Response(
    typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
    { status: answer.status },
  );
};
