export function generateTheme(colors: { [key: string]: string } = {}): string {
  const defaultColors: { [key: string]: string } = {
    dk1: "000000",
    lt1: "FFFFFF",
    dk2: "44546A",
    lt2: "E7E6E6",
    accent1: "5B9BD5",
    accent2: "ED7D31",
    accent3: "A5A5A5",
    accent4: "FFC000",
    accent5: "4472C4",
    accent6: "70AD47",
    hlink: "0563C1",
    folHlink: "954F72",
    ...colors
  };

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="${defaultColors.dk1}"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="${defaultColors.lt1}"/></a:lt1>
      <a:dk2><a:srgbClr val="${defaultColors.dk2}"/></a:dk2>
      <a:lt2><a:srgbClr val="${defaultColors.lt2}"/></a:lt2>
      <a:accent1><a:srgbClr val="${defaultColors.accent1}"/></a:accent1>
      <a:accent2><a:srgbClr val="${defaultColors.accent2}"/></a:accent2>
      <a:accent3><a:srgbClr val="${defaultColors.accent3}"/></a:accent3>
      <a:accent4><a:srgbClr val="${defaultColors.accent4}"/></a:accent4>
      <a:accent5><a:srgbClr val="${defaultColors.accent5}"/></a:accent5>
      <a:accent6><a:srgbClr val="${defaultColors.accent6}"/></a:accent6>
      <a:hlink><a:srgbClr val="${defaultColors.hlink}"/></a:hlink>
      <a:folHlink><a:srgbClr val="${defaultColors.folHlink}"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectLst/><a:effectLst/><a:effectLst/></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;
}