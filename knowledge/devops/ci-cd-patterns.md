# CI/CD Pipeline Design Patterns

Reference guide for continuous integration and continuous delivery pipeline design, covering workflow patterns, testing strategies, deployment techniques, and observability.

---

## 1. Pipeline Design Patterns

### Linear Pipeline

The simplest pattern: Build -> Test -> Deploy. Suitable for small projects with a single deployment target.

```
[Commit] -> [Build] -> [Unit Tests] -> [Integration Tests] -> [Deploy to Staging] -> [Deploy to Production]
```

### Fan-Out / Fan-In

Parallelize independent jobs to reduce total pipeline duration. Fan out for parallel test suites, fan in for a final deployment gate.

```
                 +--> [Unit Tests]     --+
[Build] -------> +--> [Lint / Format]  --+--> [Deploy]
                 +--> [Security Scan]  --+
```

### Diamond Pipeline

A variation where parallel branches have different merge points before final deployment.

```
[Build] -> [Unit Tests] ---------> [Integration Gate] -> [Deploy Staging] -> [Deploy Prod]
       \-> [Security Scan] ----/
       \-> [E2E Tests] -------/
```

### Environment Promotion

Code artifacts are promoted through environments rather than rebuilt. The same binary is deployed to dev, staging, and production, ensuring consistency.

```
[Build Artifact] -> [Deploy Dev] -> [Smoke Tests] -> [Deploy Staging] -> [QA Sign-off] -> [Deploy Prod]
```

---

## 2. GitHub Actions Best Practices

### Workflow Organization

- **One workflow per concern**: Separate CI, CD, and maintenance workflows into distinct YAML files.
- **Reusable workflows**: Extract common patterns into reusable workflows with `workflow_call`.
- **Composite actions**: Bundle repeated steps into composite actions stored in `.github/actions/`.

### Performance Optimization

