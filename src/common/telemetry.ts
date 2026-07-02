import {
  Attributes,
  Counter,
  Histogram,
  MetricOptions,
  Span,
  SpanStatusCode,
  metrics,
  trace,
} from '@opentelemetry/api';
import { SeverityNumber, logs } from '@opentelemetry/api-logs';
import type { Resource } from '@opentelemetry/resources';
import { debugLog } from './utils.js';

export { SeverityNumber } from '@opentelemetry/api-logs';

// ---------------------------------------------------------------------------
// Configuration & consent
// ---------------------------------------------------------------------------

export type IdentityTier = 'off' | 'company' | 'full';

export interface TelemetryMode {
  /** Master switch. When false, the SDK is never started -> zero egress. */
  enabled: boolean;
  /**
   * How much identity to attach:
   * - off:     region + service/os only (no enduser.*, no cluster host/name/db)
   * - company: + tenant, email domain, account type, cluster host/name, database
   * - full:    + per-user object id (oid) and UPN  (DEFAULT)
   */
  identity: IdentityTier;
}

let _mode: TelemetryMode | undefined;

function isOff(value: string | undefined): boolean {
  const s = (value ?? '').trim().toLowerCase();
  return s === '0' || s === 'off' || s === 'false' || s === 'no';
}

/**
 * Resolve telemetry consent from the environment (memoized).
 * Master switch defaults ON; identity tier defaults to `full` (per-user by
 * default, opt-out) — the maintainer's chosen posture. Downgrade with
 * KUSTO_MCP_TELEMETRY_IDENTITY=company|off, disable all with KUSTO_MCP_TELEMETRY=0.
 */
export function getTelemetryMode(): TelemetryMode {
  if (_mode) return _mode;
  const enabled = !isOff(process.env.KUSTO_MCP_TELEMETRY);
  const raw = (process.env.KUSTO_MCP_TELEMETRY_IDENTITY ?? 'full')
    .trim()
    .toLowerCase();
  const identity: IdentityTier =
    raw === 'off' ? 'off' : raw === 'company' ? 'company' : 'full';
  _mode = { enabled, identity };
  return _mode;
}

/** Test hook: reset the memoized mode. */
export function resetTelemetryModeForTests(): void {
  _mode = undefined;
}

// ---------------------------------------------------------------------------
// OTLP exporter configuration
// ---------------------------------------------------------------------------

const DEFAULT_OTLP_ENDPOINT = 'https://api.honeycomb.io';
// PLACEHOLDER: the maintainer bakes the real ingest key for the `kusto-mcp`
// Honeycomb environment here. A key for another env silently misroutes. Users
// can override at runtime with OTEL_EXPORTER_OTLP_HEADERS.
const DEFAULT_OTLP_HEADERS: Record<string, string> = {
  'x-honeycomb-team': 'hcaik_REPLACE_WITH_KUSTO_MCP_ENV_KEY',
};

/** Parse `k=v,k2=v2` OTLP header string. All-or-nothing: overrides defaults. */
export function parseOtlpHeaders(
  raw: string | undefined,
): Record<string, string> {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean)
      .map(entry => {
        const sep = entry.indexOf('=');
        if (sep === -1) return [entry, ''];
        return [
          decodeURIComponent(entry.slice(0, sep)),
          decodeURIComponent(entry.slice(sep + 1)),
        ];
      }),
  );
}

export function getOtlpConfig(): {
  endpoint: string;
  headers: Record<string, string>;
} {
  const endpoint = (
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? DEFAULT_OTLP_ENDPOINT
  ).replace(/\/$/, '');
  const headers = process.env.OTEL_EXPORTER_OTLP_HEADERS
    ? parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    : DEFAULT_OTLP_HEADERS;
  return { endpoint, headers };
}

// ---------------------------------------------------------------------------
// SDK lifecycle
// ---------------------------------------------------------------------------

let sdk: { shutdown: () => Promise<void> } | undefined;

/**
 * Build and start the OTel SDK if telemetry is enabled. Wires traces, metrics
 * (delta temporality for Honeycomb) and logs to one OTLP endpoint. No-op when
 * disabled — the global tracer/meter/logger then stay no-ops.
 *
 * The heavy SDK + exporter packages are imported dynamically here so that
 * importing this module (for the metric/log/config helpers) stays light and
 * doesn't pull the whole OTLP stack into unit tests.
 */
