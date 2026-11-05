/** Domain barrel — public surface for libs/core/media */
export * from './document-reader.js';
export * from './docx-utils.js';
export * from './image-description-bridge.js';
export * from './image-description-types.js';
export * from './image-dhash.js';
export * from './media-backend-registry.js';
export * from './native-op-mapping.js';
export * from './native-subagent-adopter.js';
export * from './native-tts.js';
// skipped './pdf-utils.js' (all exports shadowed)
export { generatePptxWithDesign } from './pptx-utils.js';
export { extractTablesFromPage } from './protocol-to-markdown.js';
export * from './xlsx-number-format.js';
// skipped './xlsx-utils.js' (all exports shadowed)
// skipped './native-xlsx-engine/engine.js' (all exports shadowed)
export * from './native-pptx-engine/builders.js';
// skipped './native-pptx-engine/content-types.js' (all exports shadowed)
export * from './native-pptx-engine/design-cascade.js';
// skipped './native-pptx-engine/engine.js' (all exports shadowed)
export * from './native-pptx-engine/presentation.js';
export {
  generatePresentationRels,
  generateSlideRels,
  generateLayoutRels,
  generateMasterRels,
} from './native-pptx-engine/rels.js';
export * from './native-pptx-engine/theme.js';
// skipped './native-pdf-engine/engine.js' (all exports shadowed)
export * from './native-pdf-engine/parser.js';
// skipped './native-docx-engine/engine.js' (all exports shadowed)
