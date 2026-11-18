/**
 * Token phase vs HTTP phase of a failed query (#431).
 *
 * azure-kusto-data 7.2.0 wraps every token failure as its own
 * KustoAuthenticationError (security.js getAuthHeader), keeps the credential's
 * error under `inner`, and throws everything else from the HTTP call: an axios
 * error that axios renamed to the socket error's name ("Error"), or a plain
 * Error for errors in an HTTP 200 body. The shapes below are the ones the real
 * SDK produced for each case.
 *
 *  - kusto.query carries kustomcp.query.failure_stage (bounded) and, for a
 *    call with no response, a bounded kustomcp.error.code.
 *  - A failed token refresh surfaces as our KustoAuthenticationError with the
 *    token fix; a deadline that fires while the token request still runs does
 *    too, without the "narrow the time range" advice.
 *  - A broken socket is a network failure with error.type AxiosError.
 */
type Credential = { getToken: (s: string[]) => Promise<unknown> };
const execute = jest.fn<Promise<unknown>, [Credential]>();
jest.mock('azure-kusto-data', () => ({
  CloudSettings: {
    getCloudInfoForCluster: async () => ({
      KustoServiceResourceId: 'https://kusto.kusto.windows.net',
      LoginMfaRequired: false,
    }),
  },
  KustoConnectionStringBuilder: {
    withTokenCredential: (_u: string, credential: unknown) => ({ credential }),
  },
  Client: class {
    constructor(private cs: { credential: Credential }) {}
    execute() {
      return execute(this.cs.credential);
    }
    close() {}
  },
  ClientRequestProperties: class {
    setTimeout() {}
    setClientTimeout() {}
  },
}));
jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

import { runInThisContext } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  getFailureCategory,
  isNotQueryFault,
  KustoAuthenticationError,
  KustoQueryCancelledError,
  KustoTimeoutError,
  QUERY_FAILURE_STAGES,
} from '../../../src/common/errors.js';
import { CachingTokenCredential } from '../../../src/auth/token-credentials.js';
import { errorTypeName } from '../../../src/common/telemetry.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { executeQuery } from '../../../src/operations/kusto/queries.js';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const spans = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spans)],
});
beforeAll(() => provider.register());

const SCOPE = ['https://kusto.kusto.windows.net/.default'];
const rows = {
  primaryResults: [{ name: 'r', columns: [{ ColumnName: 'a' }], _rows: [[1]] }],
};
const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64url');
const token = () => ({
  token: `${b64({})}.${b64({ tid: 't', oid: 'o' })}.s`,
  expiresOnTimestamp: Date.now() + 3600_000,
});

// What the real SDK threw for a credential that rejected with our az runner's
// timeout error (name, inner and tokenProviderName as observed).
const sdkTokenError = (inner: Error) =>
  Object.assign(new Error(inner.message), {
    name: 'KustoAuthenticationError',
    inner,
    tokenProviderName: 'TokenCredentialProvider',
  });
const azTimeout = () =>
  Object.assign(new Error('Azure CLI timed out while getting a token.'), {
    name: 'CredentialUnavailableError',
    azReason: 'timeout',
  });
// What the real SDK threw when the cluster reset the socket: an AxiosError
// whose name axios replaced with the socket error's ("Error").
const axiosSocketError = (code: string) =>
  Object.assign(new Error(`read ${code}`), {
    isAxiosError: true,
    code,
    cause: Object.assign(new Error(`read ${code}`), { code }),
  });

// The process credential: answers until told to hang; releaseToken() then
// answers the hung requests.
let hangToken = false;
let hung: Array<(t: unknown) => void> = [];
const releaseToken = () => hung.splice(0).forEach(resolve => resolve(token()));
const credential = {
  getToken: () =>
    hangToken
      ? new Promise(resolve => hung.push(resolve))
      : Promise.resolve(token()),
};

async function connect(queryTimeout?: number) {
  const connection = new KustoConnection(
    { authMethod: AuthenticationMethod.AzureCli, queryTimeout },
    credential as never,
  );
  await connection.initialize('https://x.kusto.windows.net', 'd');
  spans.reset();
  return connection;
}

