# Procedure: Data Anonymization & Log Analysis

## 1. Goal
Sanitize data by removing PII/secrets and extract meaningful insights from execution logs.

## 2. Dependencies
- **Actuator**: `File-Actuator` (Scrubbing)
- **Actuator**: `Wisdom-Actuator` (Pattern Extraction)

## 3. Step-by-Step Instructions
1.  **Identification**: Use `File-Actuator` with `detect-sensitivity.md` to flag sensitive strings in the target log/dataset.
2.  **Anonymization**: Apply regex replacement using `File-Actuator` (write) to mask flagged strings with `[REDACTED]`.
3.  **Pattern Extraction**: Use `Wisdom-Actuator` (distill) to identify recurring error codes or performance bottlenecks in the sanitized logs.
4.  **Requirement Bridge**: If a log indicates a missing feature, generate a task in the `TASK_BOARD.md` using `File-Actuator`.

## 4. Expected Output
A sanitized, auditable log file and a summary of extracted operational patterns.
