import { MCPTestClient } from '../helpers/mcp-test-client.js';

/**
 * report-issue E2E tests.
 *
 * Unlike every other tool, report-issue must work WITHOUT a Kusto connection —
 * its primary use case is reporting a broken connection. These tests never call
 * initialize-connection.
 */
describe('Report Issue', () => {
  let client: MCPTestClient;

  beforeEach(async () => {
    client = new MCPTestClient();
    await client.startServer();
  });

  afterEach(async () => {
    if (client) {
      await client.stopServer();
    }
  });

  test('is advertised in the tools list', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain('report-issue');
  });

  test('returns a pre-filled GitHub issue URL without a connection', async () => {
    const response = await client.callTool('report-issue', {
      title: 'Cannot connect to cluster',
      body: 'initialize-connection throws AADSTS error.\nExpected it to connect.',
      labels: ['bug'],
    });

    expect(response.isError).toBeFalsy();

    const text: string = response.content[0].text;
    const match = text.match(
      /https:\/\/github\.com\/[^\s)]+\/issues\/new\?[^\s)]+/,
    );
    expect(match).not.toBeNull();

    const url = new URL(match![0]);
    expect(url.host).toBe('github.com');
    expect(url.pathname).toBe('/johnib/kusto-mcp/issues/new');
    expect(url.searchParams.get('title')).toBe('Cannot connect to cluster');
    expect(url.searchParams.get('labels')).toBe('bug');
    // Body carries the report plus the auto-collected environment footer, which
    // records that no connection was established.
    const body = url.searchParams.get('body') ?? '';
    expect(body).toContain('AADSTS');
    expect(body).toContain('### Environment (auto-collected)');
    expect(body).toContain('kusto connected: no');
  });

  test('omits the diagnostics footer when includeDiagnostics is false', async () => {
    const response = await client.callTool('report-issue', {
      title: 'Feature request',
      body: 'Please add X.',
      includeDiagnostics: false,
    });

    expect(response.isError).toBeFalsy();
    const text: string = response.content[0].text;
    const url = new URL(
      text.match(/https:\/\/github\.com\/[^\s)]+\/issues\/new\?[^\s)]+/)![0],
    );
    const body = url.searchParams.get('body') ?? '';
    expect(body).toBe('Please add X.');
    expect(body).not.toContain('### Environment');
  });

  test('rejects a call with a missing title', async () => {
    const response = await client.callTool('report-issue', {
      body: 'no title provided',
    });
    expect(response.isError).toBe(true);
  });
});
