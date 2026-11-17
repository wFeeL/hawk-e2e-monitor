import type { DegradedCode } from './types.js';

/** A row as `node:sqlite` returns it. */
export type SqlRow = Record<string, unknown>;

/**
 * Reads an optional text column.
 * @param row Row as returned by the query.
 * @param name Column.
 * @returns The text, or undefined for NULL.
 */
export function text(row: SqlRow, name: string): string | undefined {
  const value = row[name];

  return typeof value === 'string' ? value : undefined;
}

/**
 * Reads an optional integer column.
 * @param row Row as returned by the query.
 * @param name Column.
 * @returns The number, or undefined for NULL.
 */
export function num(row: SqlRow, name: string): number | undefined {
  const value = row[name];

  return typeof value === 'number' ? value : undefined;
}

/**
 * Reads a required text column.
 * @param row Row as returned by the query.
 * @param name Column.
 * @returns The text, empty when the column is NULL.
 */
export function required(row: SqlRow, name: string): string {
  return text(row, name) ?? '';
}

/**
 * Parses a JSON list of degradation codes.
 * @param value Column value.
 * @returns The codes, empty for anything unreadable.
 */
export function codes(value: string | undefined): DegradedCode[] {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;

    return Array.isArray(parsed) ? parsed as DegradedCode[] : [];
  } catch {
    return [];
  }
}

/**
 * Drops the keys whose value is undefined, so rows compare cleanly.
 * @param row Object with optional fields.
 * @returns The same object without undefined fields.
 */
export function compact<T extends object>(row: T): T {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) as T;
}
