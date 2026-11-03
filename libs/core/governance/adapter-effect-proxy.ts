/**
 * Adapter effect proxy — the shared Proxy skeleton every adapter boundary
 * used to hand-roll: serve governed wrappers for selected methods (external
 * effects admitted through runExternalOperation / runCalendarExternalEffect),
 * bind everything else to the target.
 *
 * Domain code keeps what actually differs — which methods are effects, the
 * operation id, snapshot shaping, outcome classifiers, and any pre-wrap
 * idempotency guard (e.g. WeakSet on the original method). What is shared
 * here is only the dispatch boilerplate: per-property memoization so each
 * governed method is built once, and `.bind(target)` for ungoverned methods.
 */

export type AdapterMethodWrapper<T extends object> = (
  property: PropertyKey,
  original: (...args: never[]) => unknown,
  target: T
) => ((...args: never[]) => unknown) | undefined;

/**
 * Wrap `target` so methods `wrapMethod` claims are replaced by the returned
 * wrapper; every other method is bound to `target`, non-function properties
 * pass through untouched.
 *
 * Inside a wrapper, call the original as `Reflect.apply(original, target, [args])`
 * — the loose `never[]` signature keeps this `any`-free while staying callable
 * with domain-typed parameters.
 */
export function wrapAdapterEffects<T extends object>(
  target: T,
  wrapMethod: AdapterMethodWrapper<T>
): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(t, property) {
      if (methods.has(property)) return methods.get(property);
      const value = Reflect.get(t, property, t) as unknown;
      if (typeof value !== 'function') return value;
      const original = value as (...args: never[]) => unknown;
      const method = wrapMethod(property, original, t) ?? original.bind(t);
      methods.set(property, method);
      return method;
    },
  });
}