export async function startTelemetry(
  resource: Resource,
): Promise<TelemetryMode> {
  const mode = getTelemetryMode();
  if (!mode.enabled) {
    debugLog('Telemetry disabled via KUSTO_MCP_TELEMETRY');
    return mode;
  }

  const { endpoint, headers } = getOtlpConfig();

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { AggregationTemporalityPreference, OTLPMetricExporter },
    { OTLPLogExporter },
    { PeriodicExportingMetricReader },
    { BatchLogRecordProcessor },
    { BatchSpanProcessor },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/exporter-logs-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/sdk-logs'),
    import('@opentelemetry/sdk-trace-node'),
  ]);

  const instance = new NodeSDK({
    resource,
    // Ship ONLY our explicit resource attributes. NodeSDK's default detectors
    // (host/process) would otherwise add host.id (a stable hardware UUID),
    // host.name, and process.owner (OS username) unconditionally — extra PII
    // that would bypass the identity tier.
    autoDetectResources: false,
    // Only spanProcessors (NOT traceExporter) — passing both makes sdk-node
    // silently drop the standalone traceExporter.
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers }),
        { scheduledDelayMillis: 1_000 },
      ),
    ],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
          headers,
          // Honeycomb expects delta; many short-lived processes each export
          // once, so cumulative would be unusable across the fleet.
          temporalityPreference: AggregationTemporalityPreference.DELTA,
        }),
        exportIntervalMillis: 5_000,
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }),
        { scheduledDelayMillis: 1_000 },
      ),
    ],
    instrumentations: [],
  });

  instance.start();
  sdk = instance;
  debugLog(
    `Telemetry started -> ${endpoint} (identity tier: ${mode.identity})`,
  );
  return mode;
}

/** Await a bounded flush + shutdown. Safe to call multiple times. */
export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  const current = sdk;
  sdk = undefined;
  await Promise.race([
    current
      .shutdown()
      .catch(error => debugLog(`OTel shutdown error: ${String(error)}`)),
    new Promise<void>(resolve => setTimeout(resolve, 3_000).unref()),
  ]);
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const otelLogger = logs.getLogger('kusto-mcp');

/**
 * Emit an OTel log record with the active trace/span ids attached. Bodies must
 * be short operational strings — never query text, rows, or token values.
 */
export function emitLog(
  severityNumber: SeverityNumber,
  severityText: string,
  message: string,
  attributes?: Attributes,
): void {
  const spanContext = trace.getActiveSpan()?.spanContext();
  otelLogger.emit({
    severityNumber,
    severityText,
    body: message,
    attributes: {
      ...attributes,
      ...(spanContext && {
        'trace.id': spanContext.traceId,
        'span.id': spanContext.spanId,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------

/** setStatus(ERROR) + recordException in one call. */
export function recordSpanError(
  span: Span,
  error: unknown,
  message?: string,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: message ?? err.message,
  });
}

// ---------------------------------------------------------------------------
// Metrics — single meter, delta temporality
//
// Instruments are created LAZILY on first use. The metrics API has no proxy
// meter (unlike traces): a meter/instrument obtained before the SDK registers
// the global MeterProvider binds to a no-op meter forever. Since every record
// happens at request time (after startTelemetry), lazy creation binds to the
// real meter.
// ---------------------------------------------------------------------------

interface LazyCounter {
  add(value: number, attributes?: Attributes): void;
}
interface LazyHistogram {
  record(value: number, attributes?: Attributes): void;
}

function lazyCounter(name: string, options: MetricOptions): LazyCounter {
  let inst: Counter | undefined;
  return {
    add(value, attributes) {
      inst ??= metrics.getMeter('kusto-mcp').createCounter(name, options);
      inst.add(value, attributes);
    },
  };
}

function lazyHistogram(name: string, options: MetricOptions): LazyHistogram {
  let inst: Histogram | undefined;
  return {
    record(value, attributes) {
      inst ??= metrics.getMeter('kusto-mcp').createHistogram(name, options);
      inst.record(value, attributes);
    },
  };
}

export const toolCallsCounter = lazyCounter('kustomcp.tool.calls', {
  unit: '{call}',
  description: 'MCP tool calls',
});
export const toolErrorsCounter = lazyCounter('kustomcp.tool.errors', {
  unit: '{error}',
  description: 'MCP tool calls that ended in error',
});
export const toolNotInitializedCounter = lazyCounter(
  'kustomcp.tool.not_initialized',
  {
    unit: '{call}',
    description: 'Tool calls rejected: connection not initialized',
  },
);
export const queriesCounter = lazyCounter('kustomcp.queries.total', {
  unit: '{query}',
  description: 'Kusto queries/commands executed',
});
export const connectionAttemptsCounter = lazyCounter(
  'kustomcp.connection.attempts',
  { unit: '{attempt}', description: 'Connection initialization attempts' },
);
export const connectionFailuresCounter = lazyCounter(
  'kustomcp.connection.failures',
  { unit: '{failure}', description: 'Connection initialization failures' },
);

export const toolDurationHistogram = lazyHistogram('kustomcp.tool.duration', {
  unit: 'ms',
  description: 'MCP tool call duration',
});
export const queryDurationHistogram = lazyHistogram('kustomcp.query.duration', {
  unit: 'ms',
  description: 'Kusto query execution duration',
});
export const queryRowsHistogram = lazyHistogram(
  'kustomcp.query.rows_returned',
  {
    unit: '{row}',
    description: 'Rows returned per query',
  },
);
export const responseBytesHistogram = lazyHistogram('kustomcp.response.bytes', {
  unit: 'By',
  description: 'Serialized MCP tool response size',
});
