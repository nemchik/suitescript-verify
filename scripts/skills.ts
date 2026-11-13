// Runs the pinned `skills` CLI with the settings that make its results the same on every machine.
//
// `skills-lock.json` records a hash of each skill's files. The CLI clones the source with git and hashes the
// working tree, so a clone with `core.autocrlf=true` (the Windows default) has CRLF endings and a different
// hash from CI's LF clone: every skill then reads as outdated. Forcing `core.autocrlf=false` for the CLI's git
// calls (through git's environment config, which leaves your own git config alone) makes the hashes agree.
//
// `AI_AGENT` is set only when nothing else names an agent. With none detected, the CLI targets every supported
// agent and writes a second copy of each skill to `agent/skills/` (pull request #107).
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const cli = join(
  import.meta.dirname,
  "..",
  "node_modules",
  "skills",
  "bin",
  "cli.mjs",
);

// Append to any config the environment already passes to git instead of replacing it.
const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
const env = {
  ...process.env,
  GIT_CONFIG_COUNT: String(count + 1),
  [`GIT_CONFIG_KEY_${count}`]: "core.autocrlf",
  [`GIT_CONFIG_VALUE_${count}`]: "false",
  AI_AGENT: process.env.AI_AGENT ?? "claude",
};

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