const querySpan = () => {
  const found = spans.getFinishedSpans().filter(s => s.name === 'kusto.query');
  return found[found.length - 1].attributes;
};

async function failWith(error: unknown) {
  const connection = await connect();
  execute.mockRejectedValueOnce(error);
  let thrown: unknown;
  await executeQuery(connection, 'T | take 1').catch(e => (thrown = e));
  return { attrs: querySpan(), thrown: thrown as Error };
}

beforeEach(() => {
  hangToken = false;
  hung = [];
  execute.mockReset();
  execute.mockResolvedValue(rows);
});

describe('kustomcp.query.failure_stage', () => {
  test.each<[string, () => unknown, string, string | undefined]>([
    [
      'the SDK token error',
      () => sdkTokenError(azTimeout()),
      'token_acquire',
      undefined,
    ],
    [
      'socket reset',
      () => axiosSocketError('ECONNRESET'),
      'request',
      'ECONNRESET',
    ],
    [
      'socket connect timeout',
      () => axiosSocketError('ETIMEDOUT'),
      'request',
      'ETIMEDOUT',
    ],
    [
      'a code outside the list is "other"',
      () => axiosSocketError('E_Customer_Table_Name'),
      'request',
      'other',
    ],
    // axios keeps the response on a body that breaks after the headers.
    [
      'a body cut off after HTTP 200',
      () =>
        Object.assign(axiosSocketError('ECONNRESET'), {
          response: { status: 200 },
        }),
      'response',
      'ECONNRESET',
    ],
    [
      'HTTP 400',
      () => Object.assign(new Error('x'), { response: { status: 400 } }),
      'response',
      undefined,
    ],
    [
      'the SDK ThrottlingError (429)',
      () => Object.assign(new Error('x'), { name: 'ThrottlingError' }),
      'response',
      undefined,
    ],
    [
      'errors in an HTTP 200 body',
      () => new Error('Kusto request had errors. Query result set too large'),
      'response',
      undefined,
    ],
    [
      'an unparseable body',
      () => new Error('Failed to parse response ({200}) with the following'),
      'response',
      undefined,
    ],
    ['anything else', () => new Error('Client is closed'), 'unknown', undefined],
  ])('%s', async (_label, make, stage, code) => {
    const { attrs } = await failWith(make());
    expect(attrs['kustomcp.query.failure_stage']).toBe(stage);
    expect(QUERY_FAILURE_STAGES).toContain(
      attrs['kustomcp.query.failure_stage'],
    );
    expect(attrs['kustomcp.error.code']).toBe(code);
  });

  test('not connected -> not_started', async () => {
    const connection = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
    });
    await connection.executeQuery('d', 'T').catch(() => undefined);
    expect(querySpan()['kustomcp.query.failure_stage']).toBe('not_started');
  });

  test('no stage or code on success', async () => {
    const connection = await connect();
    await executeQuery(connection, 'T | take 1');
    expect(querySpan()['kustomcp.query.failure_stage']).toBeUndefined();
    expect(querySpan()['kustomcp.error.code']).toBeUndefined();
  });

  test('our deadline while the HTTP call runs -> request, still a timeout', async () => {
    const connection = await connect(30);
    execute.mockReturnValueOnce(new Promise(() => {}));
    await expect(executeQuery(connection, 'T | take 1')).rejects.toBeInstanceOf(
      KustoTimeoutError,
    );
    expect(querySpan()['kustomcp.query.failure_stage']).toBe('request');
    expect(querySpan()['kustomcp.error.type']).toBe('KustoTimeoutError');
  });

  test('a client cancel while the token request runs stays a cancel', async () => {
    const connection = await connect();
    hangToken = true;
    execute.mockImplementationOnce(async c => {
      await c.getToken(SCOPE);
      return rows;
    });
    const abort = new AbortController();
    const pending = executeQuery(connection, 'T | take 1', abort.signal);
    await new Promise(r => setTimeout(r, 10));
    abort.abort();
    await expect(pending).rejects.toBeInstanceOf(KustoQueryCancelledError);
    expect(querySpan()['kustomcp.query.failure_stage']).toBe('token_acquire');
    expect(querySpan()['kustomcp.outcome']).toBe('cancelled_by_client');
    expect(querySpan()['kustomcp.error.type']).toBeUndefined();
  });

  test('another query waiting on a token does not change this query stage', async () => {
    const connection = await connect(40);
    // First query: its token arrived, the HTTP call hangs.
    execute.mockImplementationOnce(async c => {
      await c.getToken(SCOPE);
      return new Promise(() => {});
    });
    const first = executeQuery(connection, 'T | take 1').catch(e => e);
    await new Promise(r => setTimeout(r, 5));
    // Second query: starts later, hangs on its token request.
    hangToken = true;
    execute.mockImplementationOnce(async c => {
      await c.getToken(SCOPE);
      return rows;
    });
    const second = executeQuery(connection, 'T | take 2').catch(e => e);
    expect(await first).toBeInstanceOf(KustoTimeoutError);
    expect(await second).toBeInstanceOf(KustoAuthenticationError);
    const stages = spans
      .getFinishedSpans()
      .filter(s => s.name === 'kusto.query')
      .map(s => s.attributes['kustomcp.query.failure_stage']);
    expect(stages).toEqual(['request', 'token_acquire']);
  });
});

