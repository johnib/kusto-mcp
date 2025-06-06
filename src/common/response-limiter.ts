/**
 * Response size limiting utilities for managing global MCP response character limits
 */

import { formatQueryResult, QueryResult } from './markdown-formatter.js';

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

/**
 * Create a response with a specific number of rows
 */
function createResponseWithRowCount(
  baseResponse: QueryResult,
  rowCount: number,
  options: ResponseLimitOptions,
): string {
  // Create a modified response with the specified row count
  const limitedResponse: QueryResult = {
    ...baseResponse,
    data: baseResponse.data.slice(0, rowCount),
    metadata: {
      ...baseResponse.metadata,
      rowCount: rowCount,
      isPartial:
        rowCount < baseResponse.data.length || baseResponse.metadata.isPartial,
      hasMoreResults:
        rowCount < baseResponse.data.length ||
        baseResponse.metadata.hasMoreResults,
      // Add global limiting metadata
      reducedForResponseSize: rowCount < baseResponse.data.length,
      originalRowsAvailable: baseResponse.data.length,
      globalCharLimit: options.maxLength,
      responseCharCount: 0, // Will be updated after formatting
    },
    message:
      rowCount < baseResponse.data.length
        ? 'Row count reduced to fit response size limit. Use more specific filters for larger datasets.'
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

  // Binary search to find optimal row count
  let low = options.minRows;
  let high = originalRowCount;
  let bestFitRowCount = options.minRows;
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
    bestFitContent = createResponseWithRowCount(
      baseResponse,
      options.minRows,
      options,
    );
    bestFitRowCount = options.minRows;
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
  if (options.maxLength < 100) {
    throw new Error('Global response limit must be at least 100 characters');
  }

  if (options.minRows < 0) {
    throw new Error('Minimum rows must be non-negative');
  }

  // Find optimal row count using binary search
  return findOptimalRowCount(baseResponse, options);
}
