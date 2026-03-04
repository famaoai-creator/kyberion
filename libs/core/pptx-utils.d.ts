import PptxGenJS from 'pptxgenjs';
import { PptxDesignProtocol } from './types/pptx-protocol';
/**
 * Distills a PPTX file into a portable Design Protocol (ADF)
 */
export declare function distillPptxDesign(sourcePath: string, extractAssetsDir?: string): Promise<PptxDesignProtocol>;
/**
 * Re-generates a PPTX from a Design Protocol (ADF)
 */
export declare function generatePptxWithDesign(protocol: PptxDesignProtocol, assetsDir?: string): Promise<PptxGenJS>;
//# sourceMappingURL=pptx-utils.d.ts.map