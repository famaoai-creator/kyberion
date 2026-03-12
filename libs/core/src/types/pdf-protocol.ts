/**
 * PDF Design Protocol (ADF) — v4.0
 * Structured representation of PDF content for the Native PDF 2.0 Engine.
 * Covers P1 (Image, Page Labels), P2 (Outlines, Annotations, Graphics, Associated Files,
 * Form XObjects, Tagged PDF), and P3 (AcroForms, Layers, Linearization, Encryption,
 * PDF MAC, Digital Signatures, Document Parts).
 */

// ─── Layout Element ────────────────────────────────────────

export interface PdfLayoutElement {
  type: 'text' | 'image' | 'table' | 'heading';
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fontSize?: number;
  fontName?: string;
}

// ─── Image Element (ISO 32000-2 §8.9) ─────────────────────

export interface PdfImageElement {
  x: number;
  y: number;         // Top-down (engine converts to PDF coords)
  width: number;
  height: number;
  path: string;      // Absolute path to JPEG or PNG
}

// ─── Vector / Graphics Element (ISO 32000-2 §8.4, §8.5) ──

export type PdfVectorShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'path'; d: string };  // SVG-style 'M x y L x y Z ...'

export interface PdfVectorElement {
  shape: PdfVectorShape;
  /** Fill color as [R, G, B] 0-1 floats */
  fillColor?: [number, number, number];
  /** Stroke color */
  strokeColor?: [number, number, number];
  /** Line width in points */
  lineWidth?: number;
  /** Dash pattern [dashLen, gapLen] */
  dashPattern?: [number, number];
  /** Fill opacity 0.0-1.0 */
  fillOpacity?: number;
  /** Stroke opacity 0.0-1.0 */
  strokeOpacity?: number;
  /** Blend mode (PDF name, e.g. 'Multiply', 'Screen') */
  blendMode?: string;
}

// ─── Annotation (ISO 32000-2 §12.5) ───────────────────────

export type PdfAnnotationType = 'Link' | 'Text' | 'Square' | 'Circle' | 'Highlight';

export interface PdfAnnotationBase {
  type: PdfAnnotationType;
  /** Rectangle [x, y, width, height] in points (top-down Y) */
  rect: [number, number, number, number];
  /** Optional annotation color [R, G, B] 0-1 */
  color?: [number, number, number];
  /** Border width */
  borderWidth?: number;
  /** Opacity 0.0-1.0 */
  opacity?: number;
}

export interface PdfLinkAnnotation extends PdfAnnotationBase {
  type: 'Link';
  /** External URI */
  uri?: string;
  /** Go-to: 0-based page index */
  pageTarget?: number;
}

export interface PdfTextAnnotation extends PdfAnnotationBase {
  type: 'Text';
  content: string;
  title?: string;
}

export interface PdfShapeAnnotation extends PdfAnnotationBase {
  type: 'Square' | 'Circle';
  title?: string;
}

export interface PdfHighlightAnnotation extends PdfAnnotationBase {
  type: 'Highlight';
}

export type PdfAnnotation =
  | PdfLinkAnnotation
  | PdfTextAnnotation
  | PdfShapeAnnotation
  | PdfHighlightAnnotation;

// ─── Outline / Bookmarks (ISO 32000-2 §12.3.3) ────────────

export interface PdfOutlineItem {
  title: string;
  /** 0-based page index */
  pageIndex: number;
  /** Y position on page to scroll to (default: top) */
  top?: number;
  /** Zoom factor (default: fit page) */
  zoom?: number;
  children?: PdfOutlineItem[];
  /** true = collapsed by default */
  closed?: boolean;
}

// ─── Associated File (ISO 32000-2 §14.13, AN002) ──────────

export interface PdfAssociatedFile {
  /** Display name */
  name: string;
  /** Absolute path to file to embed */
  path: string;
  /** MIME type e.g. 'application/json' */
  mimeType?: string;
  /** AF relationship: e.g. 'Alternative', 'Supplement', 'Source', 'Data' */
  relationship?: 'Alternative' | 'Supplement' | 'Source' | 'Data' | 'Unspecified';
  /** Description string */
  description?: string;
}

// ─── Form XObject (ISO 32000-2 §8.10) ─────────────────────

export interface PdfFormXObject {
  /** Reference name used in content streams (e.g. 'Logo') */
  name: string;
  /** Bounding box [x, y, width, height] */
  bbox: [number, number, number, number];
  /** PDF content stream string */
  content: string;
}

