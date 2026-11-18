import { isDeepStrictEqual } from "node:util";

/**
 * The response a Suitelet probe wrote itself, as the runner reports it. The
 * runner already keeps only the headers safe to commit, collapses their
 * casings, redacts cookies and credential-like values, drops NetSuite's
 * HTML trailer and cuts the body inside the account; the CLI applies the same
 * value rules again, so a runner from another version cannot leak a session
 * cookie, a credential-like header or the trailer's account and email, or
 * flood the output.
 */
export interface OwnResponse {
  body: string;
  headers: Record<string, unknown>;
  status: unknown;
  truncated?: true;
}

/** The longest body reported, in characters. */
export const BODY_LIMIT = 64 * 1024;

/** The host's own headers (its X-SSV-Mode marker and X-SSV-Headers list), never reported. */
const RESERVED = /^x-ssv-/;

/** A header whose name looks like a credential: its value is reported as `<redacted>` (by lowercase name). */
const CREDENTIAL =
  /^(authorization|proxy-authorization|cookie)$|token|secret|session|password|auth|key|csrf|sign|hmac|credential|nonce|jwt/;

const redactCookie = (cookie: string) => {
  const name = (cookie.split("=")[0] ?? "").trim();
  return name.startsWith("sv_") ? cookie : `${name}=<redacted>`;
};

/** A Set-Cookie header with every value redacted but the probe's own `sv_*` cookies; a comma inside Expires is not a join. */
const redactSetCookie = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map((cookie) => redactCookie(String(cookie)))
    : String(value)
        .split(/,(?=\s*[^;,=\s]+=)/)
        .map((cookie) => redactCookie(cookie.trim()))
        .join(", ");

/** A Content-Disposition with its `filename` and `filename*` values redacted: a file name can name a record or a customer. */
const redactFileName = (value: unknown) =>
  String(value).replace(
    /(\bfilename\*?\s*=\s*)("(?:[^"\\]|\\.)*"|[^;]*)/gi,
    "$1<redacted>",
  );

/** A header value as it may be committed: cookies but `sv_*`, credential-like values and file names redacted. */
const safeValue = (name: string, value: unknown): unknown =>
  name === "set-cookie"
    ? redactSetCookie(value)
    : name === "content-disposition"
      ? redactFileName(value)
      : CREDENTIAL.test(name)
        ? "<redacted>"
        : value;

/**
 * One lowercase key per header name, as the runner reports them:
 * `ClientResponse.headers` holds several casings of each (the runner has
 * already kept only the platform's content headers and laid the probe's own
 * headers from X-SSV-Headers over them). The CLI cannot tell the two apart, so
 * it applies the rules that hold for both: values are made safe, then
 * repeated ones dropped; a name left with one value keeps it,
 * and one with several keeps them as a list.
 */
const collapseHeaders = (given: object): Record<string, unknown> => {
  const values = new Map<string, unknown[]>();
  for (const [key, header] of Object.entries(given)) {
    const name = key.toLowerCase();
    if (RESERVED.test(name)) continue;
    const list = values.get(name) ?? [];
    for (const value of ([] as unknown[]).concat(header)) {
      const shown = safeValue(name, value);
      if (!list.some((known) => isDeepStrictEqual(known, shown))) {
        list.push(shown);
      }
    }
    values.set(name, list);
  }
  return Object.fromEntries(
    [...values].map(([name, list]) => [
      name,
      list.length === 1 ? list[0] : list,
    ]),
  );
};

/** An HTML body without the `<!-- … -->` comments NetSuite appends to every page (they name the account and the user). */
const stripTrailer = (headers: Record<string, unknown>, text: string) => {
  const type = String(([] as unknown[]).concat(headers["content-type"])[0]);
  if (!/^\s*text\/html\b/i.test(type)) return text;
  let body = text;
  let stripped = false;
  for (;;) {
    const trimmed = body.trimEnd();
    const start = trimmed.lastIndexOf("<!--");
    if (!trimmed.endsWith("-->") || start < 0) break;
    body = trimmed.slice(0, start);
    stripped = true;
  }
  return stripped ? body.trimEnd() : text;
};

/** The probe's own response with one key per header, cookies and credential-like values redacted, NetSuite's HTML trailer dropped and the body cut, or undefined when the value is not one. */
export function ownResponse(value: unknown): OwnResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const headers = collapseHeaders(
    raw.headers && typeof raw.headers === "object" ? raw.headers : {},
  );
  const text = stripTrailer(
    headers,
    typeof raw.body === "string" ? raw.body : String(raw.body ?? ""),
  );
  const response: OwnResponse = {
    body: text.slice(0, BODY_LIMIT),
    headers,
    status: raw.status,
  };
  if (raw.truncated === true || text.length > BODY_LIMIT) {
    response.truncated = true;
  }
  return response;
}

/**
 * The runner's answer text with its own response, if it holds one, put through
 * the rules above before the scrubber reads it, so NetSuite's HTML trailer
 * from a runner that kept it cannot block or reach the output.
 */
export function withOwnResponse(text: string): string {
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return text;
  }
  if (!answer || typeof answer !== "object" || !("response" in answer)) {
    return text;
  }
  const own = ownResponse(answer.response);
  return own ? JSON.stringify({ ...answer, response: own }) : text;
}

/** What an expected output is compared on: header names lowercased. */
const comparable = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { headers, ...rest } = value as Record<string, unknown>;
  const kept = Object.entries(
    headers && typeof headers === "object" ? headers : {},
  ).map(([name, header]) => [name.toLowerCase(), header] as const);
  return { ...rest, headers: Object.fromEntries(kept) };
};

/** Whether a probe's own response matches its expected output. */
export const matchesExpectedResponse = (
  response: OwnResponse,
  expected: unknown,
) => isDeepStrictEqual(comparable(response), comparable(expected));
