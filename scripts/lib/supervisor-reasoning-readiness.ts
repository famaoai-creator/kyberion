import {
  isCredentialBindingRequired,
  type CredentialBindingReadiness,
} from '@agent/core/secret/secret-guard';

export interface SupervisorReasoningReadiness {
  status: 'uninitialized' | 'ready' | 'unavailable' | 'binding_required' | 'scope_denied';
  reason_code?: string;
}

export interface SupervisorReasoningRefreshPorts {
  inspect: () => CredentialBindingReadiness;
  install: () => boolean;
  reselect: () => boolean;
  logger: {
    warn: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
  };
}

/**
 * A daemon can stay live while its reasoning capability is unavailable.
 * Re-check non-sensitive prerequisites on every tick, without repeatedly probing
 * providers for a binding that only a governed task dispatch can supply.
 */
export function createSupervisorReasoningRefresh(ports: SupervisorReasoningRefreshPorts) {
  let state: SupervisorReasoningReadiness = { status: 'uninitialized' };
  let attempted = false;
  let lastNotice: string | undefined;

  function publish(next: SupervisorReasoningReadiness): void {
    const notice = JSON.stringify(next);
    state = next;
    if (notice === lastNotice) return;
    lastNotice = notice;
    if (next.status === 'ready') {
      ports.logger.info(
        '[reasoning-readiness] backend ready — prerequisites satisfied | next: periodic capability refresh | evidence: reasoning-bootstrap'
      );
    } else if (next.status === 'binding_required') {
      ports.logger.warn(
        '[reasoning-readiness] backend waiting — [CREDENTIAL_BINDING_REQUIRED] no trusted task binding | next: dispatch credential-dependent tenant work through a claimed WorkItem and bindTask; local maintenance must not require this backend | evidence: credential-binding'
      );
    } else if (next.status === 'scope_denied') {
      ports.logger.error(
        '[reasoning-readiness] backend blocked — ' +
          (next.reason_code ?? 'CREDENTIAL_SCOPE_DENIED') +
          ' execution context is inconsistent | next: repair the scope and matching binding before retrying; operator credentials are not a tenant fallback | evidence: credential-binding'
      );
    } else if (next.status === 'unavailable') {
      ports.logger.warn(
        '[reasoning-readiness] backend unavailable — ' +
          (next.reason_code ?? 'BACKEND_UNAVAILABLE') +
          ' | next: inspect provider readiness; periodic refresh remains enabled | evidence: reasoning-bootstrap'
      );
    }
  }

  function refresh(): boolean {
    let readiness: CredentialBindingReadiness;
    try {
      readiness = ports.inspect();
    } catch (error) {
      // Contradictory context is a hard policy refusal, not missing credentials.
      const codes =
        error instanceof Error ? (error.message.match(/\[CREDENTIAL_[A-Z_]+\]/gu) ?? []) : [];
      const code =
        codes.find((candidate) => candidate !== '[CREDENTIAL_BINDING_REQUIRED]') ?? codes[0];
      publish({
        status: 'scope_denied',
        reason_code: code?.slice(1, -1) ?? 'CREDENTIAL_READINESS_FAILED',
      });
      return false;
    }
    if (readiness.status === 'binding_required') {
      publish({ status: 'binding_required', reason_code: 'CREDENTIAL_BINDING_REQUIRED' });
      return false;
    }
    try {
      const available = attempted ? ports.reselect() : ports.install();
      attempted = true;
      publish(
        available
          ? { status: 'ready' }
          : { status: 'unavailable', reason_code: 'BACKEND_UNAVAILABLE' }
      );
      return available;
    } catch (error) {
      const codes =
        error instanceof Error ? (error.message.match(/\[CREDENTIAL_[A-Z_]+\]/gu) ?? []) : [];
      const code =
        codes.find((candidate) => candidate !== '[CREDENTIAL_BINDING_REQUIRED]') ?? codes[0];
      if (
        code === '[CREDENTIAL_BINDING_REQUIRED]' ||
        code === '[CREDENTIAL_SCOPE_DENIED]' ||
        code === '[CREDENTIAL_OWNER_DENIED]'
      ) {
        publish({
          status: isCredentialBindingRequired(error) ? 'binding_required' : 'scope_denied',
          reason_code: code.slice(1, -1),
        });
      } else {
        // Actual provider availability can recover without an identity change.
        publish({ status: 'unavailable', reason_code: 'BACKEND_REFRESH_FAILED' });
      }
      return false;
    }
  }

  return {
    refresh,
    snapshot: (): SupervisorReasoningReadiness => ({ ...state }),
    reset: (): void => {
      state = { status: 'uninitialized' };
      attempted = false;
      lastNotice = undefined;
    },
  };
}
