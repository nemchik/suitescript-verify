# Workflow

The flow is grill, spec, tickets, implement, review, retro. `/ask-matt` is the full router and the authority on every branch; this page holds only what it does not: this repo's state-of-issue table and a guard rail per step. It carries no copy of the router.

## "Let's address issue N"

Read the issue, pick the step from what the tracker shows, tell the user which step that is, and **recommend the next slash command when the step ends**, naming the exact text to type. Do not start a step the user has not chosen, and do not do another step's work. Small, decided work goes to `/implement` in the same window; multi-session work goes to `/to-spec` or `/to-tickets`.

| State of issue N                                | Step to recommend                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| No decisions recorded, or open design questions | `/grill-with-docs` (or `/wayfinder` when it is too big)                                               |
| Decided, and small                              | `/implement`                                                                                          |
| Decided, multi-session, no spec                 | `/to-spec` (or `/to-tickets` straight from the thread)                                                |
| A spec exists, no tickets                       | `/to-tickets`                                                                                         |
| Tickets exist and an unblocked one is open      | `/implement` (one ticket) or `/implement-spec` (the whole graph)                                      |
| Committed and reviewed, no PR yet               | Ask the agent to push the branch and open a PR that closes N (it loads `pr` for the body), then merge |
| An open PR closes it                            | `/code-review`, then merge                                                                            |
| Merged                                          | `/retro` if the session was rough                                                                     |
| A wayfinder map with open frontier tickets      | `/wayfinder #<map>`                                                                                   |
| A wayfinder map with no tickets left            | `/to-spec #<map>`                                                                                     |

A later step entered early (for example `/implement` with no spec or tickets) first checks whether the earlier steps happened or whether the issue already holds enough to proceed, and says which. If not, it recommends the missing step before doing anything else.

## Fixing what a maintainer's change broke

Treat a committed or staged maintainer change as a fence: learn why it stands before a fix removes it. Read its commit message and linked issue; when they do not say, ask the maintainer in one question before editing, and present the fix only after the answer. A rule that bars the agent from an act (such as accepting a license) binds the agent alone; whether CI or a human may do it is the maintainer's call, recorded in an ADR.

## Which skills to recommend and which to load

- **User-invoked** (only the user can start them, so recommend the slash command and stop): `/grill-with-docs`, `/grill-me`, `/to-spec`, `/to-tickets`, `/implement`, `/implement-spec`, `/wayfinder`, `/retro`, `/triage`, `/handoff`, `/improve-codebase-architecture`, `/to-questionnaire`. The skills are installed but not model-invocable, so never claim one is missing.
- **Model-invoked** (load the skill and do the work): `grilling`, `tdd`, `code-review`, `pr`, `diagnosing-bugs`, `prototype`, `research`, `wizard`, `domain-modeling`, `codebase-design`, `writing-for-agents`.
- **Small and ad-hoc requests are exempt.** A question, a one-line fix or a small edit needs no skill and no recommendation. The rule applies when the request is the whole job of a user-invoked skill (a design interview, a spec, a ticket breakdown, a build from tickets or a spec, a retro).
- Before stating what a skill does, or recommending a step be skipped, read that skill's `SKILL.md`.

## Per-step guard rails

