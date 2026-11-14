/** Internal opaque admission seam. Only the consent broker may issue a callback window. */
import type { PersonalServiceCredentialAdmission } from './personal-service-credential-broker.js';

type Window = { live: boolean; metadata: PersonalServiceCredentialAdmission; validate: () => void };
const admissions = new WeakMap<object, Window>();

/** Issuance is restricted to the broker by the trusted-import boundary. */
export async function withPersonalServiceCredentialAdmission<T>(
  metadata: PersonalServiceCredentialAdmission,
  validate: () => void,
  run: (capability: object) => Promise<T>
): Promise<T> {
  const capability = Object.freeze({});
  const window: Window = { live: true, metadata, validate };
  admissions.set(capability, window);
  try {
    return await run(capability);
  } finally {
    window.live = false;
    admissions.delete(capability);
  }
}

/** Fake, expired and cross-task capabilities are not accepted as service admission. */
export function resolvePersonalServiceCredentialAdmission(
  capability: object,
  serviceId?: string,
  action?: string
): PersonalServiceCredentialAdmission {
  const window = admissions.get(capability);
  if (
    !window?.live ||
    (serviceId !== undefined && window.metadata.serviceId !== serviceId) ||
    (action !== undefined && window.metadata.action !== action)
  )
    throw new Error('[PERSONAL_SERVICE_CREDENTIAL_DENIED] Current exact personal consent required');
  window.validate();
  return Object.freeze({
    ...window.metadata,
    claim: Object.freeze({ ...window.metadata.claim }),
    binding: structuredClone(window.metadata.binding),
  });
}
