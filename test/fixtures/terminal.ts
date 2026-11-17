import { join } from "node:path";
import { pathToFileURL } from "node:url";

const preload = pathToFileURL(
  join(import.meta.dirname, "fake-terminal.mjs"),
).href;

/**
 * The environment that puts the CLI under test at a fake terminal, which types
 * `answers` in order, one per prompt (see fake-terminal.mjs). Merges into `env`,
 * keeping any preload it already sets, such as the fake NetSuite. With `log`,
 * the fixture records whether each answer was typed in raw mode.
 */
export function fakeTerminal(
  answers: string[],
  env: Record<string, string> = {},
  log?: string,
): Record<string, string> {
  return {
    ...env,
    FAKE_TERMINAL_ANSWERS: JSON.stringify(answers),
    ...(log === undefined ? {} : { FAKE_TERMINAL_LOG: log }),
    NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${preload}`]
      .filter(Boolean)
      .join(" "),
  };
}
