import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  declaredOperationPatterns,
  operationAuthorization,
  setAuthorizationOverlayProvider,
  type AuthorizationOverlay,
  type EffectClass,
} from './authorization-registry.js';
import { EXTERNAL_OPERATION_DELEGATION } from '../governance/external-operation-target.js';

const EXTERNAL_CLASSES: readonly EffectClass[] = ['external_mutation', 'external_read'];

const admission = { kind: 'admission', boundary: 'external' } as const;

describe('authorization-registry', () => {
  it('fails safe for undeclared operations: external_mutation + admission, declared=false', () => {
    const auth = operationAuthorization('acme:novel_op');
    expect(auth.declared).toBe(false);
    expect(auth.effectClass).toBe('external_mutation');
    expect(auth.authority).toEqual({ kind: 'admission', boundary: 'external' });
  });

  it('resolves exact declarations', () => {
    const auth = operationAuthorization('vcs:pr_merge');
    expect(auth.declared).toBe(true);
    expect(auth.effectClass).toBe('external_mutation');
    expect(auth.delegable?.reputational_class).toBe('A');
  });

  it('resolves prefix families and picks the longest prefix', () => {
    expect(operationAuthorization('email:send').declared).toBe(true);
    expect(operationAuthorization('email:create_draft').declared).toBe(true);
    expect(operationAuthorization('calendar:write').declared).toBe(true);
    expect(operationAuthorization('media:image:gen:generate').declared).toBe(true);
    // Undeclared prefix family does not accidentally match.
    expect(operationAuthorization('emailx:send').declared).toBe(false);
  });

  it('keeps a closed EffectClass set (no free-form classes)', () => {
    const classes = new Set(
      declaredOperationPatterns().map(
        (p) => operationAuthorization(p.replace(/\*$/, 'x')).effectClass
      )
    );
    for (const c of classes) {
      expect([
        'external_mutation',
        'external_read',
        'internal_decision',
        'knowledge_write',
        'credential_use',
        'system_control',
        'local_only',
      ]).toContain(c);
    }
  });
});

describe('authorization-registry overlays', () => {
  let restore: (() => readonly AuthorizationOverlay[]) | undefined;
  afterEach(() => setAuthorizationOverlayProvider(restore));

  const overlay = (entries: Partial<AuthorizationOverlay>): AuthorizationOverlay => ({
    source: 'overlay',
    operations: {},
    prefixes: {},
    ...entries,
  });

  it('overlay declarations add coverage for code-undeclared ids', () => {
    restore = setAuthorizationOverlayProvider(() => [
      overlay({
        operations: {
          'acme:invoice_send': { effectClass: 'external_mutation', authority: admission },
        },
        prefixes: { 'acme:report:': { effectClass: 'external_read', authority: admission } },
      }),
    ]);
    const exact = operationAuthorization('acme:invoice_send');
    expect({ declared: exact.declared, source: exact.source }).toEqual({
      declared: true,
      source: 'overlay',
    });
    const prefixed = operationAuthorization('acme:report:monthly');
    expect(prefixed.declared).toBe(true);
    expect(operationAuthorization('acme:other').declared).toBe(false);
  });

  it('code declarations always beat overlay declarations (no weakening)', () => {
    restore = setAuthorizationOverlayProvider(() => [
      overlay({
        operations: {
          'vcs:push': { effectClass: 'local_only', authority: { kind: 'free' } },
        },
        prefixes: {
          'vcs:': { effectClass: 'local_only', authority: { kind: 'free' } },
        },
      }),
    ]);
    const auth = operationAuthorization('vcs:push');
    expect({ effectClass: auth.effectClass, source: auth.source }).toEqual({
      effectClass: 'external_mutation',
      source: 'code',
    });
    const prefixed = operationAuthorization('vcs:github:read');
    expect({ effectClass: prefixed.effectClass, source: prefixed.source }).toEqual({
      effectClass: 'external_read',
      source: 'code',
    });
  });

  it('longest prefix wins across overlays; first overlay wins ties', () => {
    restore = setAuthorizationOverlayProvider(() => [
      overlay({
        prefixes: { 'acme:': { effectClass: 'external_read', authority: admission } },
      }),
      {
        source: 'plugin:acme-plugin',
        operations: {},
        prefixes: {
          'acme:report:': { effectClass: 'external_mutation', authority: admission },
        },
      },
    ]);
    const auth = operationAuthorization('acme:report:x');
    expect({ effectClass: auth.effectClass, source: auth.source }).toEqual({
      effectClass: 'external_mutation',
      source: 'plugin:acme-plugin',
    });
    expect(operationAuthorization('acme:other').effectClass).toBe('external_read');
  });

  it('declaredOperationPatterns includes overlay keys', () => {
    restore = setAuthorizationOverlayProvider(() => [
      overlay({
        operations: {
          'acme:invoice_send': { effectClass: 'external_mutation', authority: admission },
        },
        prefixes: { 'acme:report:': { effectClass: 'external_read', authority: admission } },
      }),
    ]);
    const patterns = declaredOperationPatterns();
    expect(patterns).toContain('acme:invoice_send');
    expect(patterns).toContain('acme:report:*');
  });
});

