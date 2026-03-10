/**
 * Data Utils Core Library.
 * Abstracted from the legacy data-transformer skill.
 */
export type DataFormat = 'json' | 'yaml' | 'csv';
export declare function detectFormat(filePath: string): DataFormat;
export declare function parseData(content: string, format: DataFormat): any;
export declare function stringifyData(data: any, format: DataFormat): string;
//# sourceMappingURL=data-utils.d.ts.map