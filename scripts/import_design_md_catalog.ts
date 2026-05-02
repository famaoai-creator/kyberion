import {
  createStandardYargs,
  pathResolver,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from "@agent/core";
import { readTextFile } from './refactor/cli-input.js';
import * as path from "node:path";

type CollectionEntry = {
  slug: string;
  label: string;
  category: string;
  description: string;
};

type PaletteToken = {
  group: string;
  name: string;
  value: string;
  description?: string;
};

type ImportedDesign = {
  design_system_id: string;
  theme_id: string;
  slug: string;
  name: string;
  category?: string;
  description?: string;
  source_path: string;
  source_repo: string;
  visual_theme?: string;
  fonts: Record<string, string>;
  palette: PaletteToken[];
  layout_principles: string[];
  component_sections: string[];
  prompt_guide: string[];
  keywords: string[];
};

const SOURCE_REPO = "https://github.com/VoltAgent/awesome-design-md";
const DEFAULT_SOURCE_DIR = "active/shared/tmp/awesome-design-md/design-md";
const README_PATH = "active/shared/tmp/awesome-design-md/README.md";
const THEMES_OUTPUT = "knowledge/public/design-patterns/media-templates/themes/design-md-imports.json";
const SYSTEMS_OUTPUT = "knowledge/public/design-patterns/media-templates/media-design-systems/design-md-imports.json";
const INDEX_OUTPUT = "knowledge/public/design-patterns/media-templates/design-md-catalog/index.json";

function walkDesignMdDirs(rootDir: string): string[] {
  const result: string[] = [];
  for (const entry of safeReaddir(rootDir)) {
    const fullPath = path.join(rootDir, entry);
    const stat = safeLstat(fullPath);
    if (!stat.isDirectory()) continue;
    const designPath = path.join(fullPath, "DESIGN.md");
    if (safeLstatSafe(designPath)?.isFile()) {
      result.push(fullPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function safeLstatSafe(targetPath: string) {
  try {
    return safeLstat(targetPath);
  } catch {
    return null;
  }
}

function normalizeId(prefix: string, value: string): string {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefix}${slug || "unknown"}`;
}

function parseCollectionMetadata(readmeText: string): Map<string, CollectionEntry> {
  const result = new Map<string, CollectionEntry>();
  let currentCategory = "";
  for (const rawLine of readmeText.split(/\r?\n/)) {
    const categoryMatch = rawLine.match(/^###\s+(.+?)\s*$/);
    if (categoryMatch) {
      currentCategory = categoryMatch[1]!.trim();
      continue;
    }
    const bulletMatch = rawLine.match(/^- \[\*\*(.+?)\*\*\]\([^)]+\/design-md\/([^/)]+)\/\)\s+-\s+(.+)$/);
    if (!bulletMatch) continue;
    const [, label, slug, description] = bulletMatch;
    result.set(String(slug), {
      slug: String(slug),
      label: String(label).trim(),
      category: currentCategory,
      description: String(description).trim(),
    });
  }
  return result;
}

function parseSections(markdown: string): Map<string, { body: string[]; subsections: Map<string, string[]> }> {
  const sections = new Map<string, { body: string[]; subsections: Map<string, string[]> }>();
  let currentSection: string | null = null;
  let currentSubsection: string | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const sectionMatch = rawLine.match(/^##\s+\d+\.\s+(.+?)\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!.trim();
      currentSubsection = null;
      sections.set(currentSection, { body: [], subsections: new Map() });
      continue;
    }
    const subsectionMatch = rawLine.match(/^###\s+(.+?)\s*$/);
    if (subsectionMatch && currentSection) {
      currentSubsection = subsectionMatch[1]!.trim();
      sections.get(currentSection)!.subsections.set(currentSubsection, []);
      continue;
    }
    if (!currentSection) continue;
    if (currentSubsection) {
      sections.get(currentSection)!.subsections.get(currentSubsection)!.push(rawLine);
    } else {
      sections.get(currentSection)!.body.push(rawLine);
    }
  }
  return sections;
}

function trimParagraph(lines: string[]): string {
  const collected: string[] = [];
  for (const line of lines.map((value) => value.trim())) {
    if (!line) {
      if (collected.length > 0) break;
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("|") || /^###\s/.test(line)) break;
    collected.push(line);
  }
  return collected.join(" ").trim();
}

function extractBullets(lines: string[]): string[] {
  return lines
    .map((line) => line.match(/^- (.+)$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function extractKeywords(values: Array<string | undefined>): string[] {
  const keywords = new Set<string>();
  for (const value of values) {
    for (const token of String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((item) => item.trim())
      .filter((item) => item.length >= 4)) {
      keywords.add(token);
    }
  }
  return Array.from(keywords).sort((left, right) => left.localeCompare(right));
}

function parsePalette(lines: string[], group: string): PaletteToken[] {
  const tokens: PaletteToken[] = [];
  for (const rawLine of lines) {
    const match = rawLine.match(/^- \*\*(.+?)\*\* \(`([^`]+)`\):\s*(.+)$/);
    if (!match) continue;
    const [, name, value, description] = match;
    tokens.push({
      group,
      name: String(name).trim(),
      value: String(value).trim(),
      description: String(description).trim(),
    });
  }
  return tokens;
}

function parseFonts(lines: string[]): Record<string, string> {
  const fonts: Record<string, string> = {};
  for (const rawLine of lines) {
    const match = rawLine.match(/^- \*\*(.+?)\*\*:\s+`([^`]+)`/);
    if (!match) continue;
    const label = match[1]!.trim().toLowerCase();
    const value = match[2]!.trim();
    if (label.includes("display") || label.includes("heading")) {
      fonts.heading = value;
    } else if (label.includes("body") || label.includes("text")) {
      fonts.body = value;
    } else if (label.includes("mono")) {
      fonts.mono = value;
    } else {
      fonts[label.replace(/[^a-z0-9]+/g, "_")] = value;
    }
  }
  return fonts;
}

function normalizeColor(value: string | undefined): string | undefined {
  const color = String(value || "").trim();
  if (!color) return undefined;
  return color;
}

function pickPaletteValue(palette: PaletteToken[], predicates: Array<(token: PaletteToken) => boolean>): string | undefined {
  for (const predicate of predicates) {
    const match = palette.find(predicate);
    if (match?.value) return normalizeColor(match.value);
  }
  return undefined;
}

function buildTheme(imported: ImportedDesign): any {
  const palette = imported.palette;
  const primary = pickPaletteValue(palette, [
    (token) => token.group === "Primary",
    (token) => /primary/i.test(token.name),
  ]) || "#111827";
  const secondary = pickPaletteValue(palette, [
    (token) => token.group === "Surface & Dark Variants",
    (token) => token.group === "Primary" && token.value !== primary,
    (token) => /secondary/i.test(token.name),
  ]) || primary;
  const accent = pickPaletteValue(palette, [
    (token) => token.group === "Interactive",
    (token) => /accent|blue|green|orange|purple|red/i.test(token.name),
  ]) || "#38bdf8";
  const background = pickPaletteValue(palette, [
    (token) => /background|light gray|white/i.test(token.name),
    (token) => token.group === "Primary" && /f5|f7|fa|ff/i.test(token.value),
  ]) || "#ffffff";
  const text = pickPaletteValue(palette, [
    (token) => token.group === "Text" && /near black|black|text/i.test(token.name),
    (token) => token.group === "Text" && !/white/i.test(token.name),
    (token) => /text/i.test(token.description || ""),
  ]) || "#111827";

  return {
    name: `${imported.name} (DESIGN.md)`,
    colors: {
      primary,
      secondary,
      accent,
      background,
      text,
    },
    fonts: {
      heading: imported.fonts.heading || imported.fonts.body || "Inter, sans-serif",
      body: imported.fonts.body || imported.fonts.heading || "System-ui, sans-serif",
      ...(imported.fonts.mono ? { mono: imported.fonts.mono } : {}),
    },
    metadata: {
      source_type: "design-md",
      source_repo: imported.source_repo,
      source_path: imported.source_path,
      category: imported.category,
      description: imported.description,
      visual_theme: imported.visual_theme,
      palette: imported.palette,
      layout_principles: imported.layout_principles,
      component_sections: imported.component_sections,
      prompt_guide: imported.prompt_guide,
      keywords: imported.keywords,
    },
  };
}

function inferTone(imported: ImportedDesign): string {
  const haystack = [imported.category, imported.description, imported.visual_theme].join(" ").toLowerCase();
  if (/(executive|institutional|enterprise|trust)/.test(haystack)) return "executive";
  if (/(developer|technical|terminal|infrastructure|code)/.test(haystack)) return "technical";
  if (/(cinematic|premium|luxury|dramatic)/.test(haystack)) return "premium";
  if (/(playful|friendly|creative|conversational)/.test(haystack)) return "friendly";
  return "reference";
}

function buildDesignSystem(imported: ImportedDesign): any {
  return {
    theme: imported.theme_id,
    profiles: [],
    branding: {
      tone: inferTone(imported),
      source_type: "design-md",
      brand_name: imported.name,
    },
    metadata: {
      source_type: "design-md",
      source_repo: imported.source_repo,
      source_path: imported.source_path,
      slug: imported.slug,
      category: imported.category,
      description: imported.description,
      visual_theme: imported.visual_theme,
      layout_principles: imported.layout_principles,
      component_sections: imported.component_sections,
      prompt_guide: imported.prompt_guide,
      keywords: imported.keywords,
    },
  };
}

function importDesignMd(dirPath: string, collectionMeta: Map<string, CollectionEntry>): ImportedDesign {
  const slug = path.basename(dirPath);
  const markdownPath = path.join(dirPath, "DESIGN.md");
  const markdown = readTextFile(markdownPath);
  const titleMatch = markdown.match(/^# Design System:\s+(.+?)\s*$/m);
  const title = titleMatch?.[1]?.trim() || slug;
  const sections = parseSections(markdown);
  const visualSection = sections.get("Visual Theme & Atmosphere");
  const colorsSection = sections.get("Color Palette & Roles");
  const typographySection = sections.get("Typography Rules");
  const layoutSection = sections.get("Layout Principles");
  const agentGuideSection = sections.get("Agent Prompt Guide");
  const componentsSection = sections.get("Component Stylings");
  const meta = collectionMeta.get(slug);

  const palette = colorsSection
    ? [...colorsSection.subsections.entries()].flatMap(([group, lines]) => parsePalette(lines, group))
    : [];
  const fonts = typographySection?.subsections.get("Font Family")
    ? parseFonts(typographySection.subsections.get("Font Family")!)
    : {};
  const componentSections = componentsSection
    ? [...componentsSection.subsections.keys()]
    : [];

  return {
    design_system_id: normalizeId("designmd-", slug),
    theme_id: normalizeId("designmd-", slug),
    slug,
    name: meta?.label || title,
    category: meta?.category,
    description: meta?.description,
    source_path: path.posix.join("design-md", slug, "DESIGN.md"),
    source_repo: SOURCE_REPO,
    visual_theme: trimParagraph(visualSection?.body || []),
    fonts,
    palette,
    layout_principles: extractBullets([
      ...(layoutSection?.body || []),
      ...[...((layoutSection?.subsections.values() || []) as IterableIterator<string[]>)].flat(),
    ]),
    component_sections: componentSections,
    prompt_guide: extractBullets([
      ...(agentGuideSection?.body || []),
      ...[...((agentGuideSection?.subsections.values() || []) as IterableIterator<string[]>)].flat(),
    ]),
    keywords: extractKeywords([
      slug,
      meta?.label,
      meta?.category,
      meta?.description,
      title,
      trimParagraph(visualSection?.body || []),
      ...componentSections,
    ]),
  };
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option("source", { type: "string", default: DEFAULT_SOURCE_DIR, description: "Directory containing awesome-design-md/design-md/*/DESIGN.md" })
    .option("readme", { type: "string", default: README_PATH, description: "awesome-design-md README path" })
    .parse();

  const sourceDir = path.resolve(pathResolver.rootDir(), String(argv.source));
  const readmePath = path.resolve(pathResolver.rootDir(), String(argv.readme));
  const collectionMeta = safeLstatSafe(readmePath)?.isFile()
    ? parseCollectionMetadata(readTextFile(readmePath))
    : new Map<string, CollectionEntry>();

  const imported = walkDesignMdDirs(sourceDir).map((dirPath) => importDesignMd(dirPath, collectionMeta));

  const themes = Object.fromEntries(imported.map((entry) => [entry.theme_id, buildTheme(entry)]));
  const systems = Object.fromEntries(imported.map((entry) => [entry.design_system_id, buildDesignSystem(entry)]));
  const index = {
    generated_at: new Date().toISOString(),
    source_repo: SOURCE_REPO,
    source_dir: path.relative(pathResolver.rootDir(), sourceDir),
    count: imported.length,
    systems: imported.map((entry) => ({
      design_system_id: entry.design_system_id,
      theme_id: entry.theme_id,
      slug: entry.slug,
      name: entry.name,
      category: entry.category,
      description: entry.description,
      source_path: entry.source_path,
      keywords: entry.keywords,
    })),
  };

  for (const outputPath of [THEMES_OUTPUT, SYSTEMS_OUTPUT, INDEX_OUTPUT]) {
    safeMkdir(path.dirname(path.resolve(pathResolver.rootDir(), outputPath)));
  }

  safeWriteFile(path.resolve(pathResolver.rootDir(), THEMES_OUTPUT), JSON.stringify({ themes }, null, 2));
  safeWriteFile(path.resolve(pathResolver.rootDir(), SYSTEMS_OUTPUT), JSON.stringify({ systems }, null, 2));
  safeWriteFile(path.resolve(pathResolver.rootDir(), INDEX_OUTPUT), JSON.stringify(index, null, 2));

  process.stdout.write(`${JSON.stringify({ imported: imported.length, themes_output: THEMES_OUTPUT, systems_output: SYSTEMS_OUTPUT, index_output: INDEX_OUTPUT }, null, 2)}\n`);
}

main().catch((error) => {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exit(1);
});
