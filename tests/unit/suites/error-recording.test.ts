/**
 * Regression test for the nested-span exception-inflation defect (I1).
 *
 * Before the fix, one failure was recorded as an `exception` event on EVERY
 * span in the executeQueryWithTransformation → executeQuery → kusto.query chain
 * (inflating failure counts ~3x). `recordSpanError` is now idempotent per error
 * object, and re-wrapping layers call `carryErrorRecording`, so exactly one
 * span — the innermost/originating `kusto.query` span — carries the event.
 *
 * Red→green: revert the recordSpanError/carryErrorRecording changes and this
 * expects 1 but observes 3.
 */

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { executeQueryWithTransformation } from '../../../src/operations/kusto/queries.js';
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

describe('exception recording is deduped to the originating span', () => {
  beforeAll(() => {
    provider.register();
  });

  beforeEach(() => {
    exporter.reset();
  });

  test('a failed query records exactly one exception event across nested spans', async () => {
    const connection = new KustoConnection(config);
    // initialize() succeeds: the mocked Client.execute resolves undefined.
    await connection.initialize('https://help.kusto.windows.net', 'Samples');
    exporter.reset(); // drop the init span; focus on the query chain

    // Force the actual query execution to reject. `client` is the mocked
    // Client instance whose `execute` delegates to a per-instance jest.fn.
    const boom = new Error('kusto boom');
    boom.name = 'KustoServiceError';
    (
      connection as unknown as { client: { executeQuery: jest.Mock } }
    ).client.executeQuery.mockRejectedValueOnce(boom);

    await expect(
      executeQueryWithTransformation(connection, 'StormEvents | count'),
    ).rejects.toThrow();

    const spans = exporter.getFinishedSpans();

    // All three nested spans are present...
    expect(spans.map(s => s.name)).toEqual(
      expect.arrayContaining([
        'kusto.query',
        'executeQuery',
        'executeQueryWithTransformation',
      ]),
    );

    // ...but the `exception` event is recorded on exactly ONE of them.
    const exceptionEvents = spans.flatMap(s =>
      s.events.filter(e => e.name === 'exception'),
    );
    expect(exceptionEvents).toHaveLength(1);

    // ...and it lands on the innermost/originating span.
    const originating = spans.find(s =>
      s.events.some(e => e.name === 'exception'),
    );
    expect(originating?.name).toBe('kusto.query');

    // Every span in the chain still carries error.type + ERROR status.
    for (const s of spans) {
      expect(s.attributes['kustomcp.error.type']).toBeDefined();
    }
  });
});
