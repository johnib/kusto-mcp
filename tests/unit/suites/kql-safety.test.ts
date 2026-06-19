/**
 * Unit tests for KQL safety helpers: identifier validation/bracketing,
 * read-only enforcement, and the N+1 row-limit builder.
 */

import { KustoValidationError } from '../../../src/common/errors.js';
import {
  appendRowLimit,
  assertQueryAllowed,
  bracketEntityName,
  isControlCommand,
  isReadOnlyControlCommand,
  validateEntityName,
} from '../../../src/common/kql-safety.js';

describe('KQL Safety', () => {
  describe('validateEntityName', () => {
    test.each([
      'SalesFact',
      'Table-With-Dashes',
      'Table.With.Dots',
      'Has Spaces',
      '_underscore',
      'a1b2c3',
    ])('accepts legal identifier %p', name => {
      expect(validateEntityName(name)).toBe(name);
    });

    test('trims surrounding whitespace', () => {
      expect(validateEntityName('  SalesFact  ')).toBe('SalesFact');
    });

    test.each([
      '',
      '   ',
      "x'); .drop table y //",
      'name | take 1',
      'a; b',
      'tbl)',
      "['injected']",
      'has\nnewline',
      'col:type',
    ])('rejects unsafe identifier %p', name => {
      expect(() => validateEntityName(name, 'table')).toThrow(
        KustoValidationError,
      );
      expect(() => validateEntityName(name, 'table')).toThrow(
        /Invalid table name/,
      );
    });
  });

  describe('bracketEntityName', () => {
    test('wraps a validated name in bracket-quote notation', () => {
      expect(bracketEntityName('SalesFact')).toBe("['SalesFact']");
      expect(bracketEntityName('Has Spaces')).toBe("['Has Spaces']");
    });
  });

  describe('isControlCommand / isReadOnlyControlCommand', () => {
    test('detects dot-prefixed control commands', () => {
      expect(isControlCommand('.show tables')).toBe(true);
      expect(isControlCommand('   .drop table X')).toBe(true);
      expect(isControlCommand('SalesFact | take 5')).toBe(false);
    });

    test('only .show commands are read-only', () => {
      expect(isReadOnlyControlCommand('.show tables')).toBe(true);
      expect(isReadOnlyControlCommand('.SHOW database schema')).toBe(true);
      expect(isReadOnlyControlCommand('.drop table X')).toBe(false);
      expect(isReadOnlyControlCommand('.set-or-append T <| Y')).toBe(false);
    });
  });

  describe('assertQueryAllowed (read-only enforcement)', () => {
    test('allows plain KQL queries in read-only mode', () => {
      expect(() => assertQueryAllowed('SalesFact | count', false)).not.toThrow();
    });

    test('allows .show commands in read-only mode', () => {
      expect(() => assertQueryAllowed('.show tables', false)).not.toThrow();
    });

    test.each(['.drop table X', '.set-or-append T <| Y', '.ingest inline', '.create table Z'])(
      'blocks write/management command %p in read-only mode',
      cmd => {
        expect(() => assertQueryAllowed(cmd, false)).toThrow(
          KustoValidationError,
        );
      },
    );

    test('allows write commands when writes are enabled', () => {
      expect(() => assertQueryAllowed('.drop table X', true)).not.toThrow();
    });
  });

  describe('appendRowLimit', () => {
    test('appends take on a new line for normal queries', () => {
      expect(appendRowLimit('SalesFact', 21)).toBe('SalesFact\n| take 21');
    });

    test('new-line placement survives a trailing line comment', () => {
      const result = appendRowLimit('SalesFact // newest first', 21);
      // The take must be on its own line, not swallowed by the comment.
      expect(result).toBe('SalesFact // newest first\n| take 21');
      expect(result.split('\n')[1]).toBe('| take 21');
    });

    test('does not append take to control commands', () => {
      expect(appendRowLimit('.show tables', 21)).toBe('.show tables');
    });
  });
});
