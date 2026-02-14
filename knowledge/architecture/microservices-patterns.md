# Microservices Design Patterns

Reference guide for microservices architecture, covering core design patterns, communication strategies, data management, service discovery, and observability.

---

## 1. Core Microservices Design Patterns

### API Gateway

A single entry point for all client requests. Routes, aggregates, and transforms requests before forwarding to downstream services.

- **Responsibilities**: Request routing, authentication, rate limiting, response aggregation, protocol translation.
- **Tools**: Kong, AWS API Gateway, Envoy, NGINX, Traefik.
- **Consideration**: Avoid turning the gateway into a monolithic "god service." Keep transformation logic minimal.

### Circuit Breaker

Prevents cascading failures by stopping requests to a failing service. Transitions through Closed -> Open -> Half-Open states.

```
[Closed] --failures exceed threshold--> [Open] --timeout expires--> [Half-Open]
   ^                                                                     |
   +-------------- success in half-open --------------------------------+
   +-------------- failure in half-open --> [Open] ----------------------+
```

- **Implementation**: Use libraries like `opossum` (Node.js), Resilience4j (Java), or Polly (.NET).
- **Configuration**: Set failure thresholds, timeout durations, and half-open retry counts based on SLA requirements.
- **Fallback strategies**: Return cached data, default values, or a degraded response when the circuit is open.

### Saga Pattern

Manages distributed transactions across multiple services using a sequence of local transactions with compensating actions for rollback.

**Choreography-based Saga**: Each service publishes events and listens for events from other services.

```
[Order Service] --OrderCreated--> [Payment Service] --PaymentCompleted--> [Inventory Service]
                                  --PaymentFailed--> [Order Service: Cancel]
```

**Orchestration-based Saga**: A central orchestrator coordinates the saga steps and handles compensation.

```
[Saga Orchestrator] --> [Order Service: Create]
                    --> [Payment Service: Charge]
                    --> [Inventory Service: Reserve]
                    --> On failure: Compensate in reverse order
```

- **Choreography**: Better for simple flows with few services; avoids a central point of failure.
- **Orchestration**: Better for complex flows; provides clear visibility into the saga state.

### Strangler Fig

Incrementally migrate a monolith to microservices by routing traffic from the old system to new services one feature at a time.

- **Approach**: Place a facade (often the API gateway) in front of the monolith. Redirect routes to new services as they are built.
- **Advantage**: Reduces risk by avoiding a "big bang" rewrite.

### Bulkhead

Isolate components so that a failure in one does not cascade to others. Inspired by ship hull compartments.

- **Thread pool isolation**: Assign separate thread pools per downstream dependency.
- **Resource limits**: Use container resource quotas to prevent one service from consuming all cluster resources.

---

## 2. Service Communication Patterns

### Synchronous Communication

| Pattern     | Protocol          | Use Case                                          | Trade-off                                          |
| ----------- | ----------------- | ------------------------------------------------- | -------------------------------------------------- |
| **REST**    | HTTP/JSON         | CRUD operations, public APIs                      | Simple but can create tight coupling               |
| **gRPC**    | HTTP/2 + Protobuf | Internal service-to-service, high throughput      | Fast binary protocol, requires schema management   |
| **GraphQL** | HTTP/JSON         | Client-driven queries, BFF (Backend for Frontend) | Flexible queries but complex server implementation |

### Asynchronous Communication

| Pattern             | Mechanism           | Use Case                                 | Trade-off                                         |
| ------------------- | ------------------- | ---------------------------------------- | ------------------------------------------------- |
| **Message Queue**   | RabbitMQ, SQS       | Task distribution, work queues           | Decoupled but adds operational complexity         |
| **Event Streaming** | Kafka, Kinesis      | Event sourcing, real-time data pipelines | High throughput, requires event schema management |
| **Pub/Sub**         | SNS, Google Pub/Sub | Fan-out notifications                    | Loose coupling, eventual consistency              |

### Communication Guidelines

- **Prefer asynchronous communication** for operations that do not require an immediate response.
- **Use synchronous calls** only when the client needs an immediate result (e.g., user-facing reads).
- **Define clear API contracts**: Use OpenAPI for REST, Protobuf for gRPC, and AsyncAPI for event-driven interfaces.
- **Implement idempotency**: All message consumers must handle duplicate messages safely.
- **Set timeouts and retries**: Every synchronous call must have a timeout. Use exponential backoff with jitter for retries.

```javascript
// Idempotent message handler example
async function handleOrderEvent(event) {
  const existing = await db.query('SELECT id FROM processed_events WHERE event_id = $1', [
    event.id,
  ]);
  if (existing.rows.length > 0) return; // Already processed

  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO processed_events (event_id) VALUES ($1)', [event.id]);
    await processOrder(tx, event.payload);
  });
}
```

---

## 3. Data Management in Microservices

### Database per Service

Each microservice owns its database. No service directly accesses another service's database.

- **Benefits**: Independent schema evolution, technology freedom (SQL vs NoSQL per service), independent scaling.
- **Challenge**: Cross-service queries require API composition or event-driven synchronization.

### CQRS (Command Query Responsibility Segregation)

