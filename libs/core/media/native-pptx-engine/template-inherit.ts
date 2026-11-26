/**
 * Template inheritance: turn an extracted deck design (`distillPptxDesign` /
 * `media:pptx_extract`) into a protocol for NEW slides that keep the source
 * deck's masters, layouts, theme and master/layout media (logo, footer, page
 * number placeholders).
 *
 * Why each field is dropped:
 * - `rawParts` — when present the engine rebuilds the original package and only
 *   swaps `<a:t>` text in slides that carry `rawSlideXml`; added elements are
 *   ignored and new slides are dropped.
 * - per-slide `rawSlideXml` / `rawSlideRelsXml` / `notesXml` and element
 *   `pXmlLst` — they describe the source deck's slides, not the new ones.
 *
 * Kept: `rawMasters` / `rawMasterXml` / `rawLayouts` / `rawThemeXml` /
 * `masterMedia`, `canvas`, `theme`, `master`, `extensions`.
 *
 * Source slides are not carried over: without `rawParts` the engine writes
 * every slide from `elements`, so a "kept" slide would be a lossy semantic
 * copy, not the original. Use `pptx_filter_slides` / `pptx_replace_slides` to
 * keep original slides.
 */
import type { PptxDesignProtocol, PptxElement, PptxSlide } from '../../contracts/pptx-protocol.js';

export interface InheritTemplateSlideInput {
  elements: PptxElement[];
  /** 1-based index into the template's layouts (`rawLayouts`). */
  layoutIndex?: number;
  /** 1-based slide number in the template whose layout this slide reuses. */
  layout_from_slide?: number;
  /** Layout name as stored in the template (`<p:cSld name="…">`), e.g. "Title Only". */
  layout_name?: string;
  id?: string;
  notes?: string;
  background?: string;
  backgroundFill?: string;
  bgXml?: string;
  transitionXml?: string;
  extensions?: string;
}

export interface InheritPptxTemplateResult {
  design: PptxDesignProtocol;
  /** Layout index (1-based) chosen for each new slide, in order. */
  layoutIndices: number[];
}

const LABEL = 'inheritPptxTemplate';

function fail(what: string, next: string, evidence: string): never {
  throw new Error(`${LABEL}: ${what} | next: ${next} | evidence: ${evidence}`);
}

