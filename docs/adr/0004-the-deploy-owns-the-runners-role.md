# The deploy owns the runner's role

The runner's role is an SDF object in the generated project, so every deploy rewrites its permissions and the account cannot drift from what the project commits. The person still creates the role by hand once, with only its name and id, so the whole sandbox setup (integration record, role, both certificate mappings) stays one trip; the first deploy takes the role over. The role carries the token-login permissions the runner needs plus the permissions its probes declare with `@permission`, nothing added by hand survives a deploy, and each project has its own role (`customrole_<runner id>` by default) because two projects deploying one role would overwrite each other. The SDF login uses a different role that can deploy, since a deploy that rewrote its own login role would strip the permissions the next deploy needs.

## Considered options

- A role made and maintained only by hand: rejected, its permissions drift from the probes that need them and nothing notices.
- A hand-made role that `doctor` checks: rejected, `doctor` checks no SDF objects, and a check reports drift without preventing it.
- A role the first deploy creates from nothing: rejected, the runner's token mapping needs the role to exist, so setup would take a second trip to the sandbox after the first deploy.

## Consequences

Setup relies on SDF replacing a hand-made role whose script id matches, which Oracle states for custom objects in general but was not tested for roles when this was decided; the first sandbox run of 2.0 confirms it, or setup falls back to the second trip. `cleanup` leaves the role in place, since deactivating it would break its token mapping.

ADR 0005 replaces the rule that the role carries the permissions probes declare: from 3.0 the runner's role keeps only the token-login permissions, and probes run under execution roles.
