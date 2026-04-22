/**
 * Compile-time + runtime exhaustiveness guard for discriminated unions.
 *
 * Use in the `else` branch of a variant-switch so that (a) TypeScript proves
 * every variant has been handled (the parameter type narrows to `never`), and
 * (b) at runtime, an unexpected variant throws loudly rather than silently
 * no-op'ing. The silent-no-op failure mode is the primary hazard of the
 * compile-time-only `const _: never = x` idiom: if a future code path ever
 * produces a value whose discriminant bypasses the type system (JSON.parse,
 * unsafe cast, test mock), the else branch simply falls through with no
 * response / no error / no log. HTTP handlers using that pattern hang until
 * server close; `assertNever` converts the hang into a 500 via the outer
 * error handler.
 *
 * Example:
 *   if (s.state === 'a') { ... }
 *   else if (s.state === 'b') { ... }
 *   else assertNever(s);
 */
export function assertNever(x: never): never {
  throw new Error('unreachable: ' + JSON.stringify(x));
}
