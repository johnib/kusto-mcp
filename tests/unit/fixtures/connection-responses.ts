/**
 * Mock responses for connection tests
 * These responses are recorded from actual E2E test runs with DEBUG_SERVER=1
 */

// Successful connection responses
export const showVersionResponse = {
  tables: [
    {
      name: 'Table_0',
      data: [
        {
          BuildVersion: '1.0.9278.30563',
          BuildTime: '2025-05-27T16:58:46Z',
          ServiceType: 'Engine',
          ProductVersion: '2025.05.27.1650-2521-2d9d96f-WeeklyStaging',
          ServiceOffering: '{"Type":"Azure Data Explorer"}',
        },
      ],
    },
  ],
  tableNames: ['Table_0'],
  primaryResults: [
    {
      name: 'Table_0',
      data: [
        {
          BuildVersion: '1.0.9278.30563',
          BuildTime: '2025-05-27T16:58:46Z',
          ServiceType: 'Engine',
          ProductVersion: '2025.05.27.1650-2521-2d9d96f-WeeklyStaging',
          ServiceOffering: '{"Type":"Azure Data Explorer"}',
        },
      ],
    },
  ],
  dataSetCompletion: null,
  version: '1.0',
};

export const showDatabasesValidResponse = {
  tables: [
    {
      name: 'PrimaryResult',
      data: [
        {
          DatabaseName: 'ContosoSales',
          PersistentStorage:
            'https://helpkustoragehelp01.blob.core.windows.net/09econtososalesmd202201051415255447p',
          Version: 'v310.7',
          IsCurrent: 1,
          DatabaseAccessMode: 'ReadWrite',
          PrettyName: '',
          ReservedSlot1: null,
          DatabaseId: 'ca9de742-27f2-48ed-acbb-2d20fc70253a',
          InTransitionTo: '',
          SuspensionState: '',
        },
      ],
    },
    {
      name: '@ExtendedProperties',
      data: [
        {
          Value:
            '{"Visualization":null,"Title":null,"XColumn":null,"Series":null,"YColumns":null,"AnomalyColumns":null,"XTitle":null,"YTitle":null,"XAxis":null,"YAxis":null,"Legend":null,"YSplit":null,"Accumulate":false,"IsQuerySorted":false,"Kind":null,"Ymin":"NaN","Ymax":"NaN","Xmin":null,"Xmax":null}',
        },
      ],
    },
    {
      name: 'QueryStatus',
      data: [
        {
          Timestamp: '2025-05-30T12:01:27.375Z',
          Severity: 4,
          SeverityName: 'Info',
          StatusCode: 0,
          StatusDescription: 'Query completed successfully',
          Count: 1,
          RequestId: 'dfddee27-78b9-4d95-b8a5-95b1bea565e1',
          ActivityId: 'dfddee27-78b9-4d95-b8a5-95b1bea565e1',
          SubActivityId: '7cddd500-e997-4047-9c48-4d729bc2c964',
          ClientActivityId: 'KNC.execute;0437a7f0-cdc3-4069-8647-dac5c81183d1',
        },
      ],
    },
  ],
  tableNames: ['Table_0', 'Table_1', 'Table_2', 'Table_3'],
  primaryResults: [
    {
      name: 'PrimaryResult',
      data: [
        {
          DatabaseName: 'ContosoSales',
          PersistentStorage:
            'https://helpkustoragehelp01.blob.core.windows.net/09econtososalesmd202201051415255447p',
          Version: 'v310.7',
          IsCurrent: 1,
          DatabaseAccessMode: 'ReadWrite',
          PrettyName: '',
          ReservedSlot1: null,
          DatabaseId: 'ca9de742-27f2-48ed-acbb-2d20fc70253a',
          InTransitionTo: '',
          SuspensionState: '',
        },
      ],
      _rows: [
        [
          'ContosoSales',
          'https://helpkustoragehelp01.blob.core.windows.net/09econtososalesmd202201051415255447p',
          'v310.7',
          1,
          'ReadWrite',
          '',
          null,
          'ca9de742-27f2-48ed-acbb-2d20fc70253a',
          '',
          '',
        ],
      ],
    },
  ],
  dataSetCompletion: null,
  version: '1.0',
};