describe('authorization-registry boundary coverage gate', () => {
  const ROOT = process.cwd();
  const SCAN_DIRS = [path.join(ROOT, 'libs/core'), path.join(ROOT, 'scripts')];
  const SKIP_FILE =
    /(\.test\.ts|\.d\.ts)$|external-operation\.ts$|external-operation-target\.ts$|authorization-registry(\.test)?\.ts$/;
  const BOUNDARY_CALL =
    /\b(?:runExternalOperationSync|runExternalOperation|admitExternalOperation|continueExternalOperationApproval)\s*\(/;
  const OPID_LITERAL = /operationId:\s*'([^']+)'/g;
  const OPID_TEMPLATE_PREFIX = /operationId:\s*`([^`$]+)\$\{/g;
  const WRAPPER_CALL = /\bgovernVcsCommand\(\s*'([^']+)'/g;

  function productionSources(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (dir.includes(`${path.sep}dist${path.sep}`)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && !SKIP_FILE.test(p)) out.push(p);
      }
    };
    for (const d of SCAN_DIRS) walk(d);
    return out;
  }

  function referencedOperationIds(): { file: string; id: string; prefix: boolean }[] {
    const found: { file: string; id: string; prefix: boolean }[] = [];
    for (const file of productionSources()) {
      const src = fs.readFileSync(file, 'utf8');
      if (!BOUNDARY_CALL.test(src) && !WRAPPER_CALL.test(src)) continue;
      const rel = path.relative(ROOT, file);
      for (const m of src.matchAll(OPID_LITERAL))
        found.push({ file: rel, id: m[1], prefix: false });
      for (const m of src.matchAll(OPID_TEMPLATE_PREFIX))
        found.push({ file: rel, id: m[1], prefix: true });
      for (const m of src.matchAll(WRAPPER_CALL))
        found.push({ file: rel, id: m[1], prefix: false });
    }
    return found;
  }

  it('every operationId routed through the external boundary is declared in code', () => {
    const refs = referencedOperationIds();
    const undeclared = refs.filter(({ id, prefix }) => {
      const probe = prefix ? `${id}probe` : id;
      const auth = operationAuthorization(probe);
      // Boundary-routed ops must be reviewed with the code — an overlay-only
      // declaration cannot satisfy this gate.
      return !(auth.declared && auth.source === 'code');
    });
    expect(undeclared).toEqual([]);
    expect(refs.length).toBeGreaterThan(0);
  });

  it('every operationId routed through the external boundary is an external_* class', () => {
    const misclassified = referencedOperationIds().filter(({ id, prefix }) => {
      const probe = prefix ? `${id}probe` : id;
      const auth = operationAuthorization(probe);
      return !EXTERNAL_CLASSES.includes(auth.effectClass);
    });
    expect(misclassified).toEqual([]);
  });

  it('delegation registry stays folded into the declaration table', () => {
    for (const [opId, spec] of Object.entries(EXTERNAL_OPERATION_DELEGATION)) {
      const auth = operationAuthorization(opId);
      expect({ opId, declared: auth.declared }).toEqual({ opId, declared: true });
      expect({ opId, delegable: auth.delegable }).toEqual({
        opId,
        delegable: {
          fields: [...spec.fields],
          ...(spec.optionalFields ? { optionalFields: [...spec.optionalFields] } : {}),
          reputational_class: spec.reputational_class,
        },
      });
    }
    // No op may declare delegability without a target builder.
    for (const pattern of declaredOperationPatterns()) {
      const probe = pattern.replace(/\*$/, 'probe');
      const auth = operationAuthorization(probe);
      if (auth.delegable) {
        expect(pattern in EXTERNAL_OPERATION_DELEGATION).toBe(true);
      }
    }
  });
});