// ─── Tagged PDF Structure (ISO 32000-2 §14.7, WTPDF 1.0) ──

export type PdfStructTag =
  | 'Document' | 'Sect' | 'P' | 'H' | 'H1' | 'H2' | 'H3'
  | 'L' | 'LI' | 'LBody' | 'Table' | 'TR' | 'TH' | 'TD'
  | 'Figure' | 'Formula' | 'Span' | 'Link' | 'Annot' | 'Art';

export interface PdfStructElement {
  tag: PdfStructTag;
  /** Optional alt text (for Figure) */
  alt?: string;
  /** Optional actual text */
  actualText?: string;
  /** Language tag e.g. 'ja', 'en' */
  lang?: string;
  children?: PdfStructElement[];
}

// ─── Page Label (ISO 32000-2 §12.4.2) ─────────────────────

export type PdfPageLabelStyle =
  | 'decimal' | 'roman-upper' | 'roman-lower'
  | 'alpha-upper' | 'alpha-lower' | 'none';

export interface PdfPageLabel {
  startIndex: number;
  style?: PdfPageLabelStyle;
  prefix?: string;
  startValue?: number;
}

// ─── Aesthetic Layer ───────────────────────────────────────

export interface PdfAesthetic {
  colors?: string[];
  fonts?: string[];
  layout?: 'single-column' | 'multi-column' | 'grid' | 'unknown';
  elements?: PdfLayoutElement[];
  branding?: {
    logoPresence: boolean;
    primaryColor?: string;
    tone?: 'professional' | 'creative' | 'technical' | 'casual';
  };
}

// ─── Page ─────────────────────────────────────────────────

export interface PdfPage {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  elements?: PdfLayoutElement[];
  /** Images */
  images?: PdfImageElement[];
  /** Vector graphics / shapes */
  vectors?: PdfVectorElement[];
  /** Annotations on this page */
  annotations?: PdfAnnotation[];
  /** Tagged content MCID mapping (optional) */
  markedContent?: Array<{ mcid: number; tag: PdfStructTag; text: string }>;
  /** Optional Content Group memberships for layer control */
  layerName?: string;
}

// ─── PDF Render Options ────────────────────────────────────

export interface PdfRenderOptions {
  compress?: boolean;
  unicode?: boolean;
  objectStreams?: boolean;
  xmpMetadata?: boolean;
  /** Emit /MarkInfo for Tagged PDF (default: auto if structTree present) */
  tagged?: boolean;
  /** Enable linearization (web-optimized output) */
  linearize?: boolean;
  /** Encryption configuration */
  encrypt?: PdfEncryptOptions;
}

// ─── PDF Composition Options ───────────────────────────────

export interface PdfCompositionOptions {
  outputPath: string;
  format?: 'A4' | 'A3' | 'Letter' | 'Legal';
  margin?: { top: string; bottom: string; left: string; right: string };
  headerHtml?: string;
  footerHtml?: string;
  printBackground?: boolean;
  landscape?: boolean;
  theme?: { title?: string; body?: string };
}

// ─── Root Protocol ─────────────────────────────────────────

export interface PdfDesignProtocol {
  version: string;
  generatedAt: string;

  source: {
    format: 'markdown' | 'html';
    body: string;
    title?: string;
  };

  content?: {
    text: string;
    pages: PdfPage[];
  };

  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modDate?: string;
    pageCount?: number;
    [key: string]: string | number | undefined;
  };

  /** Bookmarks / navigation tree (ISO 32000-2 §12.3.3) */
  outlines?: PdfOutlineItem[];

  /** Page labeling (ISO 32000-2 §12.4.2) */
  pageLabels?: PdfPageLabel[];

  /** Associated files / attachments (ISO 32000-2 §14.13) */
  associatedFiles?: PdfAssociatedFile[];

  /** Reusable Form XObjects (ISO 32000-2 §8.10) */
  formXObjects?: PdfFormXObject[];

  /** Tagged PDF structure tree (ISO 32000-2 §14.7) */
  structTree?: PdfStructElement;

  /** Interactive AcroForm fields (ISO 32000-2 §12.7) */
  acroForm?: PdfAcroForm;

  /** Optional Content Groups / Layers (ISO 32000-2 §8.11) */
  layers?: PdfLayer[];

  /** Digital signature (ISO/TS 32002:2022) */
  signature?: PdfSignatureOptions;

  /** Document Parts (ISO 32000-2 §14.12) */
  documentParts?: PdfDocumentPart[];

  aesthetic?: PdfAesthetic;
  compositionOptions?: PdfCompositionOptions;
  renderOptions?: PdfRenderOptions;
}

