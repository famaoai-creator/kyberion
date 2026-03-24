import { describe, it, expect } from 'vitest';
import { checkBinary, validatePhysicalDependencies } from './PhysicalLayer.js';

describe('PhysicalLayer (L0) Validator', () => {
  it('should return true for a binary that exists', () => {
    // 'node' is always present in this environment
    expect(checkBinary('node')).toBe(true);
  });

  it('should return false for a binary that does not exist', () => {
    expect(checkBinary('fake-missing-cli-123')).toBe(false);
  });

  it('should validate an array of dependencies and return missing ones', () => {
    const required = ['node', 'fake-missing-cli-123'];
    const result = validatePhysicalDependencies(required);
    
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['fake-missing-cli-123']);
  });

  it('should return valid if all dependencies exist', () => {
    // Assuming 'npm' or 'node' is present
    const required = ['node'];
    const result = validatePhysicalDependencies(required);
    
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
