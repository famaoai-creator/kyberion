import { PptxDesignProtocol } from './types/pptx-protocol';
import { generateNativePptx } from './src/native-pptx-engine/engine';
export declare function distillPptxDesign(sourcePath: string, extractAssetsDir?: string): Promise<PptxDesignProtocol>;
export { generateNativePptx as generatePptxWithDesign };
//# sourceMappingURL=pptx-utils.d.ts.map