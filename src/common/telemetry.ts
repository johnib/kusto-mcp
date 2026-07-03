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
// OTLP exporter configuration
// ---------------------------------------------------------------------------

const DEFAULT_OTLP_ENDPOINT = 'https://api.honeycomb.io';
// Baked ingest key for the `kusto-mcp` Honeycomb environment. It is write-only:
// it cannot read data or create datasets, so exposure in this open-source repo
// is low-risk. Override the destination at runtime with OTEL_EXPORTER_OTLP_HEADERS
// (and OTEL_EXPORTER_OTLP_ENDPOINT) to route telemetry to your own collector.
const DEFAULT_OTLP_HEADERS: Record<string, string> = {
  'x-honeycomb-team':
    'hcaik_01kwkkge2crdaa53rd41c8bsnj75pjdbnsn8mzqzavtj4y82t03km7py54',
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
  const endpointOverride = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const endpoint = (endpointOverride ?? DEFAULT_OTLP_ENDPOINT).replace(
    /\/$/,
    '',
  );
  let headers: Record<string, string>;
  if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
    headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  } else if (endpointOverride) {
    // Redirected to a custom collector without explicit headers: do NOT attach
    // the baked Honeycomb ingest key to a third-party endpoint.
    headers = {};
  } else {
    headers = DEFAULT_OTLP_HEADERS;
  }
  return { endpoint, headers };
}

// ---------------------------------------------------------------------------
// SDK lifecycle
// ---------------------------------------------------------------------------

let sdk: { shutdown: () => Promise<void> } | undefined;

/**
 * Build and start the OTel SDK. Telemetry is ALWAYS ON — using kusto-mcp reports
 * anonymous usage metrics (there is no disable switch). Wires traces, metrics
 * (delta temporality for Honeycomb) and logs to one OTLP endpoint; the endpoint
 * and headers can be redirected to your own collector via OTEL_EXPORTER_OTLP_*.
 *
 * The heavy SDK + exporter packages are imported dynamically here so that
 * importing this module (for the metric/log/config helpers) stays light and
 * doesn't pull the whole OTLP stack into unit tests.
 */
export async function startTelemetry(resource: Resource): Promise<void> {
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
    // host.name, and process.owner (OS username) — identifying data we never
    // want to send.
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
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs`, headers }),
        scheduledDelayMillis: 1_000,
      }),
    ],
    instrumentations: [],
  });

  instance.start();
  sdk = instance;
  debugLog(`Telemetry started -> ${endpoint}`);
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

/**
 * Mark a span as failed WITHOUT leaking any message. Kusto error messages can
 * echo identifiers or query fragments, so we record only the error class name
 * (as `kustomcp.error.type`) — never the raw message or a stack that contains it.
 */
export function recordSpanError(span: Span, error: unknown): void {
  const type = error instanceof Error && error.name ? error.name : 'Error';
  span.setAttribute('kustomcp.error.type', type);
  span.recordException({ name: type });
  span.setStatus({ code: SpanStatusCode.ERROR });
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
