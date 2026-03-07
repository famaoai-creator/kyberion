# Procedure: File Diff Visualization

## 1. Goal
Identify and visualize the differences between two versions of a file or two distinct files.

## 2. Dependencies
- **Actuator**: `File-Actuator`

## 3. Step-by-Step Instructions
1.  Identify the two source paths (e.g., `original.ts` and `modified.ts`).
2.  Use `File-Actuator` with the `read` action for both files.
3.  Calculate the diff using the agent's internal comparison logic (e.g., `git diff` style output).
4.  Optionally, use `File-Actuator` with `write` to save the resulting patch or diff report.

## 4. Expected Output
A structured diff report showing additions, deletions, and modifications.
