# Procedure: Financial Market Analysis (JPX, Trust Funds)

## 1. Goal
Fetch and analyze financial market data, including stock prices from JPX and net asset values of trust funds.

## 2. Dependencies
- **Actuator**: `Network-Actuator` (Data Fetching)
- **Actuator**: `Modeling-Actuator` (Statistical Analysis)

## 3. Step-by-Step Instructions
1.  **Data Fetching**: Use `Network-Actuator` to retrieve data from public financial APIs.
    - Example: `GET https://quote.jpx.co.jp/...`
2.  **Scraping (if API unavailable)**: Use `Browser-Actuator` to navigate to the fund page and extract the current price.
3.  **Analysis**:
    - Input the raw prices into `Modeling-Actuator` using the `financial_projection` model.
    - Calculate variance, growth rate, and risk scores.
4.  **Reporting**: Export the market summary using `Media-Actuator`.

## 4. Expected Output
A high-fidelity financial report with automated buy/sell or risk alerts.
