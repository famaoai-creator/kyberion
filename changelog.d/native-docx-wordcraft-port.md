---
category: Changed
---

- **Native DOCX engine / reader** — WordML escape (whitespace character refs), entity decode + clean on distill, `w:softHyphen` / `w:noBreakHyphen` / `w:cr` round-trip, text split into tab/break/hyphen elements on write, `lvlOverride`/`startOverride` distill, `w:sym` normalize + markdown surface, and image Content-Type Defaults from used media (webp/emf/wmf/svg). OMML (`m:oMath` / `m:oMathPara`) kept as rawXml with `m:t` markdown scrape; SmartArt `word/diagrams/**` passthrough + diagram-data text scrape. Portable pieces aligned with [WordCraft](https://github.com/storytold/wordcraft) (`docx` crate, MIT OR Apache-2.0).
