/**
 * Privacy regression tests:
 *  1. Raw query/command text must NEVER appear on an exported span (only length).
 *  2. No company/user identity attribute (enduser.*, azure.*, kusto.cluster.*,
 *     kusto.database) may EVER appear on any span — telemetry is anonymous.
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

// Any attribute key that identifies a company or user is forbidden.
const FORBIDDEN_KEY =
  /^(enduser\.|azure\.)|^kusto\.cluster\.|^kusto\.database$/;

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
    expect(attrs['kustomcp.query.length']).toBe(SENSITIVE.length);
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

  test('no company/user identity attribute appears on any span', async () => {
    const connection = new KustoConnection(config);
    await connection.initialize(
      'https://contoso.westeurope.kusto.windows.net',
      'SalesDb',
    );
    await connection.executeQuery('SalesDb', 'StormEvents | count');

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      for (const key of Object.keys(span.attributes)) {
        expect(key).not.toMatch(FORBIDDEN_KEY);
      }
    }
  });
});
