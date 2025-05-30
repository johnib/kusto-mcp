/**
 * Function Operations Test Fixtures
 * Recorded responses from E2E tests for use in unit tests
 */

// Response for successful function listing
export const functionListResponse = {
  primaryResults: [
    {
      name: 'PrimaryResult',
      _rows: [
        ['SalesWithParams', 'Query from SalesTable with parameters'],
        ['SummarizeWithParams', ''],
        ['fromhelp', ''],
        ['AvgDailySales', ''],
        ['FilterColorsCities', ''],
        ['QuerySyslogs', ''],
        ['QuerySyslogs_Excel', ''],
        ['Hierarchy_Sales', ''],
        ['RandTime', ''],
        ['Format_Timespan', ''],
        ['ProductInaWeek', ''],
        ['DailyStatistics', ''],
        ['crosscluster', ''],
        ['SalesForDays', ''],
        ['format_duration', ''],
      ],
    },
  ],
  tables: [],
};

// Response for successful function details
export const functionDetailsResponse = {
  primaryResults: [
    {
      name: 'Table_0',
      _rows: [
        [
          'SalesWithParams',
          '(Countries:dynamic, States:dynamic, Cities:dynamic, Colors:dynamic, ClassNames:dynamic)',
          '{\r\n    SalesTable\r\n    | where Country in(Countries) or "__SelectAll__" in(Countries)\r\n    | where City in(Cities) or "__SelectAll__" in(Cities)\r\n    | where State in(States) or "__SelectAll__" in(States)\r\n    | where ColorName in(Colors) or "__SelectAll__" in(Colors)\r\n    | where ClassName in(ClassNames) or "__SelectAll__" in(ClassNames)\r\n}',
          null,
          'Query from SalesTable with parameters',
        ],
      ],
    },
  ],
  tables: [],
};

// Mock error for non-existent function
export const nonExistentFunctionError = new Error(
  'Query error: Failed to get function details: Query error: Failed to execute query: Request failed with status code 400',
);

// Mock error for empty function name
export const emptyFunctionNameError = new Error(
  'Query error: Failed to get function details: Query error: Failed to execute query: Request failed with status code 400',
);

// Function list for testing metadata
export const functionList = [
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
];

// Function details for metadata testing
export const functionDetails = {
  Name: 'SalesWithParams',
  Parameters:
    '(Countries:dynamic, States:dynamic, Cities:dynamic, Colors:dynamic, ClassNames:dynamic)',
  Body: '{\r\n    SalesTable\r\n    | where Country in(Countries) or "__SelectAll__" in(Countries)\r\n    | where City in(Cities) or "__SelectAll__" in(Cities)\r\n    | where State in(States) or "__SelectAll__" in(States)\r\n    | where ColorName in(Colors) or "__SelectAll__" in(Colors)\r\n    | where ClassName in(ClassNames) or "__SelectAll__" in(ClassNames)\r\n}',
  Folder: '',
  DocString: 'Query from SalesTable with parameters',
};

// Alternative function details for consistency testing
export const alternativeFunctionDetails = {
  Name: 'AvgDailySales',
  Parameters: '(startDate:datetime, endDate:datetime)',
  Body: '{\r\n    SalesTable\r\n    | where Date between(startDate .. endDate)\r\n    | summarize AvgSales = avg(Sales) by Date\r\n}',
  Folder: '',
  DocString: '',
};

// Empty function list for testing edge cases
export const emptyFunctionListResponse = {
  primaryResults: [
    {
      name: 'PrimaryResult',
      _rows: [],
    },
  ],
  tables: [],
};

// Error response structure for tool calls
export const errorToolResponse = {
  isError: true,
  content: [
    {
      type: 'text',
      text: 'Kusto Query Error: Query error: Failed to get function details: Query error: Failed to execute query: Request failed with status code 400',
    },
  ],
};

// Success response structure for function list tool calls
export const successFunctionListToolResponse = {
  content: [
    {
      type: 'text',
      text: JSON.stringify(functionList, null, 2),
    },
  ],
};

// Success response structure for function details tool calls
export const successFunctionDetailsToolResponse = {
  content: [
    {
      type: 'text',
      text: JSON.stringify(functionDetails, null, 2),
    },
  ],
};
