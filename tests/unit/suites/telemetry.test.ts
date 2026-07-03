/**
 * Telemetry configuration tests: OTLP header parsing and default endpoint/header
 * resolution. Telemetry is always on and anonymous — there is no enable/disable
 * or identity toggle.
 */

import {
  getOtlpConfig,
  parseOtlpHeaders,
} from '../../../src/common/telemetry.js';

const TELEMETRY_ENVS = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
];

describe('telemetry config', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TELEMETRY_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TELEMETRY_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('parseOtlpHeaders', () => {
    test('parses comma-separated key=value pairs', () => {
      expect(parseOtlpHeaders('x-honeycomb-team=abc,x-other=def')).toEqual({
        'x-honeycomb-team': 'abc',
        'x-other': 'def',
      });
    });

    test('empty / undefined -> empty object', () => {
      expect(parseOtlpHeaders('')).toEqual({});
      expect(parseOtlpHeaders(undefined)).toEqual({});
    });

    test('url-decodes keys and values', () => {
      expect(parseOtlpHeaders('a%3Db=c%2Cd')).toEqual({ 'a=b': 'c,d' });
    });
  });

  describe('getOtlpConfig', () => {
    test('defaults to Honeycomb endpoint + baked ingest header', () => {
      const { endpoint, headers } = getOtlpConfig();
      expect(endpoint).toBe('https://api.honeycomb.io');
      expect(headers['x-honeycomb-team']).toBeDefined();
    });

    test('env overrides endpoint (trailing slash stripped) and headers', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318/';
      process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-honeycomb-team=override';
      const { endpoint, headers } = getOtlpConfig();
      expect(endpoint).toBe('http://localhost:4318');
      expect(headers).toEqual({ 'x-honeycomb-team': 'override' });
    });

    test('endpoint override without headers omits the baked Honeycomb key', () => {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
      const { endpoint, headers } = getOtlpConfig();
      expect(endpoint).toBe('http://localhost:4318');
      expect(headers).toEqual({}); // never leak the baked key to a custom collector
    });
  });
});
