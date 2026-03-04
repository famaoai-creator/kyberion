/**
 * Excel Theme Resolver - Extracts theme color palette from Excel XML.
 */
export interface ThemePalette {
    [key: number]: string;
}
/**
 * Parses xl/theme/theme1.xml from a .xlsx file and returns a mapping of theme indices to ARGB.
 */
export declare function extractThemePalette(filePath: string): Promise<ThemePalette>;
//# sourceMappingURL=excel-theme-resolver.d.ts.map