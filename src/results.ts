import { relative } from "node:path";
import type { Probe } from "./probes.ts";

/** A draft results page: the test, the NetSuite version, the results, and empty explanation and decision sections for a person to fill in. */
export function resultsDraft(options: {
  date: string;
  output: unknown;
  probe: Probe;
  probeFile: string;
  resultsDir: string;
  scriptSource: string;
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
- **Method:** deployed RESTlet (the suitescript-verify runner)
- **Probe:** [${options.probe.slug}](${link})

## Test

\`\`\`js
${options.scriptSource.trimEnd()}
\`\`\`

## Results

\`\`\`json
${JSON.stringify(options.output, null, 2)}
\`\`\`

## Explanation

TODO(verify): what the results mean, and how they relate to what each source claims.

## Decision

TODO(verify): what was decided because of the results.
`;
}
