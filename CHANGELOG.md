# Changelog

## [0.3.0](https://github.com/nemchik/suitescript-verify/compare/suitescript-verify-v0.2.0...suitescript-verify-v0.3.0) (2026-11-13)


### ⚠ BREAKING CHANGES

* set SUITESCRIPT_VERIFY_RESULTS_DIR in verification/.env (rerun init --results-dir docs/verification/results to keep the old location).

### Features

* require the project to choose the results folder ([#12](https://github.com/nemchik/suitescript-verify/issues/12)) ([fb0451c](https://github.com/nemchik/suitescript-verify/commit/fb0451c580e9749bc018d3ed8edf6ce618851841))

## [0.2.0](https://github.com/nemchik/suitescript-verify/compare/suitescript-verify-v0.1.0...suitescript-verify-v0.2.0) (2026-11-13)


### Features

* name the runner role with SUITESCRIPT_VERIFY_ROLE_ID ([#6](https://github.com/nemchik/suitescript-verify/issues/6)) ([b554130](https://github.com/nemchik/suitescript-verify/commit/b5541304fb6c3d44d725d4fb4d6c81d969904848))

## 0.1.0 (2026-11-13)


### Features

* add the suitescript-verify skeleton with a help and a deploy dry-run command ([abf7526](https://github.com/nemchik/suitescript-verify/commit/abf7526c45b7af69518f6769214cc2076890e702))
* extract the verification tooling ([7924455](https://github.com/nemchik/suitescript-verify/commit/7924455077fd5d64cf370a9bfb108000567697df))
* init scaffolds the folders and .env, doctor checks the setup ([68f8613](https://github.com/nemchik/suitescript-verify/commit/68f8613debef08ad9b0a0cac381233756a4a0f2c))
* layered SUITESCRIPT_VERIFY_ configuration with the allowlist check ([6ffc0a9](https://github.com/nemchik/suitescript-verify/commit/6ffc0a99c5c0aa1cabeff998912f9f52db434778))
* let a probe declare typed data parameters ([d0974a1](https://github.com/nemchik/suitescript-verify/commit/d0974a1f4255df4dae32773891142865c57e6870))
* register extra probe tags ([f832483](https://github.com/nemchik/suitescript-verify/commit/f8324838809a43adc06e05bea46c7e6c0ae2449c))
* run a probe in a sandbox with guardrails ([9a4a330](https://github.com/nemchik/suitescript-verify/commit/9a4a3303bb07658e15b352828f7e3cb532be40ce))
* setup-ci lists what the pipeline supplies and writes nothing ([7347f3a](https://github.com/nemchik/suitescript-verify/commit/7347f3ab4aa857bfab707ef58d4532746f96b400))
