// Preloaded into the CLI under test (NODE_OPTIONS=--import): stdin becomes a
// terminal that types the answers in FAKE_TERMINAL_ANSWERS (a JSON array of
// strings), one each time the CLI starts reading, so a test can drive the
// prompts a person answers. Raw mode, which hidden input turns on, is stubbed;
// in raw mode the answer ends with "\r", as a real terminal sends for Enter.
// When the answers run out, stdin ends. With FAKE_TERMINAL_LOG set, each answer
// typed is logged as a JSON line saying whether raw mode was on, so a test can
// tell a hidden prompt from an echoed one without the log holding the answer.
import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";

const answers = JSON.parse(process.env.FAKE_TERMINAL_ANSWERS ?? "[]");
const log = process.env.FAKE_TERMINAL_LOG;

const stdin = new Readable({ read() {} });
stdin.isTTY = true;
stdin.isRaw = false;
stdin.fd = 0;
stdin.setRawMode = (mode) => {
  stdin.isRaw = Boolean(mode);
  return stdin;
};
stdin.ref = () => stdin;
stdin.unref = () => stdin;

// One answer per read: readline resumes stdin when it starts reading and
// pauses it when closed, so a prompt never sees the next prompt's answer.
stdin.on("resume", () => {
  if (answers.length === 0) {
    stdin.push(null);
    return;
  }
  const answer = String(answers.shift());
  if (log) {
    appendFileSync(log, `${JSON.stringify({ raw: stdin.isRaw })}\n`);
  }
  stdin.push(`${answer}${stdin.isRaw ? "\r" : "\n"}`);
});

Object.defineProperty(process, "stdin", {
  configurable: true,
  enumerable: true,
  get: () => stdin,
});
