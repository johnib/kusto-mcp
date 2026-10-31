/**
 * Response size limiting utilities for managing global MCP response character limits
 */

import { formatQueryResult, QueryResult } from './markdown-formatter.js';

/** The smallest global response limit, in characters. */
export const MIN_RESPONSE_LENGTH = 100;

export interface ResponseLimitOptions {
  maxLength: number;
  minRows: number;
  format: 'json' | 'markdown';
  formatOptions?: {
    maxColumnWidth?: number;
    showMetadata?: boolean;
  };
}

export interface ResponseLimitResult {
  content: string;
  optimalRowCount: number;
  wasReduced: boolean;
  originalRowCount: number;
  finalCharCount: number;
}

/** A cell's text: strings as-is, anything else as its JSON. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Cut a cell value to `maxChars`, marking how much was dropped. A cell is only
 * cut when that makes it shorter (the marker itself costs ~20 chars), so
 * smaller caps never grow the response and short values are kept intact.
 */
function truncateCell(value: unknown, maxChars: number): unknown {
  const text = cellText(value);
  if (text.length <= maxChars) return value;
  const cut = `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
  return cut.length < text.length ? cut : value;
}

/**
 * Create a response with a specific number of rows. With `maxCellChars`, every
 * cell longer than that is truncated — used when the kept rows alone overflow.
 */
function createResponseWithRowCount(
  baseResponse: QueryResult,
  rowCount: number,
  options: ResponseLimitOptions,
  maxCellChars?: number,
): string {
  let rows = baseResponse.data.slice(0, rowCount);
  let cellsTruncated = false;
  if (maxCellChars !== undefined) {
    rows = rows.map(row =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => {
          const cut = truncateCell(v, maxCellChars);
          if (cut !== v) cellsTruncated = true;
          return [k, cut];
        }),
      ),
    );
  }
  const reduced = rowCount < baseResponse.data.length || cellsTruncated;
  // Create a modified response with the specified row count
  const limitedResponse: QueryResult = {
    ...baseResponse,
    data: rows,
    metadata: {
      ...baseResponse.metadata,
      rowCount: rowCount,
      isPartial: reduced || baseResponse.metadata.isPartial,
      hasMoreResults:
        rowCount < baseResponse.data.length ||
        baseResponse.metadata.hasMoreResults,
      // Add global limiting metadata
      reducedForResponseSize: reduced,
      originalRowsAvailable: baseResponse.data.length,
      globalCharLimit: options.maxLength,
      responseCharCount: 0, // Will be updated after formatting
    },
    message: reduced
      ? [
          rowCount < baseResponse.data.length &&
            'Row count reduced to fit response size limit. Use more specific filters for larger datasets.',
          cellsTruncated &&
            'Long cell values truncated to fit response size limit. Project fewer or shorter columns (e.g. substring()) to see full values.',
        ]
          .filter(Boolean)
          .join(' ')
      : baseResponse.message,
  };

  // Format the response
  const formattedResponse = formatQueryResult(
    limitedResponse,
    options.format,
    options.formatOptions,
  );

  // Update the response character count in metadata
  // We need to parse and update the JSON response to include the actual character count
  if (options.format === 'json') {
    try {
      const parsedResponse = JSON.parse(formattedResponse);
      if (parsedResponse.metadata) {
        parsedResponse.metadata.responseCharCount = formattedResponse.length;
      }
      return JSON.stringify(parsedResponse, null, 2);
    } catch {
      // If parsing fails, return as-is
      return formattedResponse;
    }
  }

  return formattedResponse;
}

/**
 * Find the optimal number of rows that fit within the global character limit
 * Uses binary search for efficiency
 */
export function findOptimalRowCount(
  baseResponse: QueryResult,
  options: ResponseLimitOptions,
): ResponseLimitResult {
  const originalRowCount = baseResponse.data.length;

  // If no data, return as-is
  if (originalRowCount === 0) {
    const content = formatQueryResult(
      baseResponse,
      options.format,
      options.formatOptions,
    );
    return {
      content,
      optimalRowCount: 0,
      wasReduced: false,
      originalRowCount: 0,
      finalCharCount: content.length,
    };
  }

  // Start with a quick check of the full response
  const fullResponse = createResponseWithRowCount(
    baseResponse,
    originalRowCount,
    options,
  );
  if (fullResponse.length <= options.maxLength) {
    // Full response fits, no reduction needed
    return {
      content: fullResponse,
      optimalRowCount: originalRowCount,
      wasReduced: false,
      originalRowCount,
      finalCharCount: fullResponse.length,
    };
  }

  // Binary search to find optimal row count. minRows can't exceed what exists,
  // or the reported row count would claim rows that were never delivered.
  const minRows = Math.min(options.minRows, originalRowCount);
  let low = minRows;
  let high = originalRowCount;
  let bestFitRowCount = minRows;
  let bestFitContent = '';

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const testResponse = createResponseWithRowCount(baseResponse, mid, options);

    if (testResponse.length <= options.maxLength) {
      // This row count fits, try for more rows
      bestFitRowCount = mid;
      bestFitContent = testResponse;
      low = mid + 1;
    } else {
      // This row count is too large, try fewer rows
      high = mid - 1;
    }
  }

  // If we couldn't find any valid row count within limits, return minimum
  if (!bestFitContent) {
    bestFitContent = createResponseWithRowCount(baseResponse, minRows, options);
    bestFitRowCount = minRows;
  }

  // The minimum rows alone can still overflow (one huge cell). Truncate long
  // cells, binary-searching the largest per-cell length that fits.
  if (bestFitContent.length > options.maxLength) {
    let lo = 0;
    let hi = 0;
    let cellCount = 0;
    for (const row of baseResponse.data.slice(0, bestFitRowCount)) {
      for (const v of Object.values(row)) {
        hi = Math.max(hi, cellText(v).length);
        cellCount++;
      }
    }
    let fit = '';
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const test = createResponseWithRowCount(
        baseResponse,
        bestFitRowCount,
        options,
        mid,
      );
      if (test.length <= options.maxLength) {
        fit = test;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // Nothing fits: the row is wide rather than one huge cell. Give each cell
    // an equal share of the budget, so short values survive and huge ones
    // can't add up to megabytes.
    bestFitContent =
      fit ||
      createResponseWithRowCount(
        baseResponse,
        bestFitRowCount,
        options,
        Math.floor(options.maxLength / Math.max(cellCount, 1)),
      );
  }

  return {
    content: bestFitContent,
    optimalRowCount: bestFitRowCount,
    wasReduced: true,
    originalRowCount,
    finalCharCount: bestFitContent.length,
  };
}

/**
 * Apply global response size limiting to query results
 * Reduces the number of rows returned to fit within character limit
 */
export function limitResponseSize(
  baseResponse: QueryResult,
  options: ResponseLimitOptions,
): ResponseLimitResult {
  // Validate input
  if (options.maxLength < MIN_RESPONSE_LENGTH) {
    throw new Error(
      `Global response limit must be at least ${MIN_RESPONSE_LENGTH} characters`,
    );
  }

  if (options.minRows < 0) {
    throw new Error('Minimum rows must be non-negative');
  }

  // Find optimal row count using binary search
  return findOptimalRowCount(baseResponse, options);
}
