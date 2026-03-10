# Procedure: Tech Due Diligence & IP Strategy

## 1. Goal
Execute a technical due diligence audit and identify patentable intellectual property within a codebase.

## 2. Dependencies
- **Actuator**: `File-Actuator` (Discovery)
- **Actuator**: `Modeling-Actuator` (Scoring)

## 3. Step-by-Step Instructions
1.  **Code Discovery**: Use `File-Actuator` with `ip-scan.md` patterns to find unique algorithms or protocols.
2.  **Architecture Review**: List dependencies using `map-dependencies.md` to identify external risks.
3.  **Risk/Value Scoring**: 
    - Input the discovered assets into `Modeling-Actuator` using the `tech_dd` model.
    - Evaluate complexity, uniqueness, and commercial viability.
4.  **Strategy Drafting**: Generate a roadmap for patent filing or technical debt remediation.

## 4. Expected Output
A comprehensive Tech DD report and prioritized IP filing strategy.
