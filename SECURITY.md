# Security policy

## Supported versions

Only the latest published version of `suitescript-verify` receives fixes.

## Reporting a vulnerability

Do not open a public issue. [Report it privately through GitHub](https://github.com/nemchik/suitescript-verify/security/advisories/new). Include the version and the command involved.

What counts as a vulnerability here:

- The package, its CLI or its release workflow doing something harmful: running unexpected code, writing outside the paths it was given, leaking credentials, or reaching a production account.
- A way around a guardrail: the sandbox-only check, the terminal approval for a write, or the identifier scrub.
- A supply-chain weakness in how the package is built or published (`.github/workflows/release.yml`; publishing uses npm trusted publishing with no stored token).
