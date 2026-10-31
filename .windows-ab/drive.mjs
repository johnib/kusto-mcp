// Windows A/B driver: start a built kusto-mcp over stdio, call
// initialize-connection once, report timing, the result text and how many
// times `az` ran (the stub/wrapper az.cmd appends a line to AZ_LOG).
// Usage: node drive.mjs <repo dir> <label>   (scenario env comes from the caller)
import { createRequire } from 'node:module';
import fs from 'node:fs';

const [repo, label] = process.argv.slice(2);
const require = createRequire(`${repo}/package.json`);
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const azLog = process.env.AZ_LOG;
if (azLog) fs.writeFileSync(azLog, '');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${repo}/dist/index.js`],
  env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', d => (stderr += d));
const client = new Client({ name: 'windows-ab', version: '0' });
await client.connect(transport);

const started = Date.now();
const r = await client.callTool({
  name: 'initialize-connection',
  arguments: {
    cluster_url: process.env.AB_CLUSTER ?? 'https://help.kusto.windows.net',
    database: 'Samples',
  },
});
const ms = Date.now() - started;
const text = String(r.content?.[0]?.text ?? '');
await client.close();

const azRuns = azLog && fs.existsSync(azLog)
  ? fs.readFileSync(azLog, 'utf8').split(/\r?\n/).filter(Boolean)
  : [];
const out = {
  label,
  ms,
  isError: !!r.isError,
  hint: (text.match(/Failed step:[^\n]*/) ?? [text.slice(0, 300)])[0],
  azRuns: azRuns.length,
  azArgs: azRuns,
};
console.log(JSON.stringify(out));
fs.appendFileSync(process.env.AB_RESULTS ?? 'results.jsonl', JSON.stringify(out) + '\n');
