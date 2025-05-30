/**
 * Mock responses for query execution tests
 * These responses are recorded from actual E2E test runs with DEBUG_SERVER=1
 */

// Table listing response (used for getting available table name)
export const tablesListResponse = {
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
        // Additional tables truncated for brevity in this fixture
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
      ],
      _rows: [
        ['SalesFact', 'ContosoSales', null, null],
        ['Products', 'ContosoSales', null, null],
      ],
    },
  ],
  dataSetCompletion: null,
  version: '1.0',
};

// Will be populated with recorded responses for each test
export const queryExecutionResponses = {
  // Test 1: Simple table query with take limit
  simpleTableQuery: {
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
        name: 'PrimaryResult',
        data: [
          {
            SalesAmount: 92.9907,
            TotalCost: 50.98,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2023,
            CustomerKey: 15857,
          },
          {
            SalesAmount: 92.9907,
            TotalCost: 50.98,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2023,
            CustomerKey: 15858,
          },
          {
            SalesAmount: 92.9907,
            TotalCost: 50.98,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2023,
            CustomerKey: 15860,
          },
          {
            SalesAmount: 185.9907,
            TotalCost: 101.96,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2402,
            CustomerKey: 9798,
          },
          {
            SalesAmount: 185.9907,
            TotalCost: 101.96,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2402,
            CustomerKey: 9799,
          },
        ],
      },
    ],
    tableNames: [
      '@ExtendedProperties',
      'PrimaryResult',
      'QueryCompletionInformation',
    ],
    primaryResults: [
      {
        name: 'PrimaryResult',
        data: [
          {
            SalesAmount: 92.9907,
            TotalCost: 50.98,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2023,
            CustomerKey: 15857,
          },
          {
            SalesAmount: 92.9907,
            TotalCost: 50.98,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2023,
            CustomerKey: 15858,
          },
          {
            SalesAmount: 92.9907,
            TotalCost: 50.98,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2023,
            CustomerKey: 15860,
          },
          {
            SalesAmount: 185.9907,
            TotalCost: 101.96,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2402,
            CustomerKey: 9798,
          },
          {
            SalesAmount: 185.9907,
            TotalCost: 101.96,
            DateKey: '2007-04-03T00:00:00.000Z',
            ProductKey: 2402,
            CustomerKey: 9799,
          },
        ],
        _rows: [
          [92.9907, 50.98, '2007-04-03T00:00:00Z', 2023, 15857],
          [92.9907, 50.98, '2007-04-03T00:00:00Z', 2023, 15858],
          [92.9907, 50.98, '2007-04-03T00:00:00Z', 2023, 15860],
          [185.9907, 101.96, '2007-04-03T00:00:00Z', 2402, 9798],
          [185.9907, 101.96, '2007-04-03T00:00:00Z', 2402, 9799],
        ],
      },
    ],
    dataSetCompletion: {
      FrameType: 'DataSetCompletion',
      HasErrors: false,
      Cancelled: false,
    },
    version: '2.0',
  },

  // Test 2: Count query and return single row
  countQuery: {
    // TO BE RECORDED
  },

  // Test 3: Management command: .show tables
  showTablesCommand: {
    // TO BE RECORDED
  },

  // Test 4: Aggregation query
  aggregationQuery: {
    // TO BE RECORDED
  },

  // Test 5: Result limiting correctly
  resultLimitingQuery: {
    // TO BE RECORDED
  },

  // Test 6: Detect partial results and set metadata correctly
  partialResultsQuery: {
    // TO BE RECORDED
  },

  // Test 7: Queries that return no results
  noResultsQuery: {
    // TO BE RECORDED
  },

  // Test 8: Time-based queries with ago() function
  schemaCheckQuery: {
    // TO BE RECORDED - for checking datetime columns
  },
  timeBasedQuery: {
    // TO BE RECORDED - for actual time query
  },

  // Test 9: Complex aggregation with grouping
  complexAggregationQuery: {
    // TO BE RECORDED
  },

  // Test 10: Default limit when not specified
  defaultLimitQuery: {
    // TO BE RECORDED
  },

  // Test 11: Schema exploration queries
  schemaExplorationQuery: {
    // TO BE RECORDED
  },

  // Test 12: Preserve column types in query results
  columnTypesQuery: {
    // TO BE RECORDED
  },
};
