# Workflow

The flow is grill, spec, tickets, implement, review, retro. The marked block below is the generic flow; the sections after it are this repo's additions.

<!-- flow:start -->
## Agent workflow

### Choosing a route

- A question, a one-line fix or a small edit needs no skill.
- **Small change:** `/grill-with-docs`, then `/implement`, in the same session. The build needs the grilling's reasoning, not a summary of it.
- **Larger work:** `/grill-with-docs` → `/to-spec` → `/to-tickets` in one unbroken window. Don't `/clear` or `/compact` until `/to-tickets` is done. `/to-spec` may be skipped: `/to-tickets` can run straight from the grilling thread.
  - Then build in a **fresh session**. The spec and tickets carry everything the build needs.
  - Multi-ticket work: `/implement-spec` (the default).
  - A single ticket, or when the user wants to steer each ticket: `/implement`, with `/clear` between tickets.
- Work that won't fit one session even after grilling: `/wayfinder`. A question that needs runnable code to answer: `/prototype`.

### Approval words

Grilling ends with a summary of the decisions and stops. "yes" or "lgtm" approves only the summary. Building starts only on "implement it", "go ahead" or `/implement`.

### Commit, then review

- `/code-review` diffs commits (`<fixed-point>...HEAD`), so uncommitted work is never reviewed. Commit first.
- Before recommending `/code-review`, run `git status` and check for commits not yet pushed. Report any uncommitted or unpushed work with a recommendation (commit it, push it, stash it, or leave it out on purpose and say why).
- The `implement` skill runs its review before it commits. This rule overrides it: commit, then review.
- After `/implement`: a separate `/code-review` in a fresh session is required.
- After `/implement-spec`: skip the separate review. The orchestrator wrote no code (its subagents did), and it already reviewed the committed integration branch.

### Fixing review findings

- The review session never fixes, never loops until clean (it never converges) and never spawns more reviewers.
- Fixes go back to the original implement session if it still has room (under ~150k tokens): paste the findings in. Otherwise run a fresh `/implement` seeded with the findings.
- `/implement-spec` fixes its own findings in one fresh implementer subagent.

### Finishing

1. Push and open a PR whose body has `Closes #N` for each ticket.
2. Close the tickets and tick their acceptance criteria. `/implement` does neither.
3. Merge once the PR has been reviewed.
4. Clean up merged branches and worktrees.
5. Optional: `/retro`, only if the session was rough. Run it in the session it looks back on, before clearing; after a clear, point it at that session's log.

### Phase boundaries

At every phase boundary, say "continue here" or "go fresh" with a one-line reason: how full the context is, whether the next step needs this session's reasoning, and whether the artifacts it needs are self-contained.

### Guard rails

Each step does only its own job, then names the next slash command and stops. The user picks every step.

- `/grill-with-docs` asks questions and records decisions in `GLOSSARY.md` and `docs/adr/` only. It ends with the decision summary and waits for an approval word.
- `/to-spec` writes up decisions already made.
- `/to-tickets` drafts the breakdown, publishes after the user approves it, and leaves the parent issue open.
- `/implement` and `/implement-spec` build the approved plan as written, on a feature branch.
- `/code-review` reports findings only.
- `/retro` proposes candidates and edits after the user picks one.
<!-- flow:end -->

## "Let's address issue N"

Read the issue, pick the step from what the tracker shows, tell the user which step that is, and **recommend the next slash command when the step ends**, naming the exact text to type.

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
- In `/implement-spec`, check each finished ticket branch with `git merge-tree --write-tree <integration> <ticket>` first. When it reports no conflicts, merge it yourself, run `npm test` and push. Spawn a merger subagent only for a conflict. A subagent per clean merge cost eleven agents and a context compaction on spec #27.
- Sandbox checks of a pull request: follow `docs/agents/sandbox-check.md` from the hand-off through reviewing the fixes, and give the downstream session its prompt.
- Repository maintenance lessons (release, build, toolchain, GitHub rules such as the five-branch push limit) are in `docs/maintaining.md`. Read it before a release, a bulk push or a toolchain change.
