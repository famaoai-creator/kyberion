/**
 * CD-12: the strict field readers the customer-decision response parsers
 * share (overview, case detail, learning view). Import-free on purpose, like
 * the parsers: the server validates the facade child's stdout with them and
 * the browser validates the route's response with them.
 *
 * Every reader throws {@link InvalidCustomerDecisionValue} on a missing or
 * mistyped field; a parser catches it once and returns undefined. Parsers
 * rebuild every object from the fields they know, so a key the contract does
 * not list (a decision value, a comment, …) never passes.
 */

export type JsonRecord = Record<string, unknown>;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class InvalidCustomerDecisionValue extends Error {}

export function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidCustomerDecisionValue();
  if (Object.keys(value).some((key) => DANGEROUS_KEYS.has(key)))
    throw new InvalidCustomerDecisionValue();
  return value as JsonRecord;
}

export function text(source: JsonRecord, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || !value.trim()) throw new InvalidCustomerDecisionValue();
  return value;
}

/** A string that may be empty (e.g. a hand-off time the store never recorded). */
export function anyText(source: JsonRecord, key: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new InvalidCustomerDecisionValue();
  return value;
}

export function optionalText(source: JsonRecord, key: string): string | undefined {
  return source[key] === undefined ? undefined : text(source, key);
}

export function nullableText(source: JsonRecord, key: string): string | null {
  return source[key] === null ? null : text(source, key);
}

export function count(source: JsonRecord, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new InvalidCustomerDecisionValue();
  return value;
}

/** A finite number in [0, 1] (a rate). */
export function rate(source: JsonRecord, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new InvalidCustomerDecisionValue();
  return value;
}

/** A day offset (negative when past). */
export function days(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new InvalidCustomerDecisionValue();
  return value;
}

export function flag(source: JsonRecord, key: string): boolean {
  const value = source[key];
  if (typeof value !== 'boolean') throw new InvalidCustomerDecisionValue();
  return value;
}

export function oneOf<T extends string>(source: JsonRecord, key: string, values: readonly T[]): T {
  const value = source[key];
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value))
    throw new InvalidCustomerDecisionValue();
  return value as T;
}

export function optionalOneOf<T extends string>(
  source: JsonRecord,
  key: string,
  values: readonly T[]
): T | undefined {
  return source[key] === undefined ? undefined : oneOf(source, key, values);
}

export function list<T>(value: unknown, parse: (entry: unknown) => T, cap: number): T[] {
  if (!Array.isArray(value)) throw new InvalidCustomerDecisionValue();
  return value.slice(0, cap).map(parse);
}

export function lengthOf(value: unknown): number {
  if (!Array.isArray(value)) throw new InvalidCustomerDecisionValue();
  return value.length;
}

/** A `*_total` count, never below the rows actually listed. */
export function totalOf(source: JsonRecord, key: string, listed: unknown): number {
  return Math.max(count(source, key), lengthOf(listed));
}

/** Text cut to `max` characters (the facade already cuts; this holds if it ever does not). */
export function capText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

/** Runs a parser; an invalid value is undefined, any other error is rethrown. */
export function parseOrUndefined<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    if (error instanceof InvalidCustomerDecisionValue) return undefined;
    throw error;
  }
}
