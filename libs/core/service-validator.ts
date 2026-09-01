/**
 * Public package boundary for the service validation contract.
 *
 * The implementation remains under the historical `src/pfc` directory, but
 * consumers should not depend on that source layout.
 */
export {
  ServiceValidator,
  inspectServiceAuth,
  validateService,
  validateServiceAuth,
} from './src/pfc/ServiceValidator.js';

export type {
  ServiceAuthInspection,
  ServiceRequirements,
  ServiceValidationResult,
} from './src/pfc/ServiceValidator.js';
