# The package never accepts the SuiteCloud license

`@oracle/suitecloud-cli` is a peer dependency, and accepting Oracle's license is each project maintainer's act. This package never sets `SUITECLOUD_CLI_ACCEPT_LICENSE`, its CI installs with `--ignore-scripts`, and its tests run against a fake CLI. Rejected: bundling the CLI as a dependency (an install would accept the license on the maintainer's behalf).
