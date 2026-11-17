import { isDeepStrictEqual } from "node:util";

/**
 * The response a Suitelet probe wrote itself, as the runner reports it. The
 * runner already collapses header casings, redacts cookies, drops NetSuite's
 * HTML trailer and cuts the body inside the account; the CLI applies the same
 * rules again, so a runner from another version cannot leak a session cookie
 * or the trailer's account and email, or flood the output.
 */
export interface OwnResponse {
  body: string;
  headers: Record<string, unknown>;
  status: unknown;
  truncated?: true;
}

/** The longest body reported, in characters. */
export const BODY_LIMIT = 64 * 1024;

/** Headers that change on every call, left out when comparing with an expected output (by lowercase name). */
export const CHANGING_HEADERS = [
  "akamai-grn",
  "date",
  "via",
  "x-cache",
  "x-n-operationid",
];

/** The host's marker header, never reported. */
const MARKER = "x-ssv-mode";

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

/**
 * One lowercase key per header name, as the runner reports them:
 * `ClientResponse.headers` holds several casings of each. Cookies are
 * redacted, then repeated values dropped; a name left with one value keeps it,
 * and one with several keeps them as a list.
 */
const collapseHeaders = (given: object): Record<string, unknown> => {
  const values = new Map<string, unknown[]>();
  for (const [key, header] of Object.entries(given)) {
    const name = key.toLowerCase();
    if (name === MARKER) continue;
    const list = values.get(name) ?? [];
    for (const value of ([] as unknown[]).concat(header)) {
      const shown = name === "set-cookie" ? redactSetCookie(value) : value;
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

/** The probe's own response with one key per header, cookies redacted, NetSuite's HTML trailer dropped and the body cut, or undefined when the value is not one. */
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

/** What an expected output is compared on: header names lowercased, and the headers that change on every call left out. */
const comparable = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { headers, ...rest } = value as Record<string, unknown>;
  const kept = Object.entries(
    headers && typeof headers === "object" ? headers : {},
  )
    .map(([name, header]) => [name.toLowerCase(), header] as const)
    .filter(([name]) => !CHANGING_HEADERS.includes(name));
  return { ...rest, headers: Object.fromEntries(kept) };
};

/** Whether a probe's own response matches its expected output. */
export const matchesExpectedResponse = (
  response: OwnResponse,
  expected: unknown,
) => isDeepStrictEqual(comparable(response), comparable(expected));
