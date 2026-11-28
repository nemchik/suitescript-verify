import { relative } from "node:path";
import { isSuitelet, type Probe } from "./probes.ts";
import type { Usage } from "./usage.ts";

/** A draft results page: the test, the NetSuite version, the results, and empty explanation and decision sections for a person to fill in. */
export function resultsDraft(options: {
  date: string;
  output: unknown;
  /** The execution role's level for each permission key the probe declared, shown beside the output. */
  permissions?: Record<string, string>;
  probe: Probe;
  probeFile: string;
  resultsDir: string;
  scriptSource: string;
  /** The governance usage the runner reported: shown beside the output, never part of an expectation. */
  usage?: Usage;
  version: string;
}): string {
  const link = relative(options.resultsDir, options.probeFile).replaceAll(
    "\\",
    "/",
  );
  return `# TODO(verify): what was verified

- **NetSuite version:** ${options.version}
- **Account type:** sandbox
- **Date:** ${options.date}
- **Method:** ${
    isSuitelet(options.probe)
      ? "deployed Suitelet (the suitescript-verify Suitelet host, called by the runner)"
      : "deployed RESTlet (the suitescript-verify runner)"
  }
- **Probe:** [${options.probe.slug}](${link})

## Test

\`\`\`js
${options.scriptSource.trimEnd()}
\`\`\`

## Results

\`\`\`json
${JSON.stringify(options.output, null, 2)}
\`\`\`
${
  options.permissions === undefined ||
  Object.keys(options.permissions).length === 0
    ? ""
    : `
Permissions (the level the probe's execution role held of each key it declared, read in the host):

\`\`\`json
${JSON.stringify(options.permissions, null, 2)}
\`\`\`
`
}${
  options.usage === undefined
    ? ""
    : `
Usage (governance units remaining before and after the run; information only, never part of the expected output):

\`\`\`json
${JSON.stringify(options.usage, null, 2)}
\`\`\`
`
}
## Explanation

TODO(verify): what the results mean, and how they relate to what each source claims.

## Decision

TODO(verify): what was decided because of the results.
`;
}
