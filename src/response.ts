import { isDeepStrictEqual } from "node:util";

/**
 * The response a Suitelet probe wrote itself, as the runner reports it. The
 * runner already redacts cookies and cuts the body inside the account; the CLI
 * applies the same rules again, so a runner from another version cannot leak
 * a session cookie or flood the output.
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
export const CHANGING_HEADERS = ["date"];

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

/** The probe's own response with cookies redacted and the body cut, or undefined when the value is not one. */
export function ownResponse(value: unknown): OwnResponse | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const headers: Record<string, unknown> = {};
  const given =
    raw.headers && typeof raw.headers === "object" ? raw.headers : {};
  for (const [name, header] of Object.entries(given)) {
    headers[name] =
      name.toLowerCase() === "set-cookie" ? redactSetCookie(header) : header;
  }
  const text = typeof raw.body === "string" ? raw.body : String(raw.body ?? "");
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