describe('a failed token refresh during a query', () => {
  test('is a KustoAuthenticationError with the token fix, not a query error', async () => {
    const { attrs, thrown } = await failWith(sdkTokenError(azTimeout()));
    expect(thrown).toBeInstanceOf(KustoAuthenticationError);
    expect(thrown.message).toContain('could not be refreshed');
    expect(thrown.message).toContain(
      'Azure CLI timed out while getting a token.',
    );
    expect(thrown.message).toContain(
      'Failed step: getting an Azure token. Azure CLI did not return a token in time',
    );
    expect(isNotQueryFault(thrown)).toBe(true);
    expect(getFailureCategory(thrown)).toBe('auth_forbidden');

    expect(attrs['kustomcp.error.type']).toBe('KustoAuthenticationError');
    expect(attrs['kustomcp.outcome']).toBe('error');
    expect(attrs['kustomcp.query.failure_category']).toBe('auth_forbidden');
    // The same bounded auth attributes a failed connect carries.
    expect(attrs['kustomcp.auth.token_acquired']).toBe(false);
    expect(attrs['kustomcp.auth.az_reason']).toBe('timeout');
  });

  test('no message text reaches the span', async () => {
    const { attrs } = await failWith(
      sdkTokenError(new Error('secret-tenant-name is not reachable')),
    );
    expect(JSON.stringify(attrs)).not.toContain('secret-tenant-name');
    expect(attrs['kustomcp.auth.failure_stage']).toBe('unknown');
  });

  test('our deadline while the token request runs: authentication error, no query advice', async () => {
    const connection = await connect(30);
    hangToken = true;
    // Like the SDK: the request goes out only after the token arrives.
    let sent = false;
    let sdkError: Error | undefined;
    execute.mockImplementationOnce(async c => {
      await c.getToken(SCOPE).catch((e: Error) => {
        sdkError = e;
        throw e;
      });
      sent = true;
      return rows;
    });
    let thrown: Error | undefined;
    await executeQuery(connection, 'T | where t > ago(1h)').catch(
      e => (thrown = e),
    );
    expect(thrown).toBeInstanceOf(KustoAuthenticationError);
    expect(thrown?.message).toContain('No Azure token after 30ms');
    expect(thrown?.message).toContain('the query was not sent');
    expect(thrown?.message).toContain('Failed step: getting an Azure token.');
    expect(thrown?.message).toContain('run the query again');
    // The deadline that fired is the query's, not the connect's.
    expect(thrown?.message).not.toContain('KUSTO_CONNECTION_TIMEOUT');
    expect(thrown?.message).not.toContain('Narrow the time range');

    // "Not sent" stays true when the token arrives late.
    releaseToken();
    await new Promise(r => setTimeout(r, 10));
    expect(sdkError?.name).toBe('AbortError');
    expect(sent).toBe(false);
    const attrs = querySpan();
    expect(attrs['kustomcp.query.failure_stage']).toBe('token_acquire');
    expect(attrs['kustomcp.outcome']).toBe('timeout');
    expect(attrs['kustomcp.query.failure_category']).toBe('timeout');
    expect(attrs['kustomcp.error.type']).toBe('KustoAuthenticationError');
  });

  test('a late token after the deadline leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    // Jest gives each test file its own `process` object, which never emits
    // this event; the real one lives in the main context.
    const realProcess = runInThisContext('process') as NodeJS.Process;
    expect(realProcess).not.toBe(process);
    realProcess.on('unhandledRejection', onUnhandled);
    try {
      // (A deliberate `void Promise.reject(...)` here reaches this listener,
      // and jest-circus then fails the test by itself; checked by hand.)
      const connection = await connect(30);
      hangToken = true;
      // Like the SDK: no catch of its own around the token request.
      let sdkCall: Promise<unknown> | undefined;
      execute.mockImplementationOnce(c => {
        sdkCall = (async () => {
          await c.getToken(SCOPE);
          return rows;
        })();
        return sdkCall;
      });
      await expect(
        executeQuery(connection, 'T | take 1'),
      ).rejects.toBeInstanceOf(KustoAuthenticationError);

      // The token arrives after the query gave up: the abandoned SDK call
      // rejects, and that rejection is already handled.
      releaseToken();
      await new Promise(r => setTimeout(r, 50));
      await expect(sdkCall).rejects.toMatchObject({ name: 'AbortError' });
      expect(unhandled).toEqual([]);
    } finally {
      realProcess.off('unhandledRejection', onUnhandled);
    }
  });

  test('a query that gave up does not take the shared token from another query', async () => {
    // One process credential and token cache, as in the server: the two
    // queries below wait on the SAME inner token request.
    let innerHang = false;
    let innerCalls = 0;
    const waiting: Array<(t: unknown) => void> = [];
    const cache = new CachingTokenCredential({
      getToken: () => {
        innerCalls++;
        return innerHang
          ? new Promise(resolve => waiting.push(resolve as never))
          : Promise.resolve(token());
      },
    } as never);
    const open = async (queryTimeout: number) => {
      const c = new KustoConnection(
        { authMethod: AuthenticationMethod.AzureCli, queryTimeout },
        cache,
      );
      await c.initialize('https://x.kusto.windows.net', 'd');
      return c;
    };
    const impatient = await open(30);
    const patient = await open(5000);
    spans.reset();
    // Force a refresh, and make it slow.
    cache.clear();
    innerHang = true;
    innerCalls = 0;

    const sent: string[] = [];
    const sdk = (label: string) => async (c: Credential) => {
      await c.getToken(SCOPE);
      sent.push(label);
      return rows;
    };
    execute.mockImplementationOnce(sdk('impatient'));
    const first = executeQuery(impatient, 'T | take 1').catch(e => e);
    execute.mockImplementationOnce(sdk('patient'));
    const second = executeQuery(patient, 'T | take 2');

    expect(await first).toBeInstanceOf(KustoAuthenticationError);
    expect(innerCalls).toBe(1);
    expect(waiting).toHaveLength(1);

    waiting.splice(0).forEach(resolve => resolve(token()));
    // The other query gets the shared token and runs.
    await expect(second).resolves.toBe(rows);
    await new Promise(r => setTimeout(r, 10));
    expect(sent).toEqual(['patient']);
    expect(innerCalls).toBe(1);
  });

  test('show-tables keeps the class and the fix too', async () => {
    const server = createKustoServer({
      authMethod: AuthenticationMethod.AzureCli,
    });
    const client = new Client({ name: 'unit-test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      await client.callTool({
        name: 'initialize-connection',
        arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
      });
      spans.reset();
      execute.mockRejectedValueOnce(sdkTokenError(azTimeout()));
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBe(true);
      const text = (r.content as Array<{ text: string }>)[0].text;
      expect(text).toContain('Kusto Authentication Error');
      expect(text).toContain('Azure CLI did not return a token in time');
      const tool = spans
        .getFinishedSpans()
        .find(s => s.name === 'mcp.tool/show-tables');
      expect(tool?.attributes['kustomcp.error.type']).toBe(
        'KustoAuthenticationError',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('execute-query shows the fix and keeps it out of the failure streak', async () => {
    const server = createKustoServer({
      authMethod: AuthenticationMethod.AzureCli,
    });
    const client = new Client({ name: 'unit-test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const init = await client.callTool({
        name: 'initialize-connection',
        arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
      });
      expect(init.isError).toBeFalsy();
      spans.reset();
      const texts: string[] = [];
      for (let i = 0; i < 3; i++) {
        execute.mockRejectedValueOnce(sdkTokenError(azTimeout()));
        const r = await client.callTool({
          name: 'execute-query',
          arguments: { query: 'T | where t > ago(1h) | take 1' },
        });
        expect(r.isError).toBe(true);
        texts.push((r.content as Array<{ text: string }>)[0].text);
      }
      for (const text of texts) {
        expect(text).toContain('Kusto Authentication Error');
        expect(text).toContain('Azure CLI did not return a token in time');
        expect(text).not.toContain('Narrow the time range');
        expect(text).not.toContain('Several queries failed in a row');
      }
      const tool = spans
        .getFinishedSpans()
        .filter(s => s.name === 'mcp.tool/execute-query')
        .map(s => s.attributes);
      expect(tool.map(a => a['kustomcp.error.type'])).toEqual(
        Array(3).fill('KustoAuthenticationError'),
      );
      expect(tool.map(a => a['kustomcp.session.failure_streak'])).toEqual(
        Array(3).fill('0'),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('a broken socket during a query', () => {
  test('is a network failure named AxiosError, with the network fix', async () => {
    const { attrs, thrown } = await failWith(axiosSocketError('ECONNRESET'));
    expect(attrs['kustomcp.error.type']).toBe('AxiosError');
    expect(attrs['kustomcp.query.failure_category']).toBe('network');
    expect(attrs['kustomcp.http.status_code']).toBeUndefined();
    expect(getFailureCategory(thrown)).toBe('network');
    expect(isNotQueryFault(thrown)).toBe(true);
    expect(thrown.message).toContain('read ECONNRESET');
    expect(thrown.message).toContain(
      'Network error talking to x.kusto.windows.net',
    );
  });

  test('a body cut off after HTTP 200 is a network failure with the fix', async () => {
    const { attrs, thrown } = await failWith(
      Object.assign(axiosSocketError('ECONNRESET'), {
        response: { status: 200 },
      }),
    );
    expect(attrs['kustomcp.query.failure_category']).toBe('network');
    expect(attrs['kustomcp.http.status_code']).toBe(200);
    expect(thrown.message).toContain('Network error talking to');
  });

  test('an HTTP error status carries no network code', async () => {
    const { attrs } = await failWith(
      Object.assign(new Error('x'), {
        isAxiosError: true,
        code: 'ERR_BAD_REQUEST',
        response: { status: 400 },
      }),
    );
    expect(attrs['kustomcp.error.code']).toBeUndefined();
  });

  test('errors in an HTTP 200 body get no network fix', async () => {
    const { attrs, thrown } = await failWith(
      new Error('Kusto request had errors. Query result set too large'),
    );
    expect(attrs['kustomcp.query.failure_category']).toBe('other');
    expect(thrown.message).toBe(
      'Kusto request had errors. Query result set too large',
    );
  });
});

describe('errorTypeName', () => {
  test('an axios error renamed by axios is AxiosError', () => {
    expect(errorTypeName(axiosSocketError('ECONNRESET'))).toBe('AxiosError');
  });
  test('other names are kept', () => {
    expect(errorTypeName(new Error('x'))).toBe('Error');
    expect(errorTypeName(new TypeError('x'))).toBe('TypeError');
    expect(
      errorTypeName(
        Object.assign(new Error('x'), {
          name: 'AggregateError',
          isAxiosError: true,
        }),
      ),
    ).toBe('AggregateError');
  });
});
