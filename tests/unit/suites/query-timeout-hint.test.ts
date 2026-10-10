/**
 * #312 — a timeout must tell the agent how to recover (narrow the time range,
 * filter earlier, summarize first), on every timeout, and mention the lookback
 * when the query's time window is longer than a day. The hint is for the agent
 * only: it must never reach a span attribute or event.
 */

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  formatKustoMcpError,
  KustoMcpError,
  KustoTimeoutError,
  withTimeoutHint,
} from '../../../src/common/errors.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { executeQueryWithTransformation } from '../../../src/operations/kusto/queries.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const HINT =
  'Narrow the time range, filter earlier, or summarize before returning rows.';
const LOOKBACK = 'looks back more than 1 day';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

async function connect(queryTimeout = 60000) {
  const connection = new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout,
  });
  await connection.initialize('https://help.kusto.windows.net', 'Samples');
  exporter.reset();
  return {
    connection,
    execute: (connection as unknown as { client: { executeQuery: jest.Mock } })
      .client.executeQuery,
  };
}

async function agentMessage(
  query: string,
  arrange: (execute: jest.Mock) => void,
  queryTimeout = 60000,
): Promise<string> {
  const { connection, execute } = await connect(queryTimeout);
  arrange(execute);
  let thrown: unknown;
  try {
    await executeQueryWithTransformation(connection, query);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(KustoMcpError);
  return formatKustoMcpError(thrown as KustoMcpError);
}

const hang = (execute: jest.Mock) =>
  execute.mockReturnValueOnce(new Promise(() => {}));

const serverTimeout = (execute: jest.Mock) =>
  execute.mockRejectedValueOnce(
    Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          error: {
            code: 'RequestExecutionTimeout',
            '@type': 'Kusto.Data.Exceptions.KustoServiceTimeoutException',
            '@message': 'Query timed out',
          },
        },
      },
    }),
  );

describe('timeout recovery hint (#312)', () => {
  beforeAll(() => provider.register());
  beforeEach(() => exporter.reset());

  test('client timeout on a short-window query gets the hint, no lookback note', async () => {
    const msg = await agentMessage(
      'StormEvents | where StartTime > ago(1h) | count',
      hang,
      20,
    );
    expect(msg).toBe(`Kusto Timeout Error: Query timed out after 20ms. ${HINT}`);
  });

  test('client timeout on a query with no time filter still gets the hint', async () => {
    const msg = await agentMessage('StormEvents | count', hang, 20);
    expect(msg).toContain(HINT);
    expect(msg).not.toContain(LOOKBACK);
  });

  test('a lookback longer than a day is called out', async () => {
    const msg = await agentMessage(
      'StormEvents | where StartTime > ago(30d) | take 10',
      hang,
      20,
    );
    expect(msg).toContain(HINT);
    expect(msg).toContain(LOOKBACK);
  });

  test('a one-day lookback is not called out', async () => {
    const msg = await agentMessage(
      'StormEvents | where StartTime > ago(1d) | take 10',
      hang,
      20,
    );
    expect(msg).toContain(HINT);
    expect(msg).not.toContain(LOOKBACK);
  });

  test('server timeout gets the hint and the lookback note', async () => {
    const msg = await agentMessage(
      'StormEvents | where StartTime > ago(7d) | take 10',
      serverTimeout,
    );
    expect(msg).toContain('Query timed out');
    expect(msg).toContain(HINT);
    expect(msg).toContain(LOOKBACK);
  });

  test('non-timeout errors get no hint', async () => {
    const msg = await agentMessage('StormEvents | where ago(30d)', execute =>
      execute.mockRejectedValueOnce(new Error('Semantic error')),
    );
    expect(msg).not.toContain(HINT);
  });

  test('the hint never reaches telemetry', async () => {
    const { connection, execute } = await connect(20);
    hang(execute);
    await expect(
      executeQueryWithTransformation(
        connection,
        'StormEvents | where StartTime > ago(30d) | take 10',
      ),
    ).rejects.toBeInstanceOf(KustoTimeoutError);

    const dumped = JSON.stringify(
      exporter.getFinishedSpans().map(s => ({
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
    );
    expect(dumped).not.toMatch(/narrow|summarize|looks back/i);
  });

  test('a long server message is handled in linear time', () => {
    // A trailing-punctuation regex like /\.?\s*$/ is quadratic on long
    // whitespace runs; this input took ~20s with it.
    const started = Date.now();
    const msg = withTimeoutHint(' '.repeat(200_000) + 'x', 'T | count');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(msg.endsWith(`x. ${HINT}`)).toBe(true);
  });

  test('trailing period and whitespace are not doubled', () => {
    expect(withTimeoutHint('Query timed out. \n', 'T')).toBe(
      `Query timed out. ${HINT}`,
    );
  });
});
