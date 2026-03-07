# Procedure: Unit Economics Optimization

## 1. Goal
Analyze the unit economics (LTV, CAC, Payback Period) of a business model to assess its sustainability and growth potential.

## 2. Dependencies
- **Actuator**: `Modeling-Actuator`

## 3. Step-by-Step Instructions
1.  **Gather Data**: Define customer segments, churn rate, average revenue per user (ARPU), and marketing spend.
2.  **Model Configuration**: Use `Modeling-Actuator` with the `unit_economics` model.
    ```json
    {
      "model": "unit_economics",
      "data": {
        "segments": [
          { "name": "Standard", "ltv": 1200, "cac": 300 }
        ]
      }
    }
    ```
3.  **Analysis**: Review the LTV/CAC ratio and payback period.
4.  **Reporting**: Export findings to a Media artifact if needed.

## 4. Expected Output
A quantitative assessment of business unit health and strategic recommendations.
