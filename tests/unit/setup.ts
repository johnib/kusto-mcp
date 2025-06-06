/**
 * Jest setup for unit tests
 * Configures mocks for Azure libraries and common test utilities
 */

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

  return {
    Client: MockClient,
    KustoConnectionStringBuilder: MockKustoConnectionStringBuilder,
    KustoResultTable: MockKustoResultTable,
    KustoResultColumn: MockKustoResultColumn,
  };
});

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

// Mock dotenv to prevent loading actual .env files in tests
jest.mock('dotenv', () => ({
  config: jest.fn(),
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
beforeEach(() => {
  // Clear all mocks before each test
  jest.clearAllMocks();
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
