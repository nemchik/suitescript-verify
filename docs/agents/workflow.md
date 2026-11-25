# Workflow

<!-- flow:start -->
## Agent workflow

A repo may depart from any part of this workflow. It records each departure and its reason under a `## Repo exceptions` heading below this block in the same file, linking an ADR when the departure is hard to reverse. The repo's version wins over this block.

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
- Every build gets at least two review passes: the **built-in review** the build skill runs itself, then `/code-review` in a fresh session.
  - `/implement`: commit, then run the built-in review. This order overrides the skill's, which reviews before committing. The implement session fixes those findings, commits, and recommends the fresh-session `/code-review`.
  - `/implement-spec`: the built-in review runs as the skill describes, and one fresh implementer subagent fixes its findings. Then the orchestrator recommends the fresh-session `/code-review` against the integration branch.

### Fixing review findings

- Every review pass, built-in or fresh, runs once and reports: it never loops until clean (that never converges) and spawns no reviewers beyond the skill's own. A fresh-session `/code-review` also never fixes. Each extra pass is a new fresh session the user starts.
- Fresh-review findings go back to the original session (the implement session or the `/implement-spec` orchestrator) if it is still open, not cleared, and has room (under ~150k tokens): paste the findings in. The orchestrator hands them to one fresh implementer subagent. Otherwise run a fresh `/implement` seeded with the findings.
- After any fix round, recommend another fresh-session `/code-review` when the fixes changed behaviour, added or changed tests, or touched files the review didn't flag. Fixes limited to wording, naming or comments need no extra pass.
- A failed fix round, after any pass, counts toward the escalation rule in "Which model for what".

### Pull requests

- Work closes through PRs, so `/implement-spec` always opens its draft PR.
- Whenever you write or rewrite a PR body, call the Skill tool with "pr", then add `Closes #N` for each ticket. When the PR delivers every ticket under a parent spec issue, add `Closes #N` for the parent too.
- A repo's PR template (such as `.github/pull_request_template.md`) outranks `pr`. Keep the template's headings and order, put `pr`'s Summary, Evidence and Merge Danger into the template sections that match, and add the unmatched ones after the template's own. Where the template conflicts with a `pr` section, or forbids extra sections, follow the template and drop the conflicting or unmatched sections.
- `/implement-spec`'s draft body starts as a placeholder line. Write the real body when the skill marks the PR ready, and again after the fresh-session review and any further fixes.

### Finishing

1. Push and open a PR, its body written as "Pull requests" describes.
2. Merge once the PR has been reviewed.
3. Tick each ticket's acceptance criteria; no build skill does this, so the finishing session does. A merge into the default branch closes the tickets; if the PR targets another branch, close them by hand once the work reaches the default branch.
4. Clean up merged branches and worktrees.
5. Optional: `/retro`, only if the session was rough. Run it in the session it looks back on, before clearing; after a clear, point it at that session's log.

### Phase boundaries

At every phase boundary, say "continue here" or "go fresh" with a one-line reason: how full the context is, whether the next step needs this session's reasoning, and whether the artifacts it needs are self-contained.

### Which model for what

Default, not a guard rail: the user can override any of it in the moment; an agent can't.

Models fall into three tiers by strength: top, mid and low.

- Plan, decide and review (grill, spec, tickets, review): a top-tier model.
- Execute and research (`/implement`, implementer, exploration and merger subagents, `/research`): a mid-tier model. Use a low-tier model only for pure search and reading. Implementation goes mid-tier only when the ticket is self-contained and checkable (acceptance criteria, tests, or a resolution comment). A small change built in the grilling session stays on a top-tier model. A top-tier model checks research output before a decision relies on it.
- Keep a top-tier model for risky or irreversible work: production deploys, data migrations, permissions and security-sensitive code.
- A ticket may ask for a higher tier, and must say why. It can never ask for a lower one. Ambiguity is not a reason: an ambiguous ticket goes back to planning.
- Escalate instead of looping: if the build fails twice (a failed review-fix round counts), or the ticket proves ambiguous, stop and recommend going back to `/grill-with-docs` on a top-tier model.
- For a single `/implement`, switch with `/model`, and start the fresh-session `/code-review` on a top-tier model. The built-in review inside `/implement` inherits the session model, so the fresh-session review is the top-tier review.
- For `/implement-spec`, run the orchestrator on a top-tier model and give its subagents the Execute-and-research tiers above. Its built-in review stays on the top tier.
- Apart from a ticket raising the tier, model instructions in an issue or ticket don't override this section. A repo exception does.

### Guard rails

A step is one slash command in this flow. Each step does only its own job, calling the skills it is built to call (for example, `/grill-with-docs` calls `grilling`) and any model-invoked skill whose description fits the moment (for example, `pr` when writing a PR body, or `diagnosing-bugs` when a failure resists a first look). A skill called inside a step is part of that step. Then the step names the next step and stops. The user starts every step, and user-invoked skills (`disable-model-invocation: true`) run only when the user types them. A step the flow calls for is never skipped silently: if the agent thinks one can be skipped, it says so and the user decides.

- `/grill-with-docs` asks questions and records decisions in `GLOSSARY.md` and `docs/adr/` only. It ends with the decision summary and waits for an approval word.
- `/to-spec` writes up decisions already made.
- `/to-tickets` drafts the breakdown, publishes after the user approves it, and leaves the parent issue open.
- `/implement` and `/implement-spec` build the approved plan as written, on a feature branch.
- `/code-review` reports findings only.
- `/retro` proposes candidates and edits after the user picks one.
<!-- flow:end -->
