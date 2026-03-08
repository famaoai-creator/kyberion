"use strict";
/**
 * Excel Theme Resolver - Extracts theme color palette from Excel XML.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractThemePalette = extractThemePalette;
const adm_zip_1 = __importDefault(require("adm-zip"));
/**
 * Parses xl/theme/theme1.xml from a .xlsx file and returns a mapping of theme indices to ARGB.
 */
async function extractThemePalette(filePath) {
    const palette = {};
    try {
        const zip = new adm_zip_1.default(filePath);
        const themeXmlEntry = zip.getEntry('xl/theme/theme1.xml');
        if (!themeXmlEntry)
            return palette;
        const xmlContent = themeXmlEntry.getData().toString('utf8');
        // Simple regex to extract accent colors. (dk1, lt1, accent1-6)
        // In a full implementation, this would use a robust XML parser.
        const clrSchemeMatch = xmlContent.match(/<a:clrScheme[^>]*>([\s\S]*?)<\/a:clrScheme>/);
        if (!clrSchemeMatch)
            return palette;
        const schemeXml = clrSchemeMatch[1];
        const srgbRegex = /<a:srgbClr val="([0-9A-F]{6})"\/>/g;
        let match;
        let idx = 0;
        // Excel internal theme index mapping (rough mapping for common accent colors)
        // 0: lt1, 1: dk1, 2: lt2, 3: dk2, 4-9: accent1-6
        const themeIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        while ((match = srgbRegex.exec(schemeXml)) !== null && idx < themeIndices.length) {
            palette[themeIndices[idx]] = 'FF' + match[1];
            idx++;
        }
        // Specifically handle accent6 for common green themes
        const accent6Match = schemeXml.match(/<a:accent6>.*?val="([0-9A-F]{6})"/s);
        if (accent6Match)
            palette[9] = 'FF' + accent6Match[1];
    }
    catch (err) {
        console.warn('[ExcelThemeResolver] Failed to extract theme:', err);
    }
    return palette;
}
//# sourceMappingURL=excel-theme-resolver.js.map