export const showDatabasesEmptyResponse = {
  tables: [
    {
      name: 'PrimaryResult',
      data: [],
    },
    {
      name: '@ExtendedProperties',
      data: [
        {
          Value:
            '{"Visualization":null,"Title":null,"XColumn":null,"Series":null,"YColumns":null,"AnomalyColumns":null,"XTitle":null,"YTitle":null,"XAxis":null,"YAxis":null,"Legend":null,"YSplit":null,"Accumulate":false,"IsQuerySorted":false,"Kind":null,"Ymin":"NaN","Ymax":"NaN","Xmin":null,"Xmax":null}',
        },
      ],
    },
    {
      name: 'QueryStatus',
      data: [
        {
          Timestamp: '2025-05-30T12:02:51.360Z',
          Severity: 4,
          SeverityName: 'Info',
          StatusCode: 0,
          StatusDescription: 'Query completed successfully',
          Count: 1,
          RequestId: '3b02ce0b-ccc4-474a-814d-6d6411dd228e',
          ActivityId: '3b02ce0b-ccc4-474a-814d-6d6411dd228e',
          SubActivityId: 'e527bee1-1287-4e5e-92f2-8bafae99c2ef',
          ClientActivityId: 'KNC.execute;0878099d-7a6d-434a-8849-c99a8f43431c',
        },
      ],
    },
  ],
  tableNames: ['Table_0', 'Table_1', 'Table_2', 'Table_3'],
  primaryResults: [
    {
      name: 'PrimaryResult',
      data: [],
      _rows: [],
    },
  ],
  dataSetCompletion: null,
  version: '1.0',
};

