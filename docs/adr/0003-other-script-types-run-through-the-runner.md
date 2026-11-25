# Other script types run through the runner, in script hosts

The runner (a RESTlet) stays the only entry point, because OAuth 2.0 machine-to-machine tokens reach RESTlets and no Oracle page says they reach Suitelets. A probe of another script type runs in a script host deployed beside the runner, which the runner calls from inside the account: the Suitelet host through `N/https.requestSuitelet`, with the deployment never available without login. Every script takes its id suffix from Oracle's suggested script-type abbreviation (`customscript_<runner id>_rl`, `_sl`, and later `_mr`, `_sc`, `_ue`, `_cs`), so each id fits the platform's 40 characters with a runner id of up to 24, and its display name says its role (`ssv runner <id>`, `ssv suitelet <id>`).

A Suitelet probe gets `run(params, context)`. Its response calls are buffered and replayed only after it returns, so a host answers either with the probe's own response or with the returned value as JSON, never a mix, and a throw leaves no partial output. The probe sees a request view of only the method and its declared parameters, never the request's headers, cookies or body.

## Considered options

- Calling a Suitelet directly from the CLI: rejected, token authentication does not cover Suitelets.
- A Suitelet available without login, guarded by a secret: rejected, it is an anonymous URL on an account that holds real data.
- One Suitelet per probe: rejected, more objects to deploy, turn off and fit in 40 characters.
- `run(params)` only, with no response access: rejected, the claims that need a Suitelet (`serverWidget`, `Set-Cookie`, `sendRedirect`) are about the response.
- Starting script hosts through `N/task` instead of HTTPS: `N/task` starts only Scheduled and Map/Reduce scripts, so the Suitelet host keeps `requestSuitelet`. For `_mr` and `_sc` it is the only path (#31).
- Keeping the `_runner` suffix: rejected, a 7-character suffix caps the runner id at 20, and a role name is no guide for the ids of later script types.

## Consequences

2.0 is a breaking change: a 1.x project has `customscript_<id>_runner` deployed, and the SuiteCloud CLI cannot delete a script, so the upgrade notes ask for `cleanup --approved` with 1.x first. The Suitelet path ships only after a real sandbox run proves that `requestSuitelet` reaches the host from a runner called with a machine-to-machine token.
