---
category: Fixed
---

- **Extraction steps no longer produce a false-failing success condition** — an extracted region without an accessible name is recorded with its role as the name (e.g. `table`); the browser compiler used that role word as a text the page must show, so a correct run could fail its golden check. Such conditions now carry no text needle.
