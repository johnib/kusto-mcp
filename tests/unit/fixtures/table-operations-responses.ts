/**
 * Recorded responses from table operations E2E tests
 * These fixtures contain actual Kusto responses for mocking in unit tests
 */

// Response for show-tables operation (.show tables)
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

// Response for show-table operation (SalesFact | getschema)
export const showTableSchemaResponse = {
  tables: [
    {
      name: '@ExtendedProperties',
      data: [
        {
          TableId: 1,
          Key: 'Visualization',
          Value:
            '{"Visualization":null,"Title":null,"XColumn":null,"Series":null,"YColumns":null,"AnomalyColumns":null,"XTitle":null,"YTitle":null,"XAxis":null,"YAxis":null,"Legend":null,"YSplit":null,"Accumulate":false,"IsQuerySorted":false,"Kind":null,"Ymin":"NaN","Ymax":"NaN","Xmin":null,"Xmax":null}',
        },
      ],
    },
    {
      name: 'getschema',
      data: [
        {
          ColumnName: 'SalesAmount',
          ColumnOrdinal: 0,
          DataType: 'System.Double',
          ColumnType: 'real',
        },
        {
          ColumnName: 'TotalCost',
          ColumnOrdinal: 1,
          DataType: 'System.Double',
          ColumnType: 'real',
        },
        {
          ColumnName: 'DateKey',
          ColumnOrdinal: 2,
          DataType: 'System.DateTime',
          ColumnType: 'datetime',
        },
        {
          ColumnName: 'ProductKey',
          ColumnOrdinal: 3,
          DataType: 'System.Int64',
          ColumnType: 'long',
        },
        {
          ColumnName: 'CustomerKey',
          ColumnOrdinal: 4,
          DataType: 'System.Int64',
          ColumnType: 'long',
        },
      ],
    },
    {
      name: 'QueryCompletionInformation',
      data: [
        {
          Timestamp: '2025-05-30T12:26:25.001Z',
          ClientRequestId: 'KNC.execute;917074da-0de9-413c-95df-15e3dc4bd796',
          ActivityId: '166e6bd2-7604-4ed9-b3c3-df3951075df4',
          SubActivityId: 'e09c0483-56b3-468f-8e57-052ddd607dc3',
          ParentActivityId: 'a49cf8fb-c3e4-4652-afb9-86df16070a22',
          Level: 4,
          LevelName: 'Info',
          StatusCode: 0,
          StatusCodeName: 'S_OK (0)',
          EventType: 4,
          EventTypeName: 'QueryInfo',
          Payload: '{"Count":1,"Text":"Query completed successfully"}',
        },
      ],
    },
  ],
  tableNames: [
    '@ExtendedProperties',
    'getschema',
    'QueryCompletionInformation',
  ],
  primaryResults: [
    {
      name: 'getschema',
      data: [
        {
          ColumnName: 'SalesAmount',
          ColumnOrdinal: 0,
          DataType: 'System.Double',
          ColumnType: 'real',
        },
        {
          ColumnName: 'TotalCost',
          ColumnOrdinal: 1,
          DataType: 'System.Double',
          ColumnType: 'real',
        },
        {
          ColumnName: 'DateKey',
          ColumnOrdinal: 2,
          DataType: 'System.DateTime',
          ColumnType: 'datetime',
        },
        {
          ColumnName: 'ProductKey',
          ColumnOrdinal: 3,
          DataType: 'System.Int64',
          ColumnType: 'long',
        },
        {
          ColumnName: 'CustomerKey',
          ColumnOrdinal: 4,
          DataType: 'System.Int64',
          ColumnType: 'long',
        },
      ],
    },
  ],
  statusTable: {
    name: 'QueryCompletionInformation',
    data: [
      {
        Timestamp: '2025-05-30T12:26:25.001Z',
        ClientRequestId: 'KNC.execute;917074da-0de9-413c-95df-15e3dc4bd796',
        ActivityId: '166e6bd2-7604-4ed9-b3c3-df3951075df4',
        SubActivityId: 'e09c0483-56b3-468f-8e57-052ddd607dc3',
        ParentActivityId: 'a49cf8fb-c3e4-4652-afb9-86df16070a22',
        Level: 4,
        LevelName: 'Info',
        StatusCode: 0,
        StatusCodeName: 'S_OK (0)',
        EventType: 4,
        EventTypeName: 'QueryInfo',
        Payload: '{"Count":1,"Text":"Query completed successfully"}',
      },
    ],
  },
  dataSetHeader: {
    FrameType: 'DataSetHeader',
    IsProgressive: false,
    Version: 'v2.0',
    IsFragmented: false,
    ErrorReportingPlacement: 'InData',
  },
  dataSetCompletion: {
    FrameType: 'DataSetCompletion',
    HasErrors: false,
    Cancelled: false,
  },
  version: '2.0',
};

// Mock response structure that matches what our code expects (processed through KustoConnection)
export const showTablesProcessedResponse = {
  primaryResults: [
    {
      name: 'Table_0',
      _rows: [
        ['SalesFact', 'ContosoSales', null, null],
        ['Products', 'ContosoSales', null, null],
        ['Customers', 'ContosoSales', null, null],
        ['Dates', 'ContosoSales', null, null],
        ['Rate_Codes', 'ContosoSales', null, null],
        ['TimeTable', 'ContosoSales', 'Danyh', null],
        ['RLSCountries', 'ContosoSales', null, null],
        ['Events', 'ContosoSales', null, null],
        ['SalesTable', 'ContosoSales', null, null],
        ['DatesNew', 'ContosoSales', null, null],
        ['NewSales', 'ContosoSales', null, null],
        ['SalesExplore', 'ContosoSales', null, null],
        ['dates1', 'ContosoSales', null, null],
      ],
    },
  ],
  tables: [],
};

export const showTableSchemaProcessedResponse = {
  primaryResults: [
    {
      name: 'getschema',
      _rows: [
        ['SalesAmount', 0, 'System.Double', 'real'],
        ['TotalCost', 1, 'System.Double', 'real'],
        ['DateKey', 2, 'System.DateTime', 'datetime'],
        ['ProductKey', 3, 'System.Int64', 'long'],
        ['CustomerKey', 4, 'System.Int64', 'long'],
      ],
    },
  ],
  tables: [],
};

// Error simulation for non-existent tables and empty table names
export const createTableErrorResponse = (message: string) => {
  const error = new Error(
    `Query error: Failed to get table schema: Query error: ${message}`,
  );
  error.name = 'KustoQueryError';
  return error;
};

export const nonExistentTableError = createTableErrorResponse(
  'Failed to execute query: Request failed with status code 400',
);
export const emptyTableNameError = createTableErrorResponse(
  'Failed to execute query: Request failed with status code 400',
);
