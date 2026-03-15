# Procedure: Web Automation & Navigation

## 1. Goal
Interact with web applications, extract content, and execute complex browser scenarios using Playwright.

## 2. Dependencies
- **Actuator**: `Browser-Actuator`

## 3. Step-by-Step Instructions
1.  **Simple Extraction**: Use `extract` to retrieve the HTML or text content of a page.
    ```json
    {
      "action": "extract",
      "url": "https://example.com",
      "output_path": "active/shared/tmp/browser/example_content.html"
    }
    ```
2.  **Screenshot**: Use `screenshot` to capture visual evidence of a page's state.
3.  **Scenario Execution**: For complex interactions (login, form submission), define a structured scenario array.
    ```json
    {
      "action": "execute_scenario",
      "scenario": [
        { "action": "goto", "url": "https://example.com/login" },
        { "action": "fill", "selector": "#username", "text": "admin" },
        { "action": "click", "selector": "#submit" }
      ]
    }
    ```

## 4. Expected Output
State changes within the web application, extracted content, or visual evidence (screenshots).
