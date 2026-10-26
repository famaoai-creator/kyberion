/** Match a refresh parser diagnostic using bounded, linear literal searches. */
export function isSupervisorRefreshContractFailure(message: string): boolean {
  const prefix = 'invalid_supervisor_response:';
  return message
    .toLowerCase()
    .split(/[\n\r\u2028\u2029]/u)
    .some((line) => {
      const start = line.indexOf(prefix);
      return (
        start !== -1 && line.indexOf('supervisor refresh result', start + prefix.length) !== -1
      );
    });
}

/** Transport loss cannot prove whether the remote model or its effects ran. */
export function isUncertainSupervisorTransportFailure(message: string): boolean {
  if (message.includes('[SUPERVISOR_PREASK_FAILED]')) return false;
  // Refresh is a pre-ask operation with no model turn; its typed parser error
  // is evidence of a contract failure rather than unknown task execution.
  if (isSupervisorRefreshContractFailure(message)) return false;
  return /invalid_supervisor_response|supervisor_response_closed|supervisor_request_timeout|agent_runtime_supervisor_not_available|\bECONNRESET\b|\bEPIPE\b/iu.test(
    message
  );
}