// ─── P3 Types ───────────────────────────────────────

// ─── P3-1: AcroForms (ISO 32000-2 §12.7) ───────────────

export type PdfFieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'button' | 'signature';

export interface PdfFormField {
  /** Unique field name */
  name: string;
  type: PdfFieldType;
  /** Rect [x, y, width, height] (top-down) */
  rect: [number, number, number, number];
  /** 0-based page index */
  pageIndex?: number;
  /** Default value */
  defaultValue?: string;
  /** Current value */
  value?: string;
  /** For checkbox/radio: true if checked */
  checked?: boolean;
  /** For dropdown/listbox: option entries */
  options?: string[];
  /** Field flags (e.g. 1=ReadOnly, 2=Required, 4=NoExport) */
  flags?: number;
  /** Font size in points (0 = auto) */
  fontSize?: number;
  /** Default Appearance string override */
  defaultAppearance?: string;
  /** Tooltip / user-facing name */
  tooltip?: string;
}

export interface PdfAcroForm {
  fields: PdfFormField[];
  /** Use NeedAppearances flag */
  needAppearances?: boolean;
  /** Default resources (DA string) */
  defaultDA?: string;
}

// ─── P3-2: Optional Content Groups / Layers (ISO 32000-2 §8.11) ─

export interface PdfLayer {
  /** Layer name (shown in PDF viewer Layers panel) */
  name: string;
  /** initial visibility */
  visible?: boolean;
  /** Layer intent: optional ('View', 'Design', 'All') */
  intent?: 'View' | 'Design' | 'All';
}

// ─── P3-4: Encryption (ISO/TS 32003:2023 + PDF 2.0 §7.6) ───

export type PdfEncryptAlgorithm = 'AES256' | 'AES-GCM';
export type PdfHashAlgorithm = 'SHA256' | 'SHA384' | 'SHA512' | 'SHA3-256' | 'SHA3-384' | 'SHA3-512';

export interface PdfEncryptOptions {
  algorithm?: PdfEncryptAlgorithm; // default: AES256
  userPassword?: string;           // empty = no user password
  ownerPassword?: string;          // required
  /** Permissions bits (bit 3=Print, 4=Modify, 5=Copy, 6=Annot, 9=Fill, 11=Extract, 12=Assemble, 13=PrintHQ) */
  permissions?: number;
  /** Hash algorithm for key derivation (ISO/TS 32001: SHA256+) */
  hashAlgorithm?: PdfHashAlgorithm;
}

// ─── P3-5: PDF MAC (ISO/TS 32004:2024) ────────────────

export interface PdfMacOptions {
  /** HMAC algorithm: default SHA256 */
  algorithm?: PdfHashAlgorithm;
  /** Secret key (hex string or Buffer source) */
  secretKey?: string;
}

// ─── P3-7: Digital Signatures (ISO/TS 32002:2022) ────────

export type PdfSignatureSubFilter =
  | 'adbe.pkcs7.detached'   // PKCS#7 detached (widest compat)
  | 'ETSI.CAdES.detached'   // CAdES (ISO/TS 32002)
  | 'ETSI.RFC3161';         // RFC 3161 timestamp token

export interface PdfSignatureOptions {
  subFilter?: PdfSignatureSubFilter;
  signerName?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** Field rect [x, y, w, h] for visible signature; undefined = invisible */
  rect?: [number, number, number, number];
  /** 0-based page index (default 0) */
  pageIndex?: number;
  /** PEM-encoded certificate (for placeholder + self-sign) */
  certPem?: string;
  /** PEM-encoded private key */
  keyPem?: string;
}

// ─── P3-8: Document Parts (ISO 32000-2 §14.12) ──────────

export interface PdfDocumentPart {
  /** Human-readable part name */
  name?: string;
  /** 0-based page indices in this part */
  pageIndices: number[];
  /** Metadata dict (key/value pairs) */
  metadata?: Record<string, string>;
  /** Child document parts (nesting) */
  children?: PdfDocumentPart[];
}
