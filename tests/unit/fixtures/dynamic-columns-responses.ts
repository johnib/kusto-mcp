/**
 * Dynamic Column Test Fixtures
 * Raw results shaped like azure-kusto-data returns them for Kusto `dynamic`
 * columns: `_rows` hold the already-parsed JSON values (objects, arrays, null).
 */

import type { KustoQueryResult } from '../../../src/types/kusto-interfaces.js';

// Rows live in `_rows`, as azure-kusto-data populates them; src reads `_rows`
// with `columns`, so the type-required `data` is left empty.

export const dynamicColumnNames = [
  'Obj',
  'Arr',
  'Nul',
  'EmptyObj',
  'EmptyArr',
] as const;

/** One row per dynamic shape: nested object, mixed array, null, {}, []. */
export const dynamicRowValues = (): unknown[] => [
  { a: 1, b: { c: [1, 2] } },
  [1, 'x', null],
  null,
  {},
  [],
];

export const dynamicValuesResponse = (): KustoQueryResult =>
  ({
    primaryResults: [
      {
        name: 'PrimaryResult',
        data: [],
        _rows: [dynamicRowValues()],
        columns: dynamicColumnNames.map(ColumnName => ({ ColumnName })),
      },
    ],
    tables: [],
  }) satisfies KustoQueryResult;

/** A dynamic value whose string content carries a pipe and a newline. */
export const pipeAndNewlineResponse = {
  primaryResults: [
    {
      name: 'PrimaryResult',
      data: [],
      _rows: [[{ s: 'x|y\nz' }, 1]],
      columns: [{ ColumnName: 'Payload' }, { ColumnName: 'Id' }],
    },
  ],
  tables: [],
} satisfies KustoQueryResult;

/** ~20k-char dynamic cell, well over the 12000-char response cap on its own. */
export const HUGE_PAYLOAD_LENGTH = 20000;

const smallRow = (id: number): unknown[] => [id, { tag: `t${id}`, n: [id] }];
const hugeRow = (id: number): unknown[] => [
  id,
  { blob: 'x'.repeat(HUGE_PAYLOAD_LENGTH) },
];

const oversizedResponse = (rows: unknown[][]): KustoQueryResult =>
  ({
    primaryResults: [
      {
        name: 'PrimaryResult',
        data: [],
        _rows: rows,
        columns: [{ ColumnName: 'Id' }, { ColumnName: 'Props' }],
      },
    ],
    tables: [],
  }) satisfies KustoQueryResult;

/** Five small rows, then the huge row, then two more small rows. */
export const hugeCellAfterSmallRowsResponse = (): KustoQueryResult =>
  oversizedResponse([
    smallRow(1),
    smallRow(2),
    smallRow(3),
    smallRow(4),
    smallRow(5),
    hugeRow(6),
    smallRow(7),
    smallRow(8),
  ]);

/** The huge row first, so even the one-row minimum exceeds the cap. */
export const hugeCellFirstResponse = (): KustoQueryResult =>
  oversizedResponse([hugeRow(1), smallRow(2), smallRow(3), smallRow(4)]);
