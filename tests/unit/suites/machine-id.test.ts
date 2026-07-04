/**
 * machine-id persistence: date-floored first_seen (I17) and the onboarding
 * funnel (I16 — hasConnected / markConnected), plus backward-compat with the
 * legacy bare-UUID file format.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

describe('machine-id persistence', () => {
  let dir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME;
    dir = mkdtempSync(join(tmpdir(), 'kusto-mcp-mid-'));
    process.env.XDG_DATA_HOME = dir;
    jest.resetModules(); // fresh module = fresh in-process markConnected guard
  });

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  const load = () =>
    require('../../../src/common/machine-id.js').loadOrCreateMachineId();
  const mark = () =>
    require('../../../src/common/machine-id.js').markConnected();

  test('fresh install: JSON store, date-floored first_seen, not yet connected', () => {
    const id = load();
    expect(id.isFirstRun).toBe(true);
    expect(id.hasConnected).toBe(false);
    expect(id.firstSeen).toMatch(DATE_ONLY); // I17 — no ms-precision jitter
    // Persisted as JSON (not a bare UUID).
    const raw = readFileSync(join(dir, 'kusto-mcp', 'machine_id'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('reload returns the same id and is not a first run', () => {
    const first = load();
    const second = load();
    expect(second.machineId).toBe(first.machineId);
    expect(second.isFirstRun).toBe(false);
    expect(second.firstSeen).toBe(first.firstSeen);
  });

  test('legacy bare-UUID file is read; first_seen is date-only', () => {
    const legacy = '11111111-2222-3333-4444-555555555555';
    require('node:fs').mkdirSync(join(dir, 'kusto-mcp'), { recursive: true });
    writeFileSync(join(dir, 'kusto-mcp', 'machine_id'), `${legacy}\n`);
    const id = load();
    expect(id.machineId).toBe(legacy);
    expect(id.hasConnected).toBe(false);
    expect(id.firstSeen).toMatch(DATE_ONLY);
  });

  test('markConnected flips hasConnected once and persists it', () => {
    load();
    expect(mark()).toBe(true); // first-ever success
    expect(mark()).toBe(false); // idempotent within the process
    const reloaded = load();
    expect(reloaded.hasConnected).toBe(true); // persisted for future runs
  });
});
