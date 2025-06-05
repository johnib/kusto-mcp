/**
 * Utilities for formatting query results as markdown tables
 */

import { markdownTable } from 'markdown-table';

export interface QueryResult {
  name?: string;
  data: Array<Record<string, unknown>>;
  metadata: {
    rowCount: number;
    isPartial: boolean;
    requestedLimit: number;
    hasMoreResults: boolean;
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
function formatCellValue(value: unknown, maxWidth?: number): string {
  let formattedValue: string;

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    formattedValue = value.replace(/\n/g, ' ').trim();
  } else if (typeof value === 'number') {
    formattedValue = value.toString();
  } else if (typeof value === 'boolean') {
    formattedValue = value ? 'true' : 'false';
  } else if (value instanceof Date) {
    formattedValue = value.toISOString();
  } else {
    // For objects, arrays, etc., convert to string
    formattedValue = String(value).replace(/\n/g, ' ').trim();
  }

  // Apply max width truncation if specified
  if (maxWidth && formattedValue.length > maxWidth) {
    formattedValue = formattedValue.substring(0, maxWidth - 3) + '...';
  }

  return formattedValue;
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

  // Prepare table data: header row + data rows
  const tableData = [
    columns, // Header row
    ...data.map(row =>
      columns.map(col => formatCellValue(row[col], maxColumnWidth)),
    ),
  ];

  // Generate the markdown table using the library with default alignment
  const table = markdownTable(tableData, {
    padding: true,
    alignDelimiters: true,
  });

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
