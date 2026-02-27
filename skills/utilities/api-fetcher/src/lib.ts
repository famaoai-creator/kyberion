import { secureFetch } from '@agent/core/network';
// @ts-ignore
import { validateData, ValidationResult } from '../../schema-validator/src/lib.js';

export interface FetchResult {
  data: any;
  status: number;
  validation?: ValidationResult;
}

export async function fetchApi(url: string, options: any = {}): Promise<FetchResult> {
  const config = {
    method: options.method || 'GET',
    url,
    headers: options.headers || {},
    data: options.body || undefined,
  };

  const response = await secureFetch(config);
  const result: FetchResult = {
    data: response.data,
    status: response.status,
  };

  // GraphQL Specific: Check for 'errors' array in response body even if 200 OK
  if (response.data && Array.isArray(response.data.errors)) {
    result.validation = {
      valid: false,
      message: 'GraphQL Logic Error detected',
      errors: response.data.errors
    };
  }

  // Automated Contract Validation (BFF Logic)
  if (options.schema && (!result.validation || result.validation.valid)) {
    result.validation = validateData(response.data, options.schema);
  }

  return result;
}
