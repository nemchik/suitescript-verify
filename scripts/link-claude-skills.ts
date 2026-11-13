// Claude Code reads `.claude/skills/`, while the skills are installed universally into `.agents/skills/`.
// `skills experimental_install` restores only `.agents/skills/` and creates no agent links, so link each
// skill into `.claude/skills/` the way `skills add -a claude-code` does (junctions on Windows, symlinks
// elsewhere). `.claude/skills/` is gitignored: the links are local and rebuilt by `npm run skills:install`.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, relative } from "node:path";

const source = join(".agents", "skills");
const target = join(".claude", "skills");

if (!existsSync(source)) {
  console.error(`${source} is missing; run \`npm run skills:install\` first.`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });

for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const link = join(target, entry.name);
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    unlinkSync(link);
  } else if (existing) {
    console.error(`${link} exists and is not a link; remove it and run again.`);
    process.exit(1);
  }
  const destination = join(source, entry.name);
  // Junctions need an absolute target on Windows; symlinks elsewhere stay relative so they survive a move.
  if (process.platform === "win32") {
    symlinkSync(join(process.cwd(), destination), link, "junction");
  } else {
    symlinkSync(relative(target, destination), link, "dir");
  }
}

console.log(`Linked ${source} into ${target}.`);