function stripElement(element: PptxElement): PptxElement {
  const { pXmlLst: _pXmlLst, ...rest } = element;
  return rest;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function resolveLayoutIndex(
  design: PptxDesignProtocol,
  slide: InheritTemplateSlideInput,
  position: number
): number {
  const layouts = design.rawLayouts ?? [];
  const count = layouts.length;
  const range = `1..${count} (${layouts.map((l, i) => `${i + 1}=${l.name}`).join(', ')})`;
  const where = `slides[${position - 1}]`;

  const given = [
    slide.layoutIndex !== undefined,
    slide.layout_from_slide !== undefined,
    slide.layout_name !== undefined,
  ].filter(Boolean).length;
  if (given > 1) {
    fail(
      `${where} names its layout more than once — the choice is ambiguous`,
      'give only one of layoutIndex, layout_from_slide or layout_name',
      `layoutIndex=${slide.layoutIndex} layout_from_slide=${slide.layout_from_slide} layout_name=${slide.layout_name}`
    );
  }

  let index: number;
  if (slide.layout_name !== undefined) {
    const found = layouts.findIndex((l) => l.name === slide.layout_name);
    if (found < 0) {
      fail(
        `${where}.layout_name '${slide.layout_name}' is not a layout of the template`,
        `use one of the template layouts ${range}`,
        `layout_name=${slide.layout_name}`
      );
    }
    index = found + 1;
  } else if (slide.layout_from_slide !== undefined) {
    const sourceCount = design.slides?.length ?? 0;
    if (!isPositiveInteger(slide.layout_from_slide) || slide.layout_from_slide > sourceCount) {
      fail(
        `${where}.layout_from_slide is not a slide of the template`,
        `use a template slide number in 1..${sourceCount}`,
        `layout_from_slide=${slide.layout_from_slide}`
      );
    }
    const sourceLayout = design.slides[slide.layout_from_slide - 1].layoutIndex;
    if (sourceLayout === undefined) {
      fail(
        `${where}.layout_from_slide=${slide.layout_from_slide}: the template slide has no layout relationship`,
        `set layoutIndex explicitly (${range})`,
        `template slide ${slide.layout_from_slide} id=${design.slides[slide.layout_from_slide - 1].id}`
      );
    }
    index = sourceLayout;
  } else if (slide.layoutIndex !== undefined) {
    index = slide.layoutIndex;
  } else {
    // Engine default (title layout first, content layout after), bounded to
    // what the template actually has.
    index = Math.min(position === 1 ? 1 : 2, count);
  }

  if (!isPositiveInteger(index) || index > count) {
    fail(
      `${where} resolves to layout ${index}, which the template does not have`,
      `use a layout index in ${range}`,
      `resolved layoutIndex=${index}`
    );
  }
  return index;
}

/**
 * Build a protocol for new slides on top of an extracted template design.
 * Pure: the input design and slides are deep-cloned, never mutated.
 */
export function inheritPptxTemplate(
  design: PptxDesignProtocol | undefined | null,
  slides: InheritTemplateSlideInput[] | undefined | null
): InheritPptxTemplateResult {
  if (!design || typeof design !== 'object') {
    fail(
      'no template design was given',
      'extract the template first (media:pptx_extract) and pass its result',
      `design=${design === null ? 'null' : typeof design}`
    );
  }
  if (!Array.isArray(design.rawLayouts) || design.rawLayouts.length === 0) {
    fail(
      'the design has no raw layouts — it is not an extracted PPTX template',
      'pass the output of media:pptx_extract (distillPptxDesign), not a generated protocol',
      `rawLayouts=${design.rawLayouts === undefined ? 'absent' : 'empty'}`
    );
  }
  if (!design.rawMasters?.length && !design.rawMasterXml) {
    fail(
      'the design has no raw slide master — layouts cannot be inherited without it',
      'pass the output of media:pptx_extract (distillPptxDesign)',
      'rawMasters and rawMasterXml are both absent'
    );
  }
  if (!Array.isArray(slides) || slides.length === 0) {
    fail(
      'no slides were given — the result would be an empty deck',
      'pass at least one slide { elements, layoutIndex | layout_from_slide | layout_name }',
      `slides=${Array.isArray(slides) ? 'empty array' : typeof slides}`
    );
  }
  slides.forEach((slide, i) => {
    if (!slide || typeof slide !== 'object' || !Array.isArray(slide.elements)) {
      fail(
        `slides[${i}] has no elements array`,
        'give every slide an elements array (it may be empty for a layout-only slide)',
        `slides[${i}]=${JSON.stringify(slide)?.slice(0, 120)}`
      );
    }
  });

  const source = structuredClone(design) as PptxDesignProtocol;
  const inputSlides = structuredClone(slides) as InheritTemplateSlideInput[];
  delete source.rawParts;

  const layoutIndices: number[] = [];
  const newSlides: PptxSlide[] = inputSlides.map((input, i) => {
    const layoutIndex = resolveLayoutIndex(source, input, i + 1);
    layoutIndices.push(layoutIndex);
    const {
      layout_from_slide: _fromSlide,
      layout_name: _name,
      layoutIndex: _index,
      elements,
      id,
      ...rest
    } = input;
    const slide: PptxSlide = {
      ...(rest as Omit<PptxSlide, 'id' | 'elements'>),
      id: id || `slide${i + 1}.xml`,
      elements: elements.map(stripElement),
      layoutIndex,
    };
    delete slide.rawSlideXml;
    delete slide.rawSlideRelsXml;
    delete slide.notesXml;
    return slide;
  });

  return { design: { ...source, slides: newSlides }, layoutIndices };
}
