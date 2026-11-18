import { readFileSync } from "node:fs";

/** The version of the running package, baked into the scripts so the self-check can report it. */
export const packageVersion = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
