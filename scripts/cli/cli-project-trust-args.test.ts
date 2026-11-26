import { describe, expect, it } from 'vitest';
import {
  PROJECT_TRUST_REQUEST_USAGE,
  parseProjectTrustRequestArgs,
} from './cli-project-trust-args.js';

describe('parseProjectTrustRequestArgs', () => {
  const P = 'knowledge/confidential/acme/scenarios/run.json';

  it('leaves the daily run cap to the library default when omitted', () => {
    expect(parseProjectTrustRequestArgs('request', [P])).toEqual({
      inputPath: P,
      json: false,
      allowUnattended: false,
    });
  });

  it('reads --runs-per-day <N>, --runs-per-day=N and the other flags in any order', () => {
    expect(
      parseProjectTrustRequestArgs('request', [P, '--allow-unattended', '--runs-per-day', '5'])
    ).toEqual({ inputPath: P, json: false, allowUnattended: true, runsPerDay: 5 });
    expect(parseProjectTrustRequestArgs('request', [P, '--runs-per-day=7', '--json'])).toEqual({
      inputPath: P,
      json: true,
      allowUnattended: false,
      runsPerDay: 7,
    });
  });

  it('refuses unknown flags and extra arguments instead of applying the default', () => {
    expect(() => parseProjectTrustRequestArgs('request', [P, '--runs-per-days', '5'])).toThrow(
      "unknown argument '--runs-per-days'"
    );
    expect(() => parseProjectTrustRequestArgs('request', [P, '--allow-unatended'])).toThrow(
      "unknown argument '--allow-unatended'"
    );
    expect(() => parseProjectTrustRequestArgs('request', [P, 'other.json'])).toThrow(
      "unknown argument 'other.json'"
    );
  });

  it('refuses a missing or non-numeric cap and a missing path', () => {
    expect(() => parseProjectTrustRequestArgs('request', [P, '--runs-per-day'])).toThrow(
      '--runs-per-day needs a whole number'
    );
    expect(() => parseProjectTrustRequestArgs('request', [P, '--runs-per-day', 'many'])).toThrow(
      '--runs-per-day needs a whole number'
    );
    expect(() => parseProjectTrustRequestArgs('request', [P, '--runs-per-day', '-1'])).toThrow(
      '--runs-per-day needs a whole number'
    );
    expect(() => parseProjectTrustRequestArgs('request', [])).toThrow(PROJECT_TRUST_REQUEST_USAGE);
    expect(() => parseProjectTrustRequestArgs('list', [P])).toThrow(PROJECT_TRUST_REQUEST_USAGE);
    expect(() => parseProjectTrustRequestArgs('request', ['--json'])).toThrow(
      PROJECT_TRUST_REQUEST_USAGE
    );
  });
});
