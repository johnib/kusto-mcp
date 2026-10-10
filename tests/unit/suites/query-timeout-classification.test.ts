/**
 * #319 — query outcomes must not be classified by searching the error text for
 * "timeout". Our own timer must throw KustoTimeoutError (so error.type stops
 * counting it as a query error), and a server timeout must be recognised from
 * Kusto's structured error, not from any message that mentions a timeout.
 *
 * Server timeout shapes below were captured from a live cluster with
 * azure-kusto-data 7.2.0 and a 2s servertimeout:
 *  - v2 query (HTTP 200): the SDK throws a plain Error whose message is
 *    "Kusto request had errors. Query timed out" (code/@type are dropped).
 *  - non-2xx: axios error with response.data.error.code "RequestExecutionTimeout"
 *    and @type "Kusto.Data.Exceptions.KustoServiceTimeoutException".
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
} from '../../../src/common/errors.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { executeQueryWithTransformation } from '../../../src/operations/kusto/queries.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

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

function querySpan() {
  const span = exporter.getFinishedSpans().find(s => s.name === 'kusto.query');
  expect(span).toBeDefined();
  return span!.attributes;
}

async function failWith(error: unknown) {
  const { connection, execute } = await connect();
  execute.mockRejectedValueOnce(error);
  await expect(
    executeQueryWithTransformation(connection, 'StormEvents | count'),
  ).rejects.toThrow();
  return querySpan();
}

describe('query timeout classification (#319)', () => {
  beforeAll(() => provider.register());
  beforeEach(() => exporter.reset());

  test('our timer throws KustoTimeoutError and is a client timeout', async () => {
    const { connection, execute } = await connect(20);
    execute.mockReturnValueOnce(new Promise(() => {}));

    let thrown: unknown;
    try {
      await executeQueryWithTransformation(connection, 'StormEvents | count');
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(KustoTimeoutError);
    expect(formatKustoMcpError(thrown as KustoMcpError)).toMatch(
      /^Kusto Timeout Error: Query timed out after 20ms\./,
    );

    const attrs = querySpan();
    expect(attrs['kustomcp.outcome']).toBe('timeout');
    expect(attrs['kustomcp.query.timeout_kind']).toBe('client');
    expect(attrs['kustomcp.error.type']).toBe('KustoTimeoutError');
  });

  test('an error that merely mentions a timeout is an error, not a timeout', async () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          error: {
            code: 'General_BadRequest',
            '@type': 'Kusto.Data.Exceptions.KustoBadRequestException',
            '@message':
              "Semantic error: 'where' operator: Failed to resolve column named 'timeout'",
          },
        },
      },
    });
    const attrs = await failWith(err);
    expect(attrs['kustomcp.outcome']).toBe('error');
    expect(attrs['kustomcp.query.timeout_kind']).toBeUndefined();
  });

  test('a plain error text with "timed out" is not a server timeout', async () => {
    const attrs = await failWith(new Error('Token request timed out'));
    expect(attrs['kustomcp.outcome']).toBe('error');
    expect(attrs['kustomcp.query.timeout_kind']).toBeUndefined();
  });

  test('structured Kusto timeout error is a server timeout', async () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
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
    });
    const attrs = await failWith(err);
    expect(attrs['kustomcp.outcome']).toBe('timeout');
    expect(attrs['kustomcp.query.timeout_kind']).toBe('server');
  });

  test('SDK-flattened v2 server timeout is a server timeout', async () => {
    const attrs = await failWith(
      new Error('Kusto request had errors. Query timed out'),
    );
    expect(attrs['kustomcp.outcome']).toBe('timeout');
    expect(attrs['kustomcp.query.timeout_kind']).toBe('server');
  });

  test('axios HTTP timeout is a client timeout, not a server one', async () => {
    const err = Object.assign(new Error('timeout of 90000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const attrs = await failWith(err);
    expect(attrs['kustomcp.outcome']).toBe('timeout');
    expect(attrs['kustomcp.query.timeout_kind']).toBe('client');
  });

  test('throttling is still throttled', async () => {
    const err = new Error(
      'POST request failed with status 429 (Too Many Requests)',
    );
    err.name = 'ThrottlingError';
    const attrs = await failWith(err);
    expect(attrs['kustomcp.outcome']).toBe('throttled');
  });
});