| Step               | Leaves alone                                                                                                                                                                                                                | Ends with                                                                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/grill-with-docs` | Code, branches, commits, PRs, issues, deploys; edits only `GLOSSARY.md` and `docs/adr/`; confirms it loaded `grilling` and `domain-modeling` (the known failure is an interview with no recommendations and no paper trail) | The decisions summarised, "shared understanding reached?", then the route from `/ask-matt` (`/implement`, `/to-spec`, `/to-tickets`, `/wayfinder`, `/prototype`, `/to-questionnaire`). Then stop: "yes" or "lgtm" approves the summary only; building starts on "implement it" or "go ahead" |
| `/wayfinder`       | Product code; its own Notes as a carrier for execution; more than one ticket per session (research excepted); picking a prototype variant for the user; treating a `task` that looks like a build slice as mis-typed        | Charting ends after creating tickets; a resolved ticket ends with the next frontier ticket; a clear map ends with `/to-spec #<map>`                                                                                                                                                          |
| `/to-spec`         | Interviewing and new decisions; the spec records only what was decided                                                                                                                                                      | `/to-tickets` in the same window                                                                                                                                                                                                                                                             |
| `/to-tickets`      | Code; publishing before the quiz is approved; closing the parent; the `ready-for-agent` label on a spec                                                                                                                     | `/implement` per ticket in a fresh window, or `/implement-spec`                                                                                                                                                                                                                              |
| `/implement`       | Reopening the plan; interviewing; building on the default branch                                                                                                                                                            | Commit first, then `/code-review` (fresh session), then close the ticket and tick its criteria (`/implement` does neither)                                                                                                                                                                   |
| `/implement-spec`  | Reopening the plan; interviewing; building on the default branch                                                                                                                                                            | Commit, then `/code-review`, then close the tickets and tick their criteria                                                                                                                                                                                                                  |
| `/code-review`     | Fixing; looping until clean (it never converges); spawning more reviewers (known recursion bug)                                                                                                                             | Findings by axis; fixes are a new `/implement` pass; then the user asks the agent to push and open the PR (`pr` shapes the body, `Closes #N`); merge only after a review                                                                                                                     |
| `/retro`           | Changing anything before the user picks a candidate                                                                                                                                                                         | The picked candidates as tickets or a grill                                                                                                                                                                                                                                                  |

## Switching between grilling and wayfinder

The split is session count, not importance: `/grill-with-docs` plans in one session, `/wayfinder` across several. Wayfinder is slower and denser, and reaching for it on a well-scoped feature is the common mistake, so grilling is the default. A switch is always a prompt to the user, never automatic. Both are user-invoked, so the agent only offers the exact text to type. A request small enough for no skill gets no prompt, and the agent reads the target skill's `SKILL.md` before recommending it.

The thresholds below are estimates, to be tuned by use.

### Grilling to wayfinder

Prompt when two or more of these hold:

- The destination cannot be stated narrowly (a spec, a decision or one change); every answer widens it.
- After about three rounds the frontier still grows: new branches arrive faster than they close.
- The build plainly would not fit one session (roughly the ~150k-token "smart zone") once decided.
- Several independent areas each need their own decisions, research or a prototype first.
- Facts outside the repo block decisions and cannot be looked up in one pass.
- The session is nearing the smart zone before it has reached shared understanding.

The prompt names the signals seen, says the session has outgrown one window, and gives a ready-to-paste `/wayfinder <destination>` line seeded from the grilling. Staying in the same session is the first choice (the grilling is the primary source). If the window is nearly full, offer `/compact` with an instruction naming what to keep. Use `/handoff` only when the work moves harness, directory or colleague.

### Wayfinder to grilling (or past it)

Prompt, with the same seed, when:

- Charting finds no fog and the whole journey fits one session: `/grill-with-docs` to finish the decisions, or `/implement` if nothing is left to decide.
- Every decision is already made: `/to-spec`, skipping the map.
- The map is cleared: `/to-spec #<map>`, then `/to-tickets`.

Do not offer a switch mid-map for a single `wayfinder:grilling` ticket (it stays inside the map and is resolved by grilling in a fresh session), and not while a ticket is claimed.

### Seed format

Every prompt carries a seed so nothing is re-explained:

```text
/wayfinder <proposed destination>
Settled: <decision, one line each>
Open (candidate fog): <open question, one line each>
Out of scope: <what is excluded>
```

Use the same four lines after `/grill-with-docs`, `/to-spec` or `/implement`, whichever the switch recommends.

## Standing rules

- Write files with the Write or Edit tool, never shell heredocs, and keep scripts in the scratchpad.