export const showTablesResponse = {
  tables: [
    {
      name: 'Table_0',
      data: [
        {
          TableName: 'SalesFact',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Products',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Customers',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Dates',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Rate_Codes',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'TimeTable',
          DatabaseName: 'ContosoSales',
          Folder: 'Danyh',
          DocString: null,
        },
        {
          TableName: 'RLSCountries',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Events',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'SalesTable',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'DatesNew',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'NewSales',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'SalesExplore',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'dates1',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
      ],
    },
  ],
  tableNames: ['Table_0'],
  primaryResults: [
    {
      name: 'Table_0',
      data: [
        {
          TableName: 'SalesFact',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Products',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Customers',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Dates',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Rate_Codes',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'TimeTable',
          DatabaseName: 'ContosoSales',
          Folder: 'Danyh',
          DocString: null,
        },
        {
          TableName: 'RLSCountries',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'Events',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'SalesTable',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'DatesNew',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'NewSales',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'SalesExplore',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
        {
          TableName: 'dates1',
          DatabaseName: 'ContosoSales',
          Folder: null,
          DocString: null,
        },
      ],
    },
  ],
  dataSetCompletion: null,
  version: '1.0',
};

export const showFunctionsResponse = {
  tables: [
    {
      name: 'PrimaryResult',
      data: [
        {
          Name: 'SalesWithParams',
          DocString: 'Query from SalesTable with parameters',
        },
        {
          Name: 'SummarizeWithParams',
          DocString: '',
        },
        {
          Name: 'fromhelp',
          DocString: '',
        },
        {
          Name: 'AvgDailySales',
          DocString: '',
        },
        {
          Name: 'FilterColorsCities',
          DocString: '',
        },
        {
          Name: 'QuerySyslogs',
          DocString: '',
        },
        {
          Name: 'QuerySyslogs_Excel',
          DocString: '',
        },
        {
          Name: 'Hierarchy_Sales',
          DocString: '',
        },
        {
          Name: 'RandTime',
          DocString: '',
        },
        {
          Name: 'Format_Timespan',
          DocString: '',
        },
        {
          Name: 'ProductInaWeek',
          DocString: '',
        },
        {
          Name: 'DailyStatistics',
          DocString: '',
        },
        {
          Name: 'crosscluster',
          DocString: '',
        },
        {
          Name: 'SalesForDays',
          DocString: '',
        },
        {
          Name: 'format_duration',
          DocString: '',
        },
      ],
    },
    {
      name: '@ExtendedProperties',
      data: [
        {
          Value:
            '{"Visualization":null,"Title":null,"XColumn":null,"Series":null,"YColumns":null,"AnomalyColumns":null,"XTitle":null,"YTitle":null,"XAxis":null,"YAxis":null,"Legend":null,"YSplit":null,"Accumulate":false,"IsQuerySorted":false,"Kind":null,"Ymin":"NaN","Ymax":"NaN","Xmin":null,"Xmax":null}',
        },
      ],
    },
    {
      name: 'QueryStatus',
      data: [
        {
          Timestamp: '2025-05-30T12:03:45.974Z',
          Severity: 4,
          SeverityName: 'Info',
          StatusCode: 0,
          StatusDescription: 'Query completed successfully',
          Count: 1,
          RequestId: 'c904f415-a766-4001-bb5b-7a0d7859320c',
          ActivityId: 'c904f415-a766-4001-bb5b-7a0d7859320c',
          SubActivityId: '82abb630-d076-4b03-8b86-0268adbd0d12',
          ClientActivityId: 'KNC.execute;3e8a9ad9-ed56-4313-8dbb-e7166c3af307',
        },
      ],
    },
  ],
  tableNames: ['Table_0', 'Table_1', 'Table_2', 'Table_3'],
  primaryResults: [
    {
      name: 'PrimaryResult',
      data: [
        {
          Name: 'SalesWithParams',
          DocString: 'Query from SalesTable with parameters',
        },
        {
          Name: 'SummarizeWithParams',
          DocString: '',
        },
        {
          Name: 'fromhelp',
          DocString: '',
        },
        {
          Name: 'AvgDailySales',
          DocString: '',
        },
        {
          Name: 'FilterColorsCities',
          DocString: '',
        },
        {
          Name: 'QuerySyslogs',
          DocString: '',
        },
        {
          Name: 'QuerySyslogs_Excel',
          DocString: '',
        },
        {
          Name: 'Hierarchy_Sales',
          DocString: '',
        },
        {
          Name: 'RandTime',
          DocString: '',
        },
        {
          Name: 'Format_Timespan',
          DocString: '',
        },
        {
          Name: 'ProductInaWeek',
          DocString: '',
        },
        {
          Name: 'DailyStatistics',
          DocString: '',
        },
        {
          Name: 'crosscluster',
          DocString: '',
        },
        {
          Name: 'SalesForDays',
          DocString: '',
        },
        {
          Name: 'format_duration',
          DocString: '',
        },
      ],
    },
  ],
  dataSetCompletion: null,
  version: '1.0',
};

// Error responses
export const invalidClusterError = {
  message:
    'Connection error: Connection error: Query error: Failed to execute query: Failed to get cloud info for cluster https://invalid-cluster.windows.net - Error: socket hang up',
  name: 'KustoConnectionError',
  code: 'CONNECTION_ERROR',
};

export const connectionNotInitializedError = {
  message:
    'MCP error -32600: Connection not initialized. Please call initialize-connection first.',
  name: 'McpError',
  code: '-32600',
};

// Helper function to create mock Kusto responses
export const createMockResponse = (data: {
  tableName?: string;
  columns?: Array<{ columnName: string; columnType: string; dataType: string }>;
  rows?: any[][];
}) => {
  return {
    primaryResults: [
      {
        tableName: data.tableName || '',
        tableId: 0,
        tableKind: 'PrimaryResult',
        columns: data.columns || [],
        rows: data.rows || [],
        _rows: data.rows || [], // Kusto client uses _rows internally
      },
    ],
    tables: [],
  };
};