Separate the read model from the write model. Commands modify state; queries read from optimized views.

- **Write side**: Processes commands, validates business rules, persists events.
- **Read side**: Maintains denormalized projections optimized for query patterns.
- **Use when**: Read and write workloads have significantly different scaling or modeling requirements.

### Event Sourcing

Persist state changes as an immutable sequence of events rather than mutable records.

- **Benefits**: Complete audit trail, ability to reconstruct state at any point in time, natural fit for event-driven architectures.
- **Challenges**: Increased storage, eventual consistency, event schema evolution.

### Data Consistency Strategies

- **Strong consistency**: Use distributed transactions (2PC) only when absolutely necessary (rare in microservices).
- **Eventual consistency**: Accept temporary inconsistency; use sagas and compensation for cross-service operations.
- **Conflict resolution**: Use last-writer-wins, vector clocks, or domain-specific merge logic depending on requirements.

---

## 4. Service Discovery and Load Balancing

### Service Discovery Patterns

**Client-Side Discovery**: The client queries a service registry and selects an instance.

```
[Client] --> [Service Registry (Consul/Eureka)] --> returns [instance-1:8080, instance-2:8080]
[Client] --> [instance-1:8080]  (client picks one)
```

**Server-Side Discovery**: The client sends requests to a load balancer that queries the registry.

```
[Client] --> [Load Balancer / DNS] --> [Service Registry] --> [instance-1:8080]
```

**Platform-Provided Discovery**: Kubernetes Services, AWS ECS Service Discovery, or cloud-native DNS handle discovery transparently.

- **Recommendation**: Use platform-provided discovery (Kubernetes Services, cloud DNS) when available. It reduces operational overhead and integrates with health checks.

### Load Balancing Strategies

- **Round Robin**: Distributes requests evenly. Simple but ignores instance health and capacity.
- **Least Connections**: Routes to the instance with the fewest active connections. Better for variable-latency workloads.
- **Weighted**: Assigns weights based on instance capacity. Useful during canary deployments.
- **Consistent Hashing**: Routes based on a request attribute (e.g., user ID). Provides session affinity and cache locality.

### Health Checks

- **Liveness probes**: Detect deadlocked or crashed services. Restart the instance on failure.
- **Readiness probes**: Detect services that are not yet ready to accept traffic. Remove from load balancer until ready.
- **Startup probes**: Allow slow-starting services time to initialize before liveness checks begin.

```yaml
# Kubernetes health check example
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080
  initialDelaySeconds: 10
  periodSeconds: 15
readinessProbe:
  httpGet:
    path: /ready
    port: 8080
  initialDelaySeconds: 5
  periodSeconds: 10
```

---

## 5. Observability Patterns

### Three Pillars of Observability

**Distributed Tracing**: Track a single request as it flows across multiple services.

- **Tools**: Jaeger, Zipkin, AWS X-Ray, OpenTelemetry.
- **Implementation**: Propagate trace context headers (e.g., `traceparent` from W3C Trace Context) across all service boundaries.
- **Key metrics**: End-to-end latency, per-service latency breakdown, error attribution.

**Centralized Logging**: Aggregate logs from all services into a single searchable system.

- **Tools**: ELK Stack (Elasticsearch, Logstash, Kibana), Grafana Loki, Datadog, Splunk.
- **Structured logging**: Use JSON-formatted logs with consistent fields (timestamp, service name, trace ID, level, message).
- **Correlation**: Include the trace ID in every log entry to correlate logs with traces.

```javascript
// Structured logging example
const log = {
  timestamp: new Date().toISOString(),
  level: 'info',
  service: 'order-service',
  traceId: req.headers['x-trace-id'],
  message: 'Order created',
  orderId: order.id,
  userId: order.userId,
};
logger.info(log);
```

**Metrics and Dashboards**: Collect and visualize numerical measurements of system behavior.

- **Tools**: Prometheus + Grafana, Datadog, CloudWatch.
- **RED method**: Rate (requests/sec), Errors (error rate), Duration (latency percentiles).
- **USE method**: Utilization, Saturation, Errors -- for infrastructure resources.

### Alerting in Microservices

- **Service-level objectives (SLOs)**: Define target reliability (e.g., 99.9% availability, p99 latency under 200ms).
- **Error budgets**: Track remaining error budget. Slow down deployments when budget is low.
- **Alert on SLO burn rate**: Trigger alerts when the error budget is being consumed faster than expected.

---

## 6. Microservices Anti-Patterns to Avoid

- **Distributed Monolith**: Services are tightly coupled and must be deployed together. If changing one service requires changing others, the boundary is wrong.
- **Shared Database**: Multiple services reading/writing the same tables defeats the purpose of service independence.
- **Chatty Services**: Excessive synchronous calls between services. Refactor to use async events or aggregate into a single service.
- **Nano-services**: Services too small to justify the operational overhead. A service should represent a meaningful bounded context.
- **Missing API Versioning**: Breaking changes in APIs cascade failures. Use URL versioning (`/v1/`, `/v2/`) or content negotiation.
- **No Circuit Breakers**: A single slow dependency brings down the entire system. Always implement circuit breakers on outbound calls.
