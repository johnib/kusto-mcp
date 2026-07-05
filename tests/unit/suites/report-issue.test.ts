/**
 * report-issue Unit Tests
 * Tests the pure pre-filled GitHub issue URL builder and repo-slug derivation.
 */

import {
  buildReportIssueUrl,
  getIssueRepoSlug,
} from '../../../src/operations/github/report-issue.js';

const MAX_URL_LENGTH = 8000;

describe('report-issue URL builder', () => {
  describe('getIssueRepoSlug', () => {
    test('returns the canonical hardcoded kusto-mcp repo', () => {
      expect(getIssueRepoSlug()).toBe('johnib/kusto-mcp');
    });
  });

  describe('basic structure', () => {
    test('targets the GitHub new-issue endpoint for the derived repo', () => {
      const { url, slug } = buildReportIssueUrl({ title: 'Hello' });
      const parsed = new URL(url);

      expect(parsed.protocol).toBe('https:');
      expect(parsed.host).toBe('github.com');
      expect(parsed.pathname).toBe('/johnib/kusto-mcp/issues/new');
      expect(slug).toBe('johnib/kusto-mcp');
      expect(parsed.searchParams.get('title')).toBe('Hello');
    });
  });

  describe('encoding', () => {
    test('round-trips special characters, spaces, and newlines in the body', () => {
      const body = 'Line one\nLine two & <tag> "quote" 100% + ?done';
      const { url } = buildReportIssueUrl({ title: 'T', body });
      // Raw URL must be percent-encoded, not carry literal newlines/spaces.
      expect(url).not.toContain('\n');
      expect(url).not.toContain(' ');
      // ...but decodes back to exactly what was passed in.
      expect(new URL(url).searchParams.get('body')).toBe(body);
    });
  });

  describe('labels', () => {
    test('comma-joins labels into the labels param', () => {
      const { url } = buildReportIssueUrl({
        title: 'T',
        labels: ['bug', 'enhancement'],
      });
      expect(new URL(url).searchParams.get('labels')).toBe('bug,enhancement');
    });

    test('strips commas inside a single label so it cannot inject extra labels', () => {
      const { url } = buildReportIssueUrl({
        title: 'T',
        labels: ['needs,triage'],
      });
      expect(new URL(url).searchParams.get('labels')).toBe('needs triage');
    });

    test('drops empty/whitespace-only labels', () => {
      const { url } = buildReportIssueUrl({
        title: 'T',
        labels: ['bug', '', '  '],
      });
      expect(new URL(url).searchParams.get('labels')).toBe('bug');
    });

    test('omits the labels param entirely when there are none', () => {
      const { url } = buildReportIssueUrl({ title: 'T' });
      expect(new URL(url).searchParams.has('labels')).toBe(false);
    });
  });

  describe('diagnostics footer', () => {
    const diagnostics = {
      'kusto-mcp': '1.2.3',
      node: 'v20.0.0',
      'kusto connected': 'no',
      empty: '',
      missing: undefined,
    };

    test('appends the footer by default and reports diagnosticsIncluded', () => {
      const result = buildReportIssueUrl({
        title: 'T',
        body: 'hi',
        diagnostics,
      });
      const decoded = new URL(result.url).searchParams.get('body') ?? '';

      expect(result.diagnosticsIncluded).toBe(true);
      expect(decoded).toContain('hi');
      expect(decoded).toContain('### Environment (auto-collected)');
      expect(decoded).toContain('- kusto-mcp: 1.2.3');
      expect(decoded).toContain('- kusto connected: no');
      // Empty/undefined diagnostic values are skipped.
      expect(decoded).not.toContain('- empty:');
      expect(decoded).not.toContain('- missing:');
    });

    test('omits the footer when includeDiagnostics is false', () => {
      const result = buildReportIssueUrl({
        title: 'T',
        body: 'hi',
        diagnostics,
        includeDiagnostics: false,
      });
      const decoded = new URL(result.url).searchParams.get('body') ?? '';

      expect(result.diagnosticsIncluded).toBe(false);
      expect(decoded).toBe('hi');
    });

    test('diagnosticsIncluded is false when no diagnostics are supplied', () => {
      const result = buildReportIssueUrl({ title: 'T', body: 'hi' });
      expect(result.diagnosticsIncluded).toBe(false);
    });
  });

  describe('length budget', () => {
    test('drops diagnostics before truncating the body', () => {
      // Body fits comfortably alone, but not once a large footer is appended.
      const body = 'a'.repeat(7000);
      const diagnostics = { detail: 'd'.repeat(1500) };

      const result = buildReportIssueUrl({ title: 'T', body, diagnostics });

      expect(result.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
      expect(result.diagnosticsIncluded).toBe(false);
      expect(result.bodyTruncated).toBe(false);
      // Full body preserved, no footer.
      expect(new URL(result.url).searchParams.get('body')).toBe(body);
    });

    test('truncates an oversized body while keeping title and labels', () => {
      const body = 'x'.repeat(20000);
      const result = buildReportIssueUrl({
        title: 'Important title',
        body,
        labels: ['bug'],
        diagnostics: { node: 'v20' },
      });
      const parsed = new URL(result.url);
      const decodedBody = parsed.searchParams.get('body') ?? '';

      expect(result.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
      expect(result.bodyTruncated).toBe(true);
      expect(result.diagnosticsIncluded).toBe(false);
      expect(decodedBody).toContain('…[truncated]');
      expect(decodedBody.length).toBeLessThan(body.length);
      // Title and labels are never sacrificed.
      expect(parsed.searchParams.get('title')).toBe('Important title');
      expect(parsed.searchParams.get('labels')).toBe('bug');
    });

    test('stays within budget even when body is enormous and full of encoded chars', () => {
      const body = '\n& '.repeat(10000); // each char percent-expands
      const result = buildReportIssueUrl({ title: 'T', body });
      expect(result.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
      expect(result.bodyTruncated).toBe(true);
    });

    test('clamps an oversized title so the budget still holds', () => {
      const title = 'T'.repeat(20000);
      const result = buildReportIssueUrl({ title });
      const parsedTitle = new URL(result.url).searchParams.get('title') ?? '';

      expect(result.url.length).toBeLessThanOrEqual(MAX_URL_LENGTH);
      // Clamped to <= 256 chars and marked with an ellipsis.
      expect(parsedTitle.length).toBeLessThanOrEqual(256);
      expect(parsedTitle.endsWith('…')).toBe(true);
    });
  });
});
