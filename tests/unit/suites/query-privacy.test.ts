/**
 * Privacy regression test: raw query/command text must NEVER appear on an
 * exported span — only its length. Guards the core telemetry data-handling rule.
 */

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import {
  AuthenticationMethod,
  KustoConfig,
} from '../../../src/types/config.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const config: KustoConfig = {
  authMethod: AuthenticationMethod.AzureCli,
  queryTimeout: 60000,
};

const SENSITIVE = 'StormEvents | where Secret == "p@ssw0rd-DO-NOT-LEAK"';

describe('query telemetry privacy', () => {
  beforeAll(() => {
    provider.register();
  });

  beforeEach(() => {
    exporter.reset();
  });

  test('kusto.query span records length, never raw query text', async () => {
    const connection = new KustoConnection(config);
    await connection.initialize('https://help.kusto.windows.net', 'Samples');
    exporter.reset(); // drop the init span; focus on the query span

    await connection.executeQuery('Samples', SENSITIVE);

    const spans = exporter.getFinishedSpans();
    const querySpan = spans.find(s => s.name === 'kusto.query');
    expect(querySpan).toBeDefined();

    const attrs = querySpan!.attributes;
    // Length is recorded...
    expect(attrs['kustomcp.query.length']).toBe(SENSITIVE.length);
    // ...but the text itself is never present, under any key.
    expect(attrs['query.text']).toBeUndefined();
    expect(attrs['command.text']).toBeUndefined();
    expect(attrs['kustomcp.query.text']).toBeUndefined();
    for (const value of Object.values(attrs)) {
      if (typeof value === 'string') {
        expect(value).not.toContain('p@ssw0rd');
        expect(value).not.toContain('Secret');
      }
    }
  });
});
