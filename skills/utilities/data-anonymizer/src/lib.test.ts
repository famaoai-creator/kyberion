import { describe, it, expect } from 'vitest';
import { anonymize, anonymizeArtifact } from './lib.js';

describe('data-anonymizer lib', () => {
  it('should mask sensitive fields in a flat object', () => {
    const input = {
      username: 'user1',
      email: 'user1@example.com',
      apiKey: 'secret-key-123',
    };
    const result = anonymize(input);
    expect(result.username).toBe('user1');
    expect(result.email).toBe('***MASKED***');
    expect(result.apiKey).toBe('***MASKED***');
  });

  it('should mask sensitive fields in a nested object', () => {
    const input = {
      user: {
        id: 1,
        details: {
          password: 'my-password',
        },
      },
      status: 'active',
    };
    const result = anonymize(input);
    expect(result.user.details.password).toBe('***MASKED***');
    expect(result.status).toBe('active');
  });

  it('should mask fields in an array of objects', () => {
    const input = [
      { id: 1, token: 'token1' },
      { id: 2, token: 'token2' },
    ];
    const result = anonymize(input);
    expect(result[0].token).toBe('***MASKED***');
    expect(result[1].token).toBe('***MASKED***');
  });

  it('should mask financial and auth fields', () => {
    const input = {
      user: 'alice',
      salary: 5000,
      client_secret: 'x123',
      nested: { balance: 10000 },
    };
    const result = anonymize(input);
    expect(result.salary).toBe('***MASKED***');
    expect(result.client_secret).toBe('***MASKED***');
    expect(result.nested.balance).toBe('***MASKED***');
  });

  it('should handle very deep nesting', () => {
    const deepInput = { a: { b: { c: { d: { e: { secret: 'found me' } } } } } };
    const result = anonymize(deepInput);
    expect(result.a.b.c.d.e.secret).toBe('***MASKED***');
  });

  it('should wrap anonymized data in a DocumentArtifact', () => {
    const input = { user: 'bob', email: 'bob@ex.com' };
    const artifact = anonymizeArtifact('User Data', input);

    expect(artifact.title).toBe('User Data');
    expect(artifact.body).toContain('***MASKED***');
    expect(artifact.body).not.toContain('bob@ex.com');
    expect(artifact.format).toBe('text');
  });
});
