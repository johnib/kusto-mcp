/**
 * #299 — showTable / showFunctions / showFunction share one lookup for the
 * data-bearing primary result. It must skip metadata tables ('@...' and
 * 'QueryStatus') that carry rows, and fall back to the first result when no
 * result has rows.
 */

import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import {
  showFunction,
  showFunctions,
  showTable,
} from '../../../src/operations/kusto/tables.js';

const connectionReturning = (result: unknown) =>
  ({
    isInitialized: jest.fn().mockReturnValue(true),
    getDatabase: jest.fn().mockReturnValue('db'),
    executeQuery: jest.fn().mockResolvedValue(result),
  }) as unknown as KustoConnection;

const metadataFirst = (rows: unknown[][]) => ({
  tables: [],
  primaryResults: [
    { name: '@ExtendedProperties', data: [], _rows: [['meta', 'x', 'y', 'z']] },
    { name: 'QueryStatus', data: [], _rows: [['status', 'x', 'y', 'z']] },
    { name: 'PrimaryResult', data: [], _rows: rows },
  ],
});

describe('primary result selection', () => {
  test('showTable skips metadata results that have rows', async () => {
    const schema = await showTable(
      connectionReturning(
        metadataFirst([['Col1', 0, 'System.String', 'string']]),
      ),
      'T',
    );
    expect(schema.columns).toEqual([
      { name: 'Col1', type: 'string', ordinal: 0, isNullable: true },
    ]);
  });

  test('showFunctions skips metadata results that have rows', async () => {
    const fns = await showFunctions(
      connectionReturning(metadataFirst([['F1', 'doc']])),
    );
    expect(fns).toEqual([{ Name: 'F1', DocString: 'doc' }]);
  });

  test('showFunction skips metadata results that have rows', async () => {
    const fn = await showFunction(
      connectionReturning(metadataFirst([['F1', '()', '{ T }', '', 'doc']])),
      'F1',
    );
    expect(fn.Name).toBe('F1');
    expect(fn.Body).toBe('{ T }');
  });

  test('falls back to the first result when none has rows', async () => {
    const fns = await showFunctions(
      connectionReturning({
        tables: [],
        primaryResults: [
          { name: 'PrimaryResult', data: [], _rows: [] },
          // No row arrays: a pick of this result throws "No primary result with data".
          { name: 'Other' },
        ],
      }),
    );
    expect(fns).toEqual([]);
  });
});
