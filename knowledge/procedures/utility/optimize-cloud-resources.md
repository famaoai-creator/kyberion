# Procedure: Cloud Resource & Cost Optimization

## 1. Goal
Analyze cloud infrastructure definitions (Terraform, AWS CLI output) to identify unused resources and estimate monthly expenditure.

## 2. Dependencies
- **Actuator**: `File-Actuator` (Resource Discovery)
- **Actuator**: `Modeling-Actuator` (Cost Estimation)

## 3. Step-by-Step Instructions
1.  **Discovery**: Use `File-Actuator` to scan `terraform/` directories for resource declarations (`resource "aws_..."`).
2.  **Inventory**: Extract instance types, storage sizes, and region data.
3.  **Cost Estimation**: 
    - Input the inventory into `Modeling-Actuator` using the `financial_projection` model.
    - Apply pricing unit variables (e.g., $0.05/hr for t3.medium).
4.  **Waste Hunting**: Search for "deprecated" or "unattached" patterns in infrastructure logs using `File-Actuator`.
5.  **Reporting**: Export the savings roadmap using `Media-Actuator`.

## 4. Expected Output
A high-fidelity cost breakdown and a list of recommended resource deletions.
