/** Compatibility entrypoint; canonical pure scope validation lives in foundation. */
export {
  normalizeScopeContext,
  validateScopeContext,
  assertScopeContext,
  type ScopeContext,
  type ScopeContextInput,
  type ScopeContextValidationOptions,
} from './foundation/scope-context-validation.js';
