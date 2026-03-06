/**
 * Utilities for formatting query results as markdown tables
 */

import { markdownTable } from 'markdown-table';

/**
 * Options for markdown table generation
 */
interface MarkdownTableLibraryOptions {
  padding?: boolean;
  alignDelimiters?: boolean;
  stringLength?: (str: string) => number;
}

export interface QueryResult {
  name?: string;
  data: Array<Record<string, unknown>>;
  metadata: {
    rowCount: number;
    isPartial: boolean;
    requestedLimit: number;
    hasMoreResults: boolean;
    // Global response limiting metadata
    reducedForResponseSize?: boolean;
    originalRowsAvailable?: number;
    globalCharLimit?: number;
    responseCharCount?: number;
    // Query statistics metadata
    queryStatistics?: {
      totalCpu?: string;
      executionTime?: string;
      extentsTotal?: number;
      extentsScanned?: number;
      resourceUsage?: Record<string, unknown>;
    };
  };
  message?: string;
}

export interface MarkdownTableOptions {
  maxColumnWidth?: number;
  showMetadata?: boolean;
}

/**
 * Format a value for display in a markdown table cell
 */
function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value.replace(/\n/g, ' ').trim();
  } else if (typeof value === 'number') {
    return value.toString();
  } else if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  } else if (value instanceof Date) {
    return value.toISOString();
  } else {
    // For objects, arrays, etc., convert to JSON string
    try {
      return JSON.stringify(value).replace(/\n/g, ' ').trim();
    } catch {
      // Fallback for non-serializable objects (circular refs, etc.)
      return String(value).replace(/\n/g, ' ').trim();
    }
  }
}

/**
 * Truncate a string to a maximum length with ellipsis
 */
function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength - 3) + '...';
}

/**
 * Create a stringLength function for markdown-table that handles truncation
 */
function createStringLengthWithLimit(maxLength: number) {
  return (str: string): number => {
    if (str.length <= maxLength) {
      return str.length;
    }
    // Return length of truncated string including ellipsis
    return maxLength;
  };
}

/**
 * Generate metadata summary section
 */
function generateMetadataSummary(
  metadata: QueryResult['metadata'],
  message?: string,
): string {
  const summary = [
    `**Query Results Summary:**`,
    `- Rows returned: ${metadata.rowCount}`,
    `- Total limit: ${metadata.requestedLimit}`,
    `- Partial results: ${metadata.isPartial ? 'Yes' : 'No'}`,
    `- Has more results: ${metadata.hasMoreResults ? 'Yes' : 'No'}`,
  ];

  // Add global response limiting information if available
  if (metadata.reducedForResponseSize) {
    summary.push(`- Reduced for response size: Yes`);
    if (metadata.originalRowsAvailable) {
      summary.push(
        `- Original rows available: ${metadata.originalRowsAvailable}`,
      );
    }
  }

  if (metadata.responseCharCount && metadata.globalCharLimit) {
    summary.push(
      `- Response size: ${metadata.responseCharCount} / ${metadata.globalCharLimit} chars`,
    );
  }

  // Add query statistics if available
  if (metadata.queryStatistics) {
    summary.push(`**Query Performance:**`);
    if (metadata.queryStatistics.totalCpu) {
      summary.push(`- Total CPU: ${metadata.queryStatistics.totalCpu}`);
    }
    if (metadata.queryStatistics.executionTime) {
      summary.push(
        `- Execution time: ${metadata.queryStatistics.executionTime}`,
      );
    }
    if (metadata.queryStatistics.extentsTotal !== undefined) {
      summary.push(`- Extents total: ${metadata.queryStatistics.extentsTotal}`);
    }
    if (metadata.queryStatistics.extentsScanned !== undefined) {
      summary.push(
        `- Extents scanned: ${metadata.queryStatistics.extentsScanned}`,
      );
    }
  }

  if (message) {
    summary.push(`- Note: ${message}`);
  }

  return summary.join('\n');
}

/**
 * Convert query result to markdown table format using markdown-table library
 */
export function formatAsMarkdownTable(
  result: QueryResult,
  options: MarkdownTableOptions = {},
): string {
  const { data, metadata, message } = result;
  const { maxColumnWidth, showMetadata = true } = options;

  // Handle empty results
  if (!data || data.length === 0) {
    const metadataSection = showMetadata
      ? `\n\n${generateMetadataSummary(metadata, message)}`
      : '';
    return `*No results returned*${metadataSection}`;
  }

  // Extract column names from the first row
  const columns = Object.keys(data[0]);

  // Handle case where there are no columns
  if (columns.length === 0) {
    const metadataSection = showMetadata
      ? `\n\n${generateMetadataSummary(metadata, message)}`
      : '';
    return `*No columns found in results*${metadataSection}`;
  }

  // Prepare table data with truncation: header row + data rows
  const tableData = [
    columns, // Header row (no truncation needed)
    ...data.map(row =>
      columns.map(col => {
        const value = formatCellValue(row[col]);
        return maxColumnWidth ? truncateString(value, maxColumnWidth) : value;
      }),
    ),
  ];

  // Generate the markdown table using the library with stringLength option
  const markdownOptions: MarkdownTableLibraryOptions = {
    padding: true,
    alignDelimiters: true,
  };

  // Add stringLength function if maxColumnWidth is specified
  if (maxColumnWidth) {
    markdownOptions.stringLength = createStringLengthWithLimit(maxColumnWidth);
  }

  const table = markdownTable(tableData, markdownOptions);

  // Add metadata summary if requested
  const metadataSection = showMetadata
    ? `\n\n${generateMetadataSummary(metadata, message)}`
    : '';

  return `${table}${metadataSection}`;
}

/**
 * Format query result based on the specified format
 */
export function formatQueryResult(
  result: QueryResult,
  format: 'json' | 'markdown',
  options?: MarkdownTableOptions,
): string {
  if (format === 'markdown') {
    return formatAsMarkdownTable(result, options);
  }

  // Default to JSON format
  return JSON.stringify(result, null, 2);
}
