# Procedure: External SaaS Integration (Slack, Jira, Box)

## 1. Goal
Interact with external SaaS platforms to send messages, manage tasks, and synchronize files using the unified Reachability Layer.

## 2. Dependencies
- **Actuator**: `Service-Actuator`
- **Secrets**: `[SERVICE]_TOKEN` (e.g., `SLACK_TOKEN`, `JIRA_TOKEN`)

## 3. Step-by-Step Instructions
1.  **Slack Messaging**: Use `Service-Actuator` in `API` mode.
    ```json
    {
      "service_id": "slack",
      "mode": "API",
      "action": "chat.postMessage",
      "params": { "channel": "C123", "text": "Mission Status: 30 Karma" },
      "auth": "secret-guard"
    }
    ```
2.  **Jira Ticket Management**: Use `Service-Actuator` in `API` mode to update issue status.
3.  **Box File Operations**: 
    - If `box cli` is installed, use `CLI` mode for high-volume transfers.
    - Otherwise, use `API` mode for metadata extraction.
4.  **Google Workspace**: Use `Service-Actuator` with `auth: "session"` if browser login is required.

## 4. Expected Output
Physical state change in the target external service (e.g., message sent, ticket updated).