- **Cache dependencies**: Use `actions/cache` for node_modules, pip packages, and build artifacts.
- **Concurrency control**: Cancel redundant runs with `concurrency` groups.
- **Matrix builds**: Test across multiple OS/version combinations efficiently.

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    strategy:
      matrix:
        node-version: [18, 20, 22]
        os: [ubuntu-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - run: npm ci
      - run: npm test
```

### Security Hardening

- **Pin action versions by SHA**, not tags: `uses: actions/checkout@<full-sha>`.
- **Use `permissions`** to limit the GITHUB_TOKEN scope per job.
- **Store secrets in GitHub Secrets**, never in workflow files.
- **Use OIDC** for cloud provider authentication instead of long-lived credentials.

```yaml
permissions:
  contents: read
  pull-requests: write
  id-token: write # Required for OIDC
```

---

## 3. Testing Strategies in CI

### Test Pyramid in CI

| Layer                 | Scope                      | Speed                | CI Stage    | Trigger                |
| --------------------- | -------------------------- | -------------------- | ----------- | ---------------------- |
| **Unit Tests**        | Single function/module     | Fast (seconds)       | Every push  | All branches           |
| **Integration Tests** | Module interactions, DB    | Medium (minutes)     | Every push  | All branches           |
| **E2E Tests**         | Full user flows            | Slow (minutes-hours) | Pre-deploy  | Main/release branches  |
| **Smoke Tests**       | Critical paths post-deploy | Fast (seconds)       | Post-deploy | After every deployment |

### Test Execution Guidelines

- **Run fast tests first**: Fail early on unit tests before spending time on integration.
- **Parallelize test suites**: Split large test suites across multiple runners.
- **Use test impact analysis**: Only run tests affected by changed files when possible.
- **Enforce coverage gates**: Set minimum coverage thresholds (e.g., 80%) but prioritize meaningful tests over coverage numbers.

### Flaky Test Management

- **Quarantine flaky tests**: Move them to a separate suite that does not block deployment.
- **Track flake rate**: Monitor and report on test reliability over time.
- **Fix or delete**: Flaky tests that are not fixed within a sprint should be deleted or rewritten.

---

## 4. Deployment Strategies

### Blue-Green Deployment

Maintain two identical production environments. Deploy to the inactive environment, verify, then switch traffic.

- **Advantages**: Instant rollback (switch back to previous environment), zero-downtime deploys.
- **Considerations**: Requires double infrastructure capacity, database migrations must be backward-compatible.

```
[Load Balancer] --> [Blue (v1.0, active)]
                    [Green (v1.1, staged)] <-- deploy here, then switch
```

### Canary Deployment

Route a small percentage of traffic to the new version. Gradually increase if metrics are healthy.

- **Advantages**: Limits blast radius, real-world validation with production traffic.
- **Considerations**: Requires traffic splitting capability, monitoring must detect regressions quickly.

```
[Load Balancer] --> 95% --> [v1.0]
                --> 5%  --> [v1.1 canary]
```

### Rolling Deployment

Update instances incrementally, replacing old versions one at a time (or in batches).

- **Advantages**: No extra infrastructure, gradual rollout.
- **Considerations**: Mixed versions run simultaneously during rollout; APIs must be backward-compatible.

### Feature Flags

Decouple deployment from release. Deploy code with features disabled, then enable via configuration.

- **Advantages**: Deploy anytime, control release timing independently, A/B testing support.
- **Considerations**: Flag management overhead, clean up stale flags regularly.

---

## 5. Monitoring and Alerting in CI/CD

### Pipeline Observability

- **Track pipeline duration**: Monitor build/test/deploy times to detect degradation.
- **Measure mean time to recovery (MTTR)**: How quickly can a failed deployment be rolled back?
- **Track deployment frequency**: A key DORA metric; higher frequency correlates with better outcomes.
- **Change failure rate**: Percentage of deployments that cause incidents.

### Post-Deployment Monitoring

```yaml
# Example: Post-deploy smoke test and alerting step
- name: Post-deploy smoke tests
  run: |
    curl --fail --retry 3 --retry-delay 5 https://app.example.com/health
    curl --fail https://app.example.com/api/v1/status

- name: Notify on failure
  if: failure()
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      {"text": "Deployment failed for ${{ github.sha }}. Investigate immediately."}
```

### Alerting Principles

- **Alert on symptoms, not causes**: Alert on error rate spikes or latency increases, not on CPU usage alone.
- **Define severity levels**: P1 (page immediately), P2 (respond within 1 hour), P3 (next business day).
- **Automate rollback triggers**: If error rate exceeds threshold within N minutes of deployment, trigger automatic rollback.
- **Runbook links in alerts**: Every alert should link to a runbook with investigation steps.

---

## 6. CI/CD Anti-Patterns to Avoid

- **Manual gates in every pipeline**: Slows delivery without proportional risk reduction.
- **Rebuilding artifacts per environment**: Leads to "works in staging, breaks in production" scenarios.
- **Ignoring flaky tests**: Erodes trust in the pipeline and encourages skipping tests.
- **Long-running monolithic pipelines**: Break into smaller, independent pipelines per service or concern.
- **Deploying on Fridays without monitoring**: Schedule risky deployments when teams can respond quickly.
- **Missing rollback procedures**: Every deployment strategy must have a documented, tested rollback path.

---

## 7. Pipeline Configuration Checklist

- [ ] Dependencies are cached to reduce build times.
- [ ] Tests are parallelized and ordered by speed (unit first).
- [ ] Security scans are integrated (dependency audit, secret detection).
- [ ] Deployment artifacts are built once and promoted across environments.
- [ ] Rollback procedures are documented and tested.
- [ ] Post-deployment smoke tests verify critical paths.
- [ ] Alerts are configured for pipeline failures and deployment regressions.
- [ ] Secrets are managed through the platform's secret store, never hardcoded.
