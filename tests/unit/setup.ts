/**
 * Jest setup for unit tests
 * Configures mocks for Azure libraries and common test utilities
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock azure-kusto-data before any imports
jest.mock('azure-kusto-data', () => {
  class MockClient {
    private clusterUrl: string;
    public executeQuery: jest.MockedFunction<any>;

    constructor(clusterUrl: string) {
      this.clusterUrl = clusterUrl;
      this.executeQuery = jest.fn();
    }

    async execute(database: string, query: string, properties?: any) {
      return this.executeQuery(database, query, properties);
    }
  }

  class MockKustoConnectionStringBuilder {
    private connectionString: string;

    constructor(connectionString: string) {
      this.connectionString = connectionString;
    }

    static withAzLoginIdentity(clusterUrl: string) {
      return new MockKustoConnectionStringBuilder(
        `Data Source=${clusterUrl};Fed=True;`,
      );
    }

    static withTokenCredential(clusterUrl: string) {
      return new MockKustoConnectionStringBuilder(
        `Data Source=${clusterUrl};Fed=True;`,
      );
    }

    static withAadApplicationKeyAuthentication(
      clusterUrl: string,
      clientId: string,
      clientSecret: string,
      authorityId: string,
    ) {
      return new MockKustoConnectionStringBuilder(
        `Data Source=${clusterUrl};Application Client Id=${clientId};Application Key=${clientSecret};Authority Id=${authorityId};`,
      );
    }

    static withAadManagedIdentity(clusterUrl: string, clientId?: string) {
      const msiPart = clientId ? `;MSI Client Id=${clientId}` : '';
      return new MockKustoConnectionStringBuilder(
        `Data Source=${clusterUrl};MSI=True${msiPart};`,
      );
    }

    toString() {
      return this.connectionString;
    }
  }

  class MockKustoResultTable {
    public tableName: string;
    public tableId: number;
    public tableKind: string;
    public columns: any[];
    public rows: any[][];

    constructor(data: any) {
      this.tableName = data.tableName || '';
      this.tableId = data.tableId || 0;
      this.tableKind = data.tableKind || '';
      this.columns = data.columns || [];
      this.rows = data.rows || [];
    }
  }

  class MockKustoResultColumn {
    public columnName: string;
    public columnType: string;
    public dataType: string;

    constructor(name: string, type: string, dataType: string) {
      this.columnName = name;
      this.columnType = type;
      this.dataType = dataType;
    }
  }

  class MockClientRequestProperties {
    private clientTimeout?: number;
    setTimeout() {
      /* no-op for tests */
    }
    setClientTimeout(timeoutMillis: number) {
      this.clientTimeout = timeoutMillis;
    }
    getClientTimeout() {
      return this.clientTimeout;
    }
    setOption() {
      /* no-op for tests */
    }
    toJSON() {
      return {};
    }
  }

  return {
    Client: MockClient,
    KustoConnectionStringBuilder: MockKustoConnectionStringBuilder,
    KustoResultTable: MockKustoResultTable,
    KustoResultColumn: MockKustoResultColumn,
    ClientRequestProperties: MockClientRequestProperties,
  };
});

// Keep unit tests off the network: the post-failure reachability probe
// (#315) would otherwise open real sockets. connection-probe.test.ts tests the
// real one via jest.requireActual.
jest.mock('../../src/common/connection-hints.js', () => ({
  ...jest.requireActual('../../src/common/connection-hints.js'),
  probeReachability: jest.fn(async () => undefined),
}));

// Mock @azure/identity before any imports
jest.mock('@azure/identity', () => {
  class MockAzureCliCredential {
    constructor() {
      // Mock constructor
    }

    async getToken(scopes: string | string[], options?: any) {
      return {
        token: 'mock-token',
        expiresOnTimestamp: Date.now() + 3600000, // 1 hour from now
      };
    }
  }

  class MockDefaultAzureCredential {
    constructor() {
      // Mock constructor
    }

    async getToken(scopes: string | string[], options?: any) {
      return {
        token: 'mock-default-token',
        expiresOnTimestamp: Date.now() + 3600000, // 1 hour from now
      };
    }
  }

  class MockManagedIdentityCredential {
    constructor() {
      // Mock constructor
    }

    async getToken(scopes: string | string[], options?: any) {
      return {
        token: 'mock-managed-identity-token',
        expiresOnTimestamp: Date.now() + 3600000,
      };
    }
  }

  class MockInteractiveBrowserCredential {
    constructor() {
      // Mock constructor
    }

    async getToken(scopes: string | string[], options?: any) {
      return {
        token: 'mock-interactive-token',
        expiresOnTimestamp: Date.now() + 3600000,
      };
    }
  }

  return {
    AzureCliCredential: MockAzureCliCredential,
    DefaultAzureCredential: MockDefaultAzureCredential,
    ManagedIdentityCredential: MockManagedIdentityCredential,
    InteractiveBrowserCredential: MockInteractiveBrowserCredential,
  };
});

// Our own az runner (#346) would spawn a real `az`. Keep it mocked like the
// SDK credentials above; az-cli-credential.test.ts tests the real one.
jest.mock('../../src/auth/az-cli-credential.js', () => ({
  ...jest.requireActual('../../src/auth/az-cli-credential.js'),
  AzCliCredential: class {
    async getToken() {
      return {
        token: 'mock-token',
        expiresOnTimestamp: Date.now() + 3600000,
      };
    }
  },
}));

// Mock markdown-table module to handle ES module import issues
jest.mock('markdown-table', () => ({
  markdownTable: jest.fn((table, options) => {
    if (!table || table.length === 0) {
      return '';
    }

    // Simple table formatting for testing
    const headers = table[0];
    const rows = table.slice(1);

    let result = '| ' + headers.join(' | ') + ' |\n';
    result += '|' + headers.map(() => '---').join('|') + '|\n';

    for (const row of rows) {
      result += '| ' + row.join(' | ') + ' |\n';
    }

    return result;
  }),
}));

// Global test configuration
// Give every test its own empty per-install state dir (machine_id, auto-connect
// backoff) so tests never touch the real home dir or leak backoff state into
// each other.
let stateHome: string | undefined;
const prevStateEnv = {
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
};

beforeEach(() => {
  // Clear all mocks before each test
  jest.clearAllMocks();
  stateHome = mkdtempSync(join(tmpdir(), 'kusto-mcp-state-'));
  process.env.XDG_DATA_HOME = stateHome;
  process.env.LOCALAPPDATA = stateHome;
});

afterEach(() => {
  for (const [k, v] of Object.entries(prevStateEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (stateHome) rmSync(stateHome, { recursive: true, force: true });
});

// Global test utilities
export const createMockKustoResponse = (data: {
  tableName?: string;
  columns?: Array<{ columnName: string; columnType: string; dataType: string }>;
  rows?: any[][];
}) => {
  // Create mock response using the same structure as the mocked KustoResultTable
  const mockTable = {
    tableName: data.tableName || 'MockTable',
    tableId: 0,
    tableKind: 'PrimaryResult',
    columns: data.columns || [
      {
        columnName: 'Column1',
        columnType: 'string',
        dataType: 'System.String',
      },
    ],
    rows: data.rows || [['mock-data']],
  };

  return {
    primaryResults: [mockTable],
    tables: [],
  };
};

export const createMockError = (message: string, code?: string) => {
  const error = new Error(message);
  if (code) {
    (error as any).code = code;
  }
  return error;
};
