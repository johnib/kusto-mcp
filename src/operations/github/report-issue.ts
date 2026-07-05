/**
 * GitHub issue reporting via a pre-filled "new issue" URL.
 *
 * The server never creates an issue itself and never holds a GitHub token: it
 * builds a `https://github.com/<owner>/<repo>/issues/new?title=…&body=…` link
 * that the user opens in a browser where they are already signed in to GitHub,
 * reviews, and submits under their own account. This works even when the MCP
 * runtime has no GitHub account, `gh` CLI, or session — the write happens in
 * the user's browser, not here.
 */

/**
 * Target repository (owner/repo) for filed issues. Kept as a constant (rather
 * than read from package.json via `import.meta`) so the module loads cleanly
 * under the CommonJS-compiled unit test runner. Forks change this one line.
 */
const DEFAULT_SLUG = 'johnib/kusto-mcp';

/**
 * Practical cap on the whole issue URL. GitHub rejects excessively long URLs
 * (HTTP 414); ~8k keeps us comfortably under real-world limits while leaving
 * room for the title and labels.
 */
const MAX_URL_LENGTH = 8000;

/**
 * GitHub caps issue titles at 256 characters. Clamp to the same bound so the
 * "title is always preserved" invariant can't itself push the URL over
 * {@link MAX_URL_LENGTH}.
 */
const MAX_TITLE_LENGTH = 256;

const TRUNCATION_MARKER = '\n\n…[truncated]';

export interface BuildReportIssueUrlOptions {
  /** Issue title (required). */
  title: string;
  /** Freeform issue body (Markdown). */
  body?: string;
  /** Labels to pre-select, e.g. ['bug']. Commas inside a label are stripped. */
  labels?: string[];
  /**
   * Non-sensitive environment info appended as a footer when
   * `includeDiagnostics` is not false. Values that are undefined/null/empty are
   * skipped.
   */
  diagnostics?: Record<string, string | number | boolean | undefined>;
  /** Append the diagnostics footer. Defaults to true. */
  includeDiagnostics?: boolean;
}

export interface ReportIssueResult {
  /** The pre-filled GitHub new-issue URL. */
  url: string;
  /** The owner/repo the URL targets. */
  slug: string;
  /** True when the freeform body was truncated to fit the URL budget. */
  bodyTruncated: boolean;
  /** True when the diagnostics footer was included in the final URL. */
  diagnosticsIncluded: boolean;
}

/** The default target `owner/repo` for filed issues. */
export function getIssueRepoSlug(): string {
  return DEFAULT_SLUG;
}

/** Clamp an over-long title so it can't push the URL past the budget. */
function clampTitle(title: string): string {
  return title.length > MAX_TITLE_LENGTH
    ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : title;
}

/** Strip commas (which delimit the labels param), trim, and drop empties. */
function sanitizeLabels(labels?: string[]): string[] {
  return (labels ?? [])
    .map(label => label.replace(/,/g, ' ').trim())
    .filter(label => label.length > 0);
}

function renderDiagnostics(
  diagnostics?: Record<string, string | number | boolean | undefined>,
): string {
  if (!diagnostics) return '';
  const lines = Object.entries(diagnostics)
    .filter(
      ([, value]) =>
        value !== undefined && value !== null && String(value).length > 0,
    )
    .map(([key, value]) => `- ${key}: ${String(value)}`);
  if (lines.length === 0) return '';
  return ['---', '### Environment (auto-collected)', ...lines].join('\n');
}

function joinBody(body: string, diagnosticsBlock: string): string {
  return [body.trim() ? body : '', diagnosticsBlock]
    .filter(Boolean)
    .join('\n\n');
}

function composeUrl(
  slug: string,
  title: string,
  body: string,
  labels: string[],
): string {
  const url = new URL(`https://github.com/${slug}/issues/new`);
  url.searchParams.set('title', title);
  if (body) url.searchParams.set('body', body);
  if (labels.length > 0) url.searchParams.set('labels', labels.join(','));
  return url.toString();
}

/**
 * Largest prefix of `rawBody` (plus a truncation marker) whose resulting URL
 * still fits the budget, keeping title and labels intact.
 */
function largestBodyThatFits(
  slug: string,
  title: string,
  rawBody: string,
  labels: string[],
): string {
  let lo = 0;
  let hi = rawBody.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = rawBody.slice(0, mid) + TRUNCATION_MARKER;
    if (composeUrl(slug, title, candidate, labels).length <= MAX_URL_LENGTH) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return rawBody.slice(0, best) + TRUNCATION_MARKER;
}

/**
 * Build a pre-filled GitHub new-issue URL. When the URL exceeds the length
 * budget it degrades gracefully: first the diagnostics footer is dropped, then
 * the freeform body is truncated — the title and labels are always preserved.
 */
export function buildReportIssueUrl(
  opts: BuildReportIssueUrlOptions,
): ReportIssueResult {
  const slug = getIssueRepoSlug();
  const title = clampTitle(opts.title);
  const rawBody = opts.body ?? '';
  const labels = sanitizeLabels(opts.labels);
  const diagnosticsBlock =
    opts.includeDiagnostics === false
      ? ''
      : renderDiagnostics(opts.diagnostics);

  let diagnosticsIncluded = diagnosticsBlock.length > 0;
  let bodyTruncated = false;

  let bodyText = joinBody(rawBody, diagnosticsBlock);
  let url = composeUrl(slug, title, bodyText, labels);

  // Over budget: drop the diagnostics footer first (it is the least valuable).
  if (url.length > MAX_URL_LENGTH && diagnosticsIncluded) {
    diagnosticsIncluded = false;
    bodyText = rawBody;
    url = composeUrl(slug, title, bodyText, labels);
  }

  // Still over budget: truncate the freeform body, keeping title + labels.
  if (url.length > MAX_URL_LENGTH) {
    bodyText = largestBodyThatFits(slug, title, rawBody, labels);
    bodyTruncated = true;
    url = composeUrl(slug, title, bodyText, labels);
  }

  return { url, slug, bodyTruncated, diagnosticsIncluded };
}
