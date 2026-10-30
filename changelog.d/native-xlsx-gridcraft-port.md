---
category: Changed
---

- **Native XLSX engine / reader** — SpreadsheetML ST_Xstring (`_xHHHH_`) round-trip, `workbookPr/@date1904` + `t="d"` ISO→serial, builtin numFmt ids (incl. 14/22 and currency/accounting), rich `inlineStr`, recomputed `<dimension>`, and `<tableParts>` binding for written tables. Also: sheet hyperlinks + comments/`legacyDrawing` distill/write, SST `rPh`/`phoneticPr` passthrough, and drawing text in markdown. Portable pieces aligned with [GridCraft](https://github.com/storytold/gridcraft) (`xlsx` / `numfmt`, MIT OR Apache-2.0).
