import { PromptDefinition } from '../../types/prompt-interfaces.js';

/**
 * Hardcoded prompt definitions for the Kusto MCP server
 */
const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: 'analyze-query-perf',
    title: 'analyze_query_performance',
    description:
      'Analyze KQL query performance by measuring scanned extents and totalCpu impact of each query part',
    arguments: [
      {
        name: 'query',
        description: 'The KQL query to analyze for performance bottlenecks',
        required: true,
      },
    ],
    template: (args: Record<string, string>) => {
      const { query } = args;
      return `I want your help analyzing the below query's performance. The query takes too much resources and I need you to find out which part of the query contributes the most.

\`\`\`query
${query}
\`\`\`

The way I want you to measure the impact of each query is by measuring how much the \`scanned extents\` grew per each line, and how much the \`totalCpu\` grew per each line.

larger amount of scanned extents means a lot of overhead to the kusto query high totalCpu means the query requires more CPU power.

the methodology I want you to follow is by taking the query from the user and run portions of it separately to measure how much each line / part of the query is adding to the computation cost as I described above.

Example #1:

With this input query:

\`\`\`Input query
let _random = 0.005;
Timeseries
| where rand() < _random
| lookup (Timeseries | where rand() < _random) on TimeseriesId
| summarize sum(Value) by TimeseriesId
| order by sum_Value desc
| top 10 by sum_Value
\`\`\`

I would start by taking every **inner** query (such as in the JOIN statement) and try to run it separately, providing it all it needs to run, for example:

- Variables defined in \`let\` statements
- Function definitions
- All it depends on within the input query, that would allow you to run the inner query separately:

\`\`\`Check #1
let _random = 0.005;
Timeseries | where rand() < _random
| count
\`\`\`

**Note**: The \`| count\` at the end is appended to the sub-query we would like to run and measure, because cannot have the tested query return endless
results, so we append \`| count\` to the end of it, as it will cause the query to run entirely, without optimizations on the Kusto engine's side, and provide coherent usage statistics.

---

Proceeding to check #2, I take the beginning of the input query, including all the WHERE statements that are sequenced to the first Table being referenced.

\`\`\`Check #2
let _random = 0.005;
Timeseries
| where rand() < _random
| count
\`\`\`

---

Proceeding to check #3, I add the next line of the query, because the query is run-able with the next line:

\`\`\`Check #3
let _random = 0.005;
Timeseries
| where rand() < _random
| lookup (Timeseries | where rand() < _random) on TimeseriesId
| count
\`\`\`

Given that this check also incorporates the inner query from Check #1, I now have the ability to estimate what is the cost of the \`lookup\` (or \`join\`) operator, in terms of \`totalCpu\` -- this is vital information.

---

\`\`\`Check #4
let _random = 0.005;
Timeseries
| where rand() < _random
| lookup (Timeseries | where rand() < _random) on TimeseriesId
| summarize sum(Value) by TimeseriesId
| count
\`\`\`

This one, will measure the impact of the \`summarize\` line.

And by this pattern I would run as many \`check\` as needed, adding more and more parts of the input query, and measuring the \`scanned extents\` and \`totalCpu\`.

This entire process would be made 3-5 times, to get multiple measurements, as a single query execution may provide false usage statistics.

---

After completing the analysis, you will create a report that helps identifying the impact of each part of the query.
Below is an example report that serves as a template for putting your results.

**Report Template:**

• Performance Analysis Results

Based on the 3 runs per check, here's the performance impact analysis:

Scanned Extents Impact:

- Check #1 (Base query): 31 extents (baseline)
- Check #2 (+ Lookup): 62 extents (+31 extents, +100%)
- Checks #4-7: All remained at 62 extents (no additional overhead)

Total CPU Impact:

| Operation                     | Avg CPU (seconds) | CPU Increase from Previous |
|-------------------------------|-------------------|----------------------------|
| Base query (Check #1)         | ~0.08s            | Baseline                   |
| + Lookup (Check #3)           | ~18.39s           | +18.31s (+23,000%)         |
| + First summarize (Check #4)  | ~28.07s           | +9.68s (+53%)              |
| + Second summarize (Check #5) | ~28.06s           | -0.01s (0%)                |
| + Order by (Check #6)         | ~27.92s           | -0.14s (-0%)               |
| + Top 10 (Check #7)           | ~31.77s           | +3.85s (+14%)              |

Key Findings:

🔴 MAJOR BOTTLENECK: Lookup Operation

- Scanned Extents: Doubled from 31 to 62 (+100%)
- Total CPU Impact: Increased by ~18.3 seconds (+23,000%)
- The lookup operation is by far the most expensive part of your query

🟡 MODERATE IMPACT: First Summarize

- Added ~9.7 seconds of total CPU time (+53% over lookup)
- No additional extent scanning overhead

🟢 MINIMAL IMPACT: Second Summarize, Order By

- Virtually no additional total CPU overhead
- These operations are very efficient on the reduced dataset

🟡 MODERATE IMPACT: Top 10

- Added ~3.9 seconds (+14%)
- Likely due to sorting overhead on the final result set`;
    },
  },
];

// Cache for prompt definitions
let cachedPromptDefinitions: PromptDefinition[] | null = null;

export function getAllPrompts(): PromptDefinition[] {
  if (!cachedPromptDefinitions) {
    cachedPromptDefinitions = [...PROMPT_DEFINITIONS];
  }
  return cachedPromptDefinitions;
}

export function getPromptByName(name: string): PromptDefinition | undefined {
  return getAllPrompts().find(prompt => prompt.name === name);
}

/**
 * Force refresh the prompt definitions cache (useful for testing)
 */
export function refreshPromptDefinitions(): void {
  cachedPromptDefinitions = null;
}
