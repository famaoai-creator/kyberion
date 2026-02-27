import { DocumentArtifact } from '@agent/core/shared-business-types';

export const SENSITIVE_KEYS = [
  'email',
  'password',
  'token',
  'secret',
  'key',
  'apiKey',
  'api_key',
  'auth',
  'credential',
  'private',
  'ssn',
  'credit_card',
  'card_number',
  'cvv',
  'address',
  'phone',
  'mobile',
  'birth',
  'salary',
  'bonus',
  'balance',
  'account_number',
  'iban',
  'swift',
  'passport',
  'license_plate',
  'client_secret',
  'client_id',
  'refresh_token',
  'access_token',
  'jwt',
  'cookie',
  'session_id',
];

/**
 * Recursively masks sensitive fields in a JSON object.
 */
export function anonymize(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(anonymize);
  } else if (obj !== null && typeof obj === 'object') {
    const maskedObj: any = {};

    for (const [key, value] of Object.entries(obj)) {
      const isSensitive = SENSITIVE_KEYS.some((sk) => key.toLowerCase().includes(sk.toLowerCase()));

      if (isSensitive) {
        maskedObj[key] = '***MASKED***';
      } else {
        maskedObj[key] = anonymize(value);
      }
    }
    return maskedObj;
  }
  return obj;
}

/**
 * Anonymizes data and wraps it in a DocumentArtifact.
 */
export function anonymizeArtifact(title: string, data: any): DocumentArtifact {
  const anonymized = anonymize(data);
  return {
    title,
    body: JSON.stringify(anonymized, null, 2),
    format: 'text', // JSON is stored as text in body
    metadata: { anonymized: true, original_title: title },
  };
}
