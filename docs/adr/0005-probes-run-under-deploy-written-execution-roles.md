---

## status: proposed

# Probes run under execution roles the deploy writes

Each set of permissions that probes declare (`@permission <permkey> VIEW|CREATE|EDIT|FULL`, NetSuite's own levels) gets its own execution role, written by the deploy. A probe runs under its set's role through a Suitelet host deployment whose `runasrole` is that role. A RESTlet probe with a permission continues from the host to a RESTlet host through `N/https.requestRestlet`, which runs with the calling script's privileges. The runner's role keeps only the token-login permissions, so a probe that declares nothing runs in the runner and can write nothing that needs a permission. A probe writes only if it declares a level above VIEW or `@writes`, for writes that no permission shows, and the person approves writes once, at deploy, by typing the highest level being deployed. This keeps one runner key pair and one hand-made role, and gives each probe exactly the permissions it declares, so a probe can also show what the platform does without a permission.

Deployments use fixed slots that each deploy points at the current roles, because SDF can neither delete an object nor remove a permission from a role. A changed set gets a new role, and the old one is marked inactive with nothing referring to it, so a person can delete it. Roles are named after the permission set they hold.

## Considered options

- Changing a role's permissions at runtime, or creating and deleting a role per run: rejected, SuiteScript can only search the role record, and a RESTlet runs under the role of the token that called it.
- A second token mapping for a write role: rejected, another key pair and mapping for every project, and the permissions of all write probes mixed in one role.
- One shared write role reached through `runasrole`: rejected, a deploy cannot remove a permission, so the role only ever grows, and write probes share each other's permissions.
- A Suitelet as the entry point instead of the RESTlet: rejected, machine-to-machine tokens reach RESTlets, and a Suitelet available without login is anonymous (ADR 0003).
- Browser login for deploys instead of the SDF key pair: rejected, a key pair mapped in the sandbox cannot log in anywhere else, while a browser login reaches whatever account the person picks, so a check would replace a lock built into the login.
- Approval per write run: rejected, the role's permissions are granted at deploy, so the deploy is where the person sees and accepts them.

## Consequences

A RESTlet probe with a permission is capped at about 45 seconds, the limit of the nested HTTPS call, instead of 300. Suitelet probes stop sharing the runner's role. This ships as 3.0. Nothing is built until a sandbox run confirms that `runasrole` takes effect through `requestSuitelet` from a runner called with a machine-to-machine token, which role a RESTlet reached through `requestRestlet` runs under, and that a deploy can create a role, point a deployment at it and repoint it later. If `runasrole` fails, the design falls back to a second token mapping. If `requestRestlet` does not carry the role over, only RESTlet probes that declare no permission remain.

The guardrails stop mistakes, not a probe written to get around them. Writes that need a permission are blocked by the roles. Writes that need none are caught by refusing, in a probe that does not write, any module outside a shipped allowlist and any `require` of a module name that is not a literal. A probe that calls a host directly to run another probe is not stopped.
