---
title: "Procedure: Security Incident Response"
tags: [capability, security, procedure, incident-response, compliance]
importance: 10
author: Ecosystem Architect
last_updated: 2026-04-14
kind: capability
scope: global
authority: policy
phase: [execution]
role_affinity: [ceo, security_engineer, solution_architect]
applies_to: [system-actuator, browser-actuator, approval-actuator]
owner: security_engineer
status: active
---

# Procedure: Security Incident Response

## 1. Goal
Detect, investigate, contain, and report security incidents through a governed, auditable workflow.

## 2. Dependencies
- **Actuators**: `system-actuator`, `browser-actuator`, `approval-actuator`, `media-actuator`
- **Sensors**: `log-watcher.adf.json` (continuous log monitoring)
- **Governance**: All response actions require approval via `enforceApprovalGate()`

## 3. Incident Lifecycle

### Phase 1: Detection
Triggered by log-watcher sensor or manual alert.

```json
{ "type": "capture", "op": "shell", "params": { "cmd": "grep -i 'CRITICAL\\|UNAUTHORIZED\\|BREACH' /var/log/syslog | tail -50", "export_as": "alert_logs" } }
```

Or via monitoring dashboard:
```json
{ "type": "capture", "op": "goto", "params": { "url": "{{monitoring_dashboard_url}}" } },
{ "type": "capture", "op": "snapshot", "params": { "export_as": "dashboard_state" } }
```

### Phase 2: Investigation
Collect evidence and determine scope.

```json
{ "type": "capture", "op": "shell", "params": { "cmd": "gh api repos/{{org}}/{{repo}}/security-advisories", "export_as": "advisories" } }
```

```json
{ "type": "capture", "op": "shell", "params": { "cmd": "docker logs {{container_id}} --since '1h' 2>&1 | grep -i error", "export_as": "container_errors" } }
```

```json
{ "type": "capture", "op": "shell", "params": { "cmd": "aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=ConsoleLogin --max-items 20", "export_as": "login_events" } }
```

### Phase 3: Classification
Severity levels and automatic escalation:

| Severity | Criteria | Response |
|----------|----------|----------|
| P1 Critical | Data breach, unauthorized access to production | Immediate isolation + CEO notification |
| P2 High | Vulnerability with active exploit | Patch within 24h + team notification |
| P3 Medium | Configuration drift, policy violation | Remediate within 72h |
| P4 Low | Informational alert, audit finding | Track and review |

### Phase 4: Response (Approval Required)
All response actions pass through `enforceApprovalGate()`.

**Credential Revocation:**
```json
{ "type": "apply", "op": "shell", "params": { "cmd": "aws iam update-access-key --access-key-id {{key_id}} --status Inactive --user-name {{user}}" } }
```

**Service Isolation:**
```json
{ "type": "apply", "op": "shell", "params": { "cmd": "kubectl scale deployment {{deployment}} --replicas=0 -n {{namespace}}" } }
```

**Security Group Update:**
```json
{ "type": "apply", "op": "shell", "params": { "cmd": "aws ec2 revoke-security-group-ingress --group-id {{sg_id}} --protocol tcp --port {{port}} --cidr {{cidr}}" } }
```

### Phase 5: Reporting
Generate incident report document.

```json
{ "type": "capture", "op": "document_digest", "params": { "from": "investigation_evidence", "export_as": "evidence_digest" } }
```

Report includes:
- Timeline of events
- Affected systems and data
- Actions taken
- Root cause analysis
- Preventive measures

## 4. Monitoring Setup

The `log-watcher.adf.json` sensor provides continuous monitoring:
- Watches for keywords: ERROR, CRITICAL, FAILED, UNAUTHORIZED, BREACH
- Triggers alert pipeline on match
- Evidence is captured and staged for investigation

## 5. Compliance
- All actions logged to audit-chain (tamper-evident hash chain)
- Evidence preserved in `active/evidence/incidents/`
- Reports archived to `knowledge/confidential/` (tier-2 data isolation)
- FISC compliance: incident handling per FISC安全対策基準
