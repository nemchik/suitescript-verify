# Probes run under execution roles the deploy writes

Each set of permissions that probes declare (`@permission <permkey> VIEW|CREATE|EDIT|FULL`, NetSuite's own levels) gets its own execution role, written by the deploy. A probe runs under its set's role through a Suitelet host deployment whose `runasrole` is that role. A RESTlet probe with a permission continues from the host to a RESTlet host through `N/https.requestRestlet`, which runs with the calling script's privileges. The runner's role keeps only the token-login permissions, so a probe that declares nothing runs in the runner and can write nothing that needs a permission, beyond the Other Addresses permission every role holds (see Consequences). This replaces ADR 0004's rule that each deploy adds the probes' declared permissions to the runner's role; the rest of ADR 0004 stands. A probe writes only if it declares a level above VIEW or `@writes`, for writes that no permission shows, and the person approves writes once, at deploy, by typing the highest level being deployed. This keeps one runner key pair and one hand-made role, and gives each probe exactly the permissions it declares, so a probe can also show what the platform does without a permission.

Deployments use fixed slots that each deploy points at the current roles, because SDF can neither delete an object nor remove a permission from a role. A changed set gets a new role, and the old one is marked inactive with nothing referring to it, so a person can delete it. Roles are named after the permission set they hold.

## Considered options

- Changing a role's permissions at runtime, or creating and deleting a role per run: rejected, SuiteScript can only search the role record, and a RESTlet runs under the role of the token that called it.
- A second token mapping for a write role: rejected, another key pair and mapping for every project, and the permissions of all writing probes mixed in one role.
- One shared write role reached through `runasrole`: rejected, a deploy cannot remove a permission, so the role only ever grows, and writing probes share each other's permissions.
- A Suitelet as the entry point instead of the RESTlet: rejected, machine-to-machine tokens reach RESTlets, and a Suitelet available without login is anonymous (ADR 0003).
- Browser login for deploys instead of the SDF key pair: rejected, a key pair mapped in the sandbox cannot log in anywhere else, while a browser login reaches whatever account the person picks, so a check would replace a lock built into the login.
- Approval per write run: rejected, the role's permissions are granted at deploy, so the deploy is where the person sees and accepts them.

## Consequences

A RESTlet probe with a permission is capped at the limit of the nested HTTPS call, about 46 seconds in the run below, instead of 300. Suitelet probes stop sharing the runner's role. This ships as 3.0.

A sandbox run at NetSuite 2026.2 (#85, results on #84) confirmed the platform behavior this rests on, so neither fallback (a second token mapping, or refusing RESTlet probes with a permission) is needed:

- `runasrole` took effect through `requestSuitelet` from a runner called with a machine-to-machine token, for a role the deploy created and nobody was assigned. A RESTlet reached from that Suitelet through `requestRestlet` ran under the same execution role.
- One deploy created roles and the deployments pointing at them. A later deploy repointed a deployment and marked the old role inactive in the same deploy, and a deleted script id and role id were deployed again.
- Inside the Suitelet, `runtime.getCurrentUser().roleId` still named the runner's role while `getPermission` gave the execution role's levels. So a host proves its role with `getPermission` and knows its slot by its deployment id, never by `roleId`.
- Every role the deploy created also held Other Addresses at FULL, which nothing declared, as the hand-made runner's role does. So every probe, whatever it declares and wherever it runs, can do what that permission allows.
- `requestRestlet` gave up after about 46 seconds.

The guardrails stop mistakes, not a probe written to get around them. Writes that need a permission are blocked by the roles. Writes that need none are caught by refusing, in a probe that does not write, any module outside a shipped allowlist and any `require` of a module name that is not a literal. `N/search` is on the allowlist although `search.save()` worked under VIEW in the same run: refusing it would make almost every read probe a writing probe, so saving a search is a write the guardrails do not stop. A probe that calls a host directly to run another probe is not stopped.
