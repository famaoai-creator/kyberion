import { resolveLatinFontFamily } from '@agent/core/design-fonts';
import {
  resolveDrawioEdgeLabelStyleParts,
  resolveDrawioEdgeRoutingStyleParts,
  resolveDrawioBoundaryIconCandidates,
  resolveDrawioBoundaryPaletteOverride,
  resolveMediaDrawioBoundaryPalette,
  resolveMediaDrawioNodeSize,
  resolveMediaAwsIconCandidates,
  resolveMediaDrawioTierRank,
  resolveMediaDrawioGroupRank,
  resolveMediaDrawioTypeRank,
  resolveMediaDrawioSecurityGroupRelationPrefix,
} from '@agent/core';
import { safeExistsSync, safeReadFile, pathResolver } from '@agent/core';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

function normalizeFontFamily(input: string): string {
  return input.split(',')[0].trim();
}

function escapeXml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function awsIconCandidatesForResourceType(resourceType: string): string[] {
  return resolveMediaAwsIconCandidates(resourceType);
}

function iconCandidatePriority(candidate: string): number {
  const normalized = candidate.toLowerCase();
  if (normalized.endsWith('.png')) return 0;
  if (normalized.endsWith('.svg')) return 1;
  return 2;
}

function drawioNodeDepth(node: any, nodeMap: Map<string, any>): number {
  let depth = 0;
  let current = node;
  const seen = new Set<string>();
  while (current?.parent && nodeMap.has(current.parent) && !seen.has(current.parent)) {
    seen.add(current.parent);
    depth += 1;
    current = nodeMap.get(current.parent);
  }
  return depth;
}

function compareDrawioNodesByTier(left: any, right: any): number {
  const leftTier =
    typeof left?.render_hints?.semantic_tier === 'string' ? left.render_hints.semantic_tier : '';
  const rightTier =
    typeof right?.render_hints?.semantic_tier === 'string' ? right.render_hints.semantic_tier : '';
  const leftRank = resolveMediaDrawioTierRank(leftTier);
  const rightRank = resolveMediaDrawioTierRank(rightTier);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return String(left?.name || left?.id).localeCompare(String(right?.name || right?.id));
}

function compareDrawioLeafNodes(left: any, right: any): number {
  const leftType = String(left?.type || '');
  const rightType = String(right?.type || '');
  const leftName = String(left?.name || left?.id);
  const rightName = String(right?.name || right?.id);
  const leftRelatedSg = String(left?.render_hints?.related_security_group || '');
  const rightRelatedSg = String(right?.render_hints?.related_security_group || '');
  const leftClusterKey = String(left?.render_hints?.cluster_key || '');
  const rightClusterKey = String(right?.render_hints?.cluster_key || '');
  const relationPrefix = resolveMediaDrawioSecurityGroupRelationPrefix();
  const leftRank = resolveMediaDrawioTypeRank(leftType);
  const rightRank = resolveMediaDrawioTypeRank(rightType);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (leftClusterKey && rightClusterKey && leftClusterKey !== rightClusterKey) {
    return leftClusterKey.localeCompare(rightClusterKey);
  }
  if (leftClusterKey && !rightClusterKey) {
    return -1;
  }
  if (!leftClusterKey && rightClusterKey) {
    return 1;
  }
  if (
    leftType === 'aws_security_group' &&
    rightType === 'aws_security_group_rule' &&
    rightRelatedSg.includes(`${relationPrefix}${leftName}`)
  ) {
    return -1;
  }
  if (
    leftType === 'aws_security_group_rule' &&
    rightType === 'aws_security_group' &&
    leftRelatedSg.includes(`${relationPrefix}${rightName}`)
  ) {
    return 1;
  }
  if (
    leftType === 'aws_security_group_rule' &&
    rightType === 'aws_security_group_rule' &&
    leftRelatedSg !== rightRelatedSg
  ) {
    return leftRelatedSg.localeCompare(rightRelatedSg);
  }
  return leftName.localeCompare(rightName);
}

function resolveDrawioBoundaryIcon(node: any, iconRoot?: string): string | null {
  const boundary = String(node?.boundary || '');
  const name = String(node?.name || '').toLowerCase();
  const tier = String(node?.render_hints?.semantic_tier || '').toLowerCase();
  const candidates = resolveDrawioBoundaryIconCandidates({
    boundary,
    type: node?.type,
    tier,
    name,
  });

  for (const candidate of candidates) {
    const absolutePath = iconRoot
      ? path.resolve(iconRoot, candidate)
      : path.resolve(pathResolver.rootDir(), candidate);
    if (!safeExistsSync(absolutePath)) continue;
    const buffer = safeReadFile(absolutePath, { encoding: null }) as Buffer;
    const extension = path.extname(absolutePath).toLowerCase();
    const mimeType =
      extension === '.svg' ? 'image/svg+xml' : extension === '.png' ? 'image/png' : null;
    if (!mimeType) continue;
    return `data:${mimeType},${buffer.toString('base64')}`;
  }
  return null;
}

function resolveDrawioBoundaryPalette(
  node: any,
  fallbackFill: string,
  fallbackStroke: string
): { fill: string; stroke: string } {
  const boundary = String(node?.boundary || '');
  const type = String(node?.type || '');
  const tier = String(node?.render_hints?.semantic_tier || '')
    .trim()
    .toLowerCase();
  const override = resolveDrawioBoundaryPaletteOverride({ boundary, type, tier, name: node?.name });
  if (override) return override;
  return resolveMediaDrawioBoundaryPalette({
    boundary,
    type,
    name: node?.name,
    fallbackFill,
    fallbackStroke,
  });
}

function resolveDrawioNodeSize(node: any): { width: number; height: number } {
  const explicitWidth = Number(node?.render_hints?.preferred_width || 0);
  const explicitHeight = Number(node?.render_hints?.preferred_height || 0);
  if (explicitWidth > 0 && explicitHeight > 0) {
    return { width: explicitWidth, height: explicitHeight };
  }

  const tier =
    typeof node?.render_hints?.semantic_tier === 'string' ? node.render_hints.semantic_tier : '';
  const resolved = resolveMediaDrawioNodeSize({ type: node?.type, tier });
  if (resolved) return resolved;
  return { width: 160, height: 120 };
}

function resolveEmbeddedIcon(resourceType: string, entry: any, iconRoot?: string): string | null {
  const candidates = [
    entry?.asset_path,
    ...(Array.isArray(entry?.asset_candidates) ? entry.asset_candidates : []),
    ...awsIconCandidatesForResourceType(resourceType),
  ]
    .filter(Boolean)
    .sort(
      (left, right) => iconCandidatePriority(String(left)) - iconCandidatePriority(String(right))
    );

  for (const candidate of candidates) {
    const absolutePath = iconRoot
      ? path.resolve(iconRoot, candidate)
      : path.resolve(pathResolver.rootDir(), candidate);
    if (!safeExistsSync(absolutePath)) continue;

    const buffer = safeReadFile(absolutePath, { encoding: null }) as Buffer;
    const extension = path.extname(absolutePath).toLowerCase();
    const mimeType =
      extension === '.svg' ? 'image/svg+xml' : extension === '.png' ? 'image/png' : null;
    if (!mimeType) continue;
    return `data:${mimeType},${buffer.toString('base64')}`;
  }

  if (typeof entry?.data_uri === 'string' && entry.data_uri.startsWith('data:')) {
    return entry.data_uri;
  }

  return null;
}

function buildDrawioNodeStyle(
  node: any,
  isContainer: boolean,
  options: { iconMap: any; iconRoot?: string },
  colors: Record<string, string>,
  fonts: Record<string, string>
): string {
  const resourceKey = node.icon_key || node.type;
  const resourceEntry =
    options.iconMap?.resources?.[resourceKey] ||
    options.iconMap?.resources?.[node.type] ||
    options.iconMap?.resources?.default ||
    {};
  const background = resourceEntry.fillColor || colors.background || '#ffffff';
  const stroke = resourceEntry.strokeColor || colors.primary || '#232f3e';
  const accent = resourceEntry.accentColor || colors.accent || '#ff9900';
  const fontFamily = normalizeFontFamily(
    fonts.body || fonts.heading || resolveLatinFontFamily(undefined)
  );

  if (isContainer) {
    const boundaryPalette = resolveDrawioBoundaryPalette(node, background, stroke);
    const boundaryIcon = resolveDrawioBoundaryIcon(node, options.iconRoot);
    return [
      'swimlane',
      'html=1',
      'rounded=1',
      'whiteSpace=wrap',
      'horizontal=1',
      'startSize=28',
      'container=1',
      `fillColor=${boundaryPalette.fill}`,
      `strokeColor=${boundaryPalette.stroke}`,
      `fontColor=${colors.text || '#111827'}`,
      `fontFamily=${fontFamily}`,
      'fontStyle=1',
      ...(boundaryIcon
        ? [
            `image=${boundaryIcon}`,
            'align=left',
            'verticalAlign=middle',
            'spacingLeft=40',
            'spacing=8',
          ]
        : []),
    ].join(';');
  }

  const embeddedIcon = resolveEmbeddedIcon(resourceKey, resourceEntry, options.iconRoot);
  if (embeddedIcon) {
    return [
      'shape=image',
      'html=1',
      'verticalLabelPosition=bottom',
      'verticalAlign=top',
      'imageAspect=0',
      'aspect=fixed',
      'align=center',
      'labelBackgroundColor=none',
      `fontColor=${colors.text || '#111827'}`,
      `fontFamily=${fontFamily}`,
      `image=${embeddedIcon}`,
    ].join(';');
  }

  return [
    'rounded=1',
    'whiteSpace=wrap',
    'html=1',
    'arcSize=12',
    `fillColor=${background}`,
    `strokeColor=${stroke}`,
    `fontColor=${colors.text || '#111827'}`,
    `fontFamily=${fontFamily}`,
    `gradientColor=${accent}`,
  ].join(';');
}

function resolveDiagramSource(rootDir: string, params: any, ctx: any, resolve: Function): string {
  const inlineSource = resolve(params.source);
  if (typeof inlineSource === 'string' && inlineSource.trim()) {
    return inlineSource;
  }

  if (params.from) {
    const ctxValue = ctx[params.from];
    if (typeof ctxValue === 'string' && ctxValue.trim()) {
      return ctxValue;
    }
  }

  if (params.input_path) {
    const inputPath = path.resolve(rootDir, resolve(params.input_path));
    return safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  }

  throw new Error(
    'Missing diagram source. Provide one of: params.source, params.from, params.input_path'
  );
}

function resolveDiagramTheme(params: any, ctx: any): any {
  if (params.theme && ctx.themes?.[params.theme]) {
    return ctx.themes[params.theme];
  }

  if (ctx.active_theme) {
    return ctx.active_theme;
  }

  return {
    colors: {
      primary: '#0f172a',
      secondary: '#334155',
      accent: '#38bdf8',
      background: '#ffffff',
      text: '#1e293b',
    },
    fonts: {
      heading: resolveLatinFontFamily(undefined),
      body: resolveLatinFontFamily(undefined),
    },
  };
}

function generateDrawioDocument(
  graph: any,
  options: {
    title: string;
    theme: any;
    iconMap: any;
    iconRoot?: string;
  }
): string {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const colors = options.theme?.colors || {};
  const fonts = options.theme?.fonts || {};
  const nodeMap = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
  const childrenByParent = new Map<string, any[]>();
  const roots: any[] = [];
  const direction = graph?.render_hints?.direction || 'LR';

  for (const node of nodes) {
    const parentId = node.parent;
    if (parentId && nodeMap.has(parentId)) {
      const bucket = childrenByParent.get(parentId) || [];
      bucket.push(node);
      childrenByParent.set(parentId, bucket);
    } else {
      roots.push(node);
    }
  }

  const cellXml: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const geometry = new Map<string, { x: number; y: number; width: number; height: number }>();
  let cursorX = 40;
  let cursorY = 40;
  const layoutNode = (
    node: any,
    depth: number,
    parentX: number,
    parentY: number
  ): { width: number; height: number } => {
    const nodeChildren = childrenByParent.get(node.id) || [];
    const { width: preferredWidth, height: preferredHeight } = resolveDrawioNodeSize(node);
    const shouldTreatAsContainer =
      nodeChildren.length > 0 ||
      node?.render_hints?.container === true ||
      Boolean(node?.boundary && !node?.parent);
    if (!shouldTreatAsContainer) {
      const width = preferredWidth;
      const height = preferredHeight;
      const x = depth === 0 ? cursorX : parentX;
      const y = depth === 0 ? cursorY : parentY;
      geometry.set(node.id, { x, y, width, height });
      if (depth === 0) {
        if (direction === 'TB' || direction === 'BT') cursorY += height + 80;
        else cursorX += width + 80;
      }
      return { width, height };
    }

    const childContainers: any[] = [];
    const leafChildren: any[] = [];
    for (const child of nodeChildren) {
      const childHasChildren =
        (childrenByParent.get(child.id) || []).length > 0 ||
        child?.render_hints?.container === true ||
        Boolean(child?.boundary && !child?.parent);
      if (childHasChildren) childContainers.push(child);
      else leafChildren.push(child);
    }

    const groupedLeaves = new Map<string, any[]>();
    for (const child of leafChildren) {
      const group =
        typeof child?.render_hints?.semantic_tier === 'string' &&
        child.render_hints.semantic_tier.trim()
          ? child.render_hints.semantic_tier.trim()
          : typeof child?.group === 'string' && child.group.trim()
            ? child.group.trim()
            : 'application';
      const bucket = groupedLeaves.get(group) || [];
      bucket.push(child);
      groupedLeaves.set(group, bucket);
    }

    const sortedGroups = [...groupedLeaves.keys()].sort((left, right) => {
      const leftRank = resolveMediaDrawioGroupRank(left);
      const rightRank = resolveMediaDrawioGroupRank(right);
      return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
    });

    let innerY = parentY + 70;
    let maxBottom = parentY + 180;
    let maxRight = parentX + 260;
    const columnGap = 44;
    const rowGap = 24;
    const bucketHeaderHeight = 22;

    if (sortedGroups.length > 0) {
      let bucketX = parentX + 30;
      for (const group of sortedGroups) {
        const children = (groupedLeaves.get(group) || []).sort(compareDrawioLeafNodes);
        let bucketY = innerY + bucketHeaderHeight;
        let bucketMaxRight = bucketX;
        for (const child of children) {
          const childBox = layoutNode(child, depth + 1, bucketX, bucketY);
          const childGeo = geometry.get(child.id)!;
          bucketY += childBox.height + rowGap;
          bucketMaxRight = Math.max(bucketMaxRight, childGeo.x + childGeo.width);
          maxBottom = Math.max(maxBottom, childGeo.y + childGeo.height + 30);
          maxRight = Math.max(maxRight, childGeo.x + childGeo.width + 30);
        }
        bucketX = bucketMaxRight + columnGap;
      }
      innerY = maxBottom + 20;
    }

    if (childContainers.length > 0) {
      let containerX = parentX + 30;
      for (const child of childContainers.sort(compareDrawioNodesByTier)) {
        const childBox = layoutNode(child, depth + 1, containerX, innerY);
        const childGeo = geometry.get(child.id)!;
        containerX += childBox.width + 30;
        maxBottom = Math.max(maxBottom, childGeo.y + childGeo.height + 30);
        maxRight = Math.max(maxRight, childGeo.x + childGeo.width + 30);
      }
    }

    const width = Math.max(260, maxRight - parentX);
    const height = Math.max(180, maxBottom - parentY);
    const x = depth === 0 ? cursorX : parentX;
    const y = depth === 0 ? cursorY : parentY;
    geometry.set(node.id, { x, y, width, height });
    if (depth === 0) {
      if (direction === 'TB' || direction === 'BT') cursorY += height + 80;
      else cursorX += width + 80;
    }
    return { width, height };
  };

  for (const root of roots) {
    layoutNode(root, 0, cursorX, cursorY);
  }

  const sortedNodes = [...nodes].sort((left, right) => {
    const leftIsContainer =
      (childrenByParent.get(left.id) || []).length > 0 ||
      left?.render_hints?.container === true ||
      Boolean(left?.boundary && !left?.parent)
        ? 1
        : 0;
    const rightIsContainer =
      (childrenByParent.get(right.id) || []).length > 0 ||
      right?.render_hints?.container === true ||
      Boolean(right?.boundary && !right?.parent)
        ? 1
        : 0;
    if (leftIsContainer !== rightIsContainer) {
      return rightIsContainer - leftIsContainer;
    }
    const leftDepth = drawioNodeDepth(left, nodeMap);
    const rightDepth = drawioNodeDepth(right, nodeMap);
    return leftDepth === rightDepth ? left.id.localeCompare(right.id) : leftDepth - rightDepth;
  });

  for (const node of sortedNodes) {
    const geo = geometry.get(node.id) || { x: 40, y: 40, width: 160, height: 120 };
    const hasChildren =
      (childrenByParent.get(node.id) || []).length > 0 ||
      node?.render_hints?.container === true ||
      Boolean(node?.boundary && !node?.parent);
    const parentId = node.parent && nodeMap.has(node.parent) ? node.parent : '1';
    const parentGeo = parentId !== '1' ? geometry.get(parentId) : undefined;
    const relativeX = parentGeo ? Math.max(0, geo.x - parentGeo.x) : geo.x;
    const relativeY = parentGeo ? Math.max(0, geo.y - parentGeo.y) : geo.y;
    const style = buildDrawioNodeStyle(node, hasChildren, options, colors, fonts);
    const label = escapeXml(node.name || node.id);
    cellXml.push(
      `<mxCell id="${escapeXml(node.id)}" value="${label}" style="${escapeXml(style)}" vertex="1" parent="${escapeXml(parentId)}">` +
        `<mxGeometry x="${relativeX}" y="${relativeY}" width="${geo.width}" height="${geo.height}" as="geometry"/>` +
        `</mxCell>`
    );
  }

  edges.forEach((edge: any, index: number) => {
    const sourceNode = nodeMap.get(edge.from);
    const targetNode = nodeMap.get(edge.to);
    const sourceTier = String(
      sourceNode?.render_hints?.semantic_tier || sourceNode?.group || ''
    ).toLowerCase();
    const targetTier = String(
      targetNode?.render_hints?.semantic_tier || targetNode?.group || ''
    ).toLowerCase();
    const styleParts = [
      'edgeStyle=orthogonalEdgeStyle',
      'rounded=1',
      'orthogonalLoop=1',
      'jettySize=auto',
      'html=1',
      `strokeColor=${colors.primary || '#232f3e'}`,
      `fontColor=${colors.text || '#111827'}`,
      `fontFamily=${normalizeFontFamily(fonts.body || fonts.heading || resolveLatinFontFamily(undefined))}`,
    ];
    const labelStyleParts = resolveDrawioEdgeLabelStyleParts(edge.label);
    if (labelStyleParts.length > 0) {
      styleParts.push(
        ...labelStyleParts.map((part) =>
          part.includes('strokeColor=')
            ? part.replace(
                /strokeColor=[^;]+/,
                edge.label === 'source'
                  ? `strokeColor=${colors.accent || '#ff9900'}`
                  : `strokeColor=${colors.secondary || '#4b5563'}`
              )
            : part
        )
      );
    }
    styleParts.push(...resolveDrawioEdgeRoutingStyleParts({ sourceTier, targetTier }));
    const style = styleParts.join(';');
    const label = edge.label ? ` value="${escapeXml(edge.label)}"` : '';
    cellXml.push(
      `<mxCell id="edge-${index + 1}"${label} style="${escapeXml(style)}" edge="1" parent="1" source="${escapeXml(edge.from)}" target="${escapeXml(edge.to)}">` +
        '<mxGeometry relative="1" as="geometry"/>' +
        '</mxCell>'
    );
  });

  const diagramId = createHash('sha1').update(JSON.stringify(graph)).digest('hex').slice(0, 12);
  return [
    `<mxfile host="kyberion" modified="${new Date().toISOString()}" agent="Kyberion Media-Actuator" version="1.0.0" type="device">`,
    `  <diagram id="${diagramId}" name="${escapeXml(options.title)}" compressed="false">`,
    '    <mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1920" pageHeight="1080" math="0" shadow="0">',
    '      <root>',
    ...cellXml.map((line) => `        ${line}`),
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
  ].join('\n');
}

function extractChromeGeometryFromPptxDesign(design: any): any {
  const elements: any[] = design?.master?.elements || [];
  const canvas = design?.canvas || { w: 10, h: 7.5 };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const SEP = 0.024;

  const titleEl = elements.find(
    (e) => e.placeholderType === 'title' || e.placeholderType === 'ctrTitle'
  );
  const bodyEl = elements.find((e) => e.placeholderType === 'body' || e.placeholderType === 'obj');
  const footerEl = elements.find((e) => ['ftr', 'sldNum', 'dt'].includes(e.placeholderType));
  const logoEl = elements.find(
    (e) => e.type === 'image' && e.pos?.x > canvas.w * 0.6 && e.pos?.y < 1.0
  );

  const bodyY = bodyEl?.pos?.y ?? (titleEl ? r2(titleEl.pos.y + titleEl.pos.h + SEP) : 0.78);
  const bodyX = bodyEl?.pos?.x ?? titleEl?.pos?.x ?? 0.44;
  const bodyW = bodyEl?.pos?.w ?? r2(canvas.w - bodyX * 2);
  const bodyH =
    bodyEl?.pos?.h ?? (footerEl ? r2(footerEl.pos.y - bodyY - 0.1) : r2(canvas.h - bodyY - 0.4));
  const footerY = footerEl?.pos?.y ?? r2(bodyY + bodyH + 0.05);
  const footerH = footerEl?.pos?.h ?? 0.28;
  const titleX = titleEl?.pos?.x ?? bodyX;

  return {
    canvas,
    chrome: {
      header_h: r2(bodyY - SEP),
      separator_h: SEP,
      footer_y: r2(footerY),
      footer_h: r2(footerH),
      footer_font_size: 8,
      body_y: r2(bodyY),
      body_x: r2(bodyX),
      body_w: r2(bodyW),
      body_h: r2(bodyH),
      title_x: r2(titleX),
      title_font_size: titleEl?.style?.fontSize ?? 24,
      title_w_logo: logoEl ? r2(logoEl.pos.x - titleX - 0.1) : r2(bodyW),
      title_w_no_logo: r2(bodyW + (bodyX - titleX)),
      accent_strip_x: r2(titleX - 0.14),
      accent_strip_w: 0.065,
      logo_zone_x: logoEl ? r2(logoEl.pos.x) : r2(canvas.w - 2.5),
      logo_zone_y: logoEl ? r2(logoEl.pos.y) : 0.03,
      logo_zone_w: logoEl ? r2(logoEl.pos.w + 0.1) : 2.27,
      logo_zone_h: logoEl ? r2(logoEl.pos.h + 0.1) : 0.79,
      logo_display_h: 0.38,
      logo_display_max_w: logoEl ? r2(logoEl.pos.w) : 2.1,
    },
    _geometry_source: 'pptx_master',
  };
}

function pickSlideHeroElements(design: any): {
  titleEl?: any;
  subtitleEl?: any;
  logoEl?: any;
  slideIndex?: number;
} {
  const masterElements: any[] = Array.isArray(design?.master?.elements)
    ? design.master.elements
    : [];
  const slides: any[] = Array.isArray(design?.slides) ? design.slides : [];
  const slide = slides[0] || null;
  const slideElements: any[] = Array.isArray(slide?.elements) ? slide.elements : [];
  const combined = [...slideElements, ...masterElements];
  const findByPlaceholder = (placeholderTypes: string[]) =>
    combined.find((e) => placeholderTypes.includes(e?.placeholderType));
  const findLogo = combined.find(
    (e) =>
      e?.type === 'image' &&
      typeof e?.pos?.x === 'number' &&
      typeof e?.pos?.y === 'number' &&
      e.pos.x > (design?.canvas?.w || 10) * 0.6
  );
  return {
    titleEl: findByPlaceholder(['title', 'ctrTitle']),
    subtitleEl: findByPlaceholder(['subTitle', 'body']),
    logoEl: findLogo,
    slideIndex: slide ? 0 : undefined,
  };
}

function deriveLayoutTemplateFromPptxDesign(design: any, fallbackTemplate: any = {}): any {
  const geometry = extractChromeGeometryFromPptxDesign(design);
  const canvas = geometry.canvas || design?.canvas || { w: 10, h: 7.5 };
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const hero = pickSlideHeroElements(design);
  const baseHero = fallbackTemplate.hero || {};
  const baseBodyZones = fallbackTemplate.body_zones || {};
  const titleEl = hero.titleEl;
  const subtitleEl = hero.subtitleEl;
  const logoEl = hero.logoEl;
  const derivedLogoRightMargin = logoEl
    ? r2(Math.max(0.08, canvas.w - logoEl.pos.x - logoEl.pos.w))
    : baseHero.logo_right_margin;
  const derivedWhitePanelY = subtitleEl
    ? r2(
        Math.min(
          canvas.h - 0.85,
          Math.max(subtitleEl.pos.y + subtitleEl.pos.h + 0.65, canvas.h * 0.56)
        )
      )
    : baseHero.white_panel_y;
  const separatorH = baseHero.separator_h ?? geometry.chrome.separator_h ?? 0.03;
  const derivedSeparatorY =
    typeof derivedWhitePanelY === 'number'
      ? r2(Math.max(0, derivedWhitePanelY - separatorH))
      : baseHero.separator_y;
  const derivedBrandNameY = subtitleEl
    ? r2(subtitleEl.pos.y + subtitleEl.pos.h + 0.15)
    : baseHero.brand_name_y;
  const derivedTitleW = titleEl?.pos?.w
    ? r2(titleEl.pos.w)
    : (baseHero.title_w ?? baseHero.title_w_logo ?? baseHero.title_w_no_logo);
  const derivedSubtitleW = subtitleEl?.pos?.w ? r2(subtitleEl.pos.w) : baseHero.subtitle_w;

  return {
    chrome: geometry.chrome,
    hero: {
      ...baseHero,
      white_panel_y: derivedWhitePanelY ?? baseHero.white_panel_y,
      white_panel_h: baseHero.white_panel_h,
      separator_y: derivedSeparatorY ?? baseHero.separator_y,
      separator_h: separatorH,
      logo_display_h: logoEl?.pos?.h
        ? r2(Math.max(0.2, Math.min(logoEl.pos.h, 0.8)))
        : baseHero.logo_display_h,
      logo_display_max_w: logoEl?.pos?.w
        ? r2(Math.max(logoEl.pos.w, 0.5))
        : baseHero.logo_display_max_w,
      logo_right_margin: derivedLogoRightMargin ?? baseHero.logo_right_margin,
      logo_y: logoEl?.pos?.y ? r2(logoEl.pos.y) : baseHero.logo_y,
      brand_name_x: baseHero.brand_name_x ?? geometry.chrome.title_x,
      brand_name_y: derivedBrandNameY ?? baseHero.brand_name_y,
      brand_name_w: baseHero.brand_name_w,
      brand_name_h: baseHero.brand_name_h,
      brand_name_font_size: baseHero.brand_name_font_size ?? titleEl?.style?.fontSize ?? 10,
      title_x: titleEl?.pos?.x ? r2(titleEl.pos.x) : baseHero.title_x,
      title_y: titleEl?.pos?.y ? r2(titleEl.pos.y) : baseHero.title_y,
      title_w: derivedTitleW ?? baseHero.title_w,
      title_h: titleEl?.pos?.h ? r2(titleEl.pos.h) : baseHero.title_h,
      title_font_size: titleEl?.style?.fontSize || baseHero.title_font_size,
      subtitle_x: subtitleEl?.pos?.x ? r2(subtitleEl.pos.x) : baseHero.subtitle_x,
      subtitle_y: subtitleEl?.pos?.y ? r2(subtitleEl.pos.y) : baseHero.subtitle_y,
      subtitle_w: derivedSubtitleW ?? baseHero.subtitle_w,
      subtitle_h: subtitleEl?.pos?.h ? r2(subtitleEl.pos.h) : baseHero.subtitle_h,
      subtitle_font_size: subtitleEl?.style?.fontSize || baseHero.subtitle_font_size,
    },
    body_zones: {
      ...baseBodyZones,
    },
    _meta: 'Derived from PPTX heritage',
  };
}

function matchLayoutTemplate(geometry: any, catalog: any): { id: string; score: number } | null {
  const templates = catalog?.templates as Record<string, any> | undefined;
  if (!templates) return null;
  const g = geometry.chrome;
  let best: { id: string; score: number } | null = null;
  for (const [id, tpl] of Object.entries(templates)) {
    const c = (tpl as any).chrome;
    if (!c) continue;
    const diffs = [
      Math.abs((c.header_h ?? 0) - (g.header_h ?? 0)) / 0.5,
      Math.abs((c.body_y ?? 0) - (g.body_y ?? 0)) / 0.5,
      Math.abs((c.body_x ?? 0) - (g.body_x ?? 0)) / 0.5,
      Math.abs((c.body_w ?? 0) - (g.body_w ?? 0)) / 2.0,
    ];
    const score = Math.max(0, 1 - diffs.reduce((a, b) => a + b, 0) / diffs.length);
    if (!best || score > best.score) best = { id, score };
  }
  return best;
}

function pickFontFromElements(
  elements: any[] | undefined,
  placeholderTypes: string[]
): string | undefined {
  if (!Array.isArray(elements)) {
    return undefined;
  }

  const candidates =
    placeholderTypes.length > 0
      ? elements.filter((element) => placeholderTypes.includes(element?.placeholderType))
      : elements;

  for (const element of candidates) {
    if (typeof element?.style?.fontFamily === 'string' && element.style.fontFamily.trim()) {
      return element.style.fontFamily.trim();
    }

    if (Array.isArray(element?.textRuns)) {
      for (const run of element.textRuns) {
        if (typeof run?.options?.fontFamily === 'string' && run.options.fontFamily.trim()) {
          return run.options.fontFamily.trim();
        }
      }
    }
  }

  return undefined;
}

function normalizeHexColor(value: string | undefined, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  const normalized = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return `#${normalized.toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{8}$/.test(normalized)) {
    return `#${normalized.slice(2).toUpperCase()}`;
  }
  return fallback;
}

function parseHexOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) return `#${normalized.toUpperCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(normalized)) return `#${normalized.slice(2).toUpperCase()}`;
  return null;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Rough saturation proxy: the spread between the strongest and weakest channel.
// Grayscale colors (including near-white/near-black) have a spread near zero.
function colorSpread(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function isNearWhiteOrBlack(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max > 235 || max < 25;
}

function isReddish(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex);
  return r - Math.max(g, b) > 40;
}

// Counts how often each hex color actually appears on rendered content (shape fills,
// text colors, line colors, inline text-run colors) across every slide. This is the
// deck's real visual evidence — distinct from `design.theme`, which only reflects the
// OOXML clrScheme and is frequently just the unmodified default Office palette even
// when the deck itself consistently uses a completely different set of colors.
function collectContentColorCounts(slideElements: any[]): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (raw: unknown) => {
    const hex = parseHexOrNull(raw);
    if (!hex) return;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  };
  for (const el of slideElements) {
    if (!el || typeof el !== 'object') continue;
    bump(el.style?.fill);
    bump(el.style?.color);
    bump(el.style?.line);
    if (Array.isArray(el.textRuns)) {
      for (const run of el.textRuns) bump(run?.options?.color);
    }
  }
  return counts;
}

function pickMostFrequent(
  counts: Map<string, number>,
  filter: (hex: string) => boolean
): { hex: string; count: number } | null {
  let best: { hex: string; count: number } | null = null;
  for (const [hex, count] of counts) {
    if (!filter(hex)) continue;
    if (!best || count > best.count) best = { hex, count };
  }
  return best;
}

// A color counts as "evidenced" once it shows up more than once — a single stray
// occurrence (e.g. one manually-tinted cell) shouldn't override the theme's own
// declared palette, but a color repeated across the deck clearly is the real one.
const MIN_CONTENT_EVIDENCE = 2;

function deriveThemeFromPptxDesign(design: any, explicitName?: string): Record<string, any> {
  const palette = design?.theme || {};
  const slideElements = Array.isArray(design?.slides)
    ? design.slides.flatMap((slide: any) => slide?.elements || [])
    : [];
  const titleFont = pickFontFromElements(design?.master?.elements, ['title', 'ctrTitle']);
  const bodyFont = pickFontFromElements(design?.master?.elements, ['body', 'subTitle']);
  const slideTitleFont = pickFontFromElements(slideElements, ['title', 'ctrTitle']);
  const slideBodyFont = pickFontFromElements(slideElements, ['body', 'subTitle']);
  const fallbackFont = pickFontFromElements(slideElements, []);

  const contentColorCounts = collectContentColorCounts(slideElements);
  const chromaticCounts = new Map(
    [...contentColorCounts].filter(([hex]) => !isNearWhiteOrBlack(hex) && colorSpread(hex) >= 20)
  );
  // Prefer a non-reddish brand candidate — reds recur mainly as emphasis/warning
  // markup in this kind of document, not as the deck's identity color.
  const brandCandidate = pickMostFrequent(chromaticCounts, (hex) => !isReddish(hex));

  // Trust the theme's declared accent only if the deck actually uses it anywhere;
  // a theme that declares one accent but never draws with it (e.g. an unmodified
  // default Office theme) is not evidence of the deck's real visual identity.
  const themeAccent = normalizeHexColor(
    palette.accent1 || palette.hlink || palette.accent2,
    '#2563EB'
  );
  const themeAccentEvidence = contentColorCounts.get(themeAccent) || 0;
  const accent =
    themeAccentEvidence < MIN_CONTENT_EVIDENCE &&
    brandCandidate &&
    brandCandidate.count >= MIN_CONTENT_EVIDENCE
      ? brandCandidate.hex
      : themeAccent;

  const pptxHeritage = {
    canvas: design?.canvas || null,
    master: design?.master || null,
    rawThemeXml: design?.rawThemeXml || null,
    rawMasterXml: design?.rawMasterXml || null,
    rawMasterRelsXml: design?.rawMasterRelsXml || null,
    rawLayouts: Array.isArray(design?.rawLayouts) ? design.rawLayouts : [],
    rawMasters: Array.isArray(design?.rawMasters) ? design.rawMasters : [],
    masterMedia: Array.isArray(design?.masterMedia) ? design.masterMedia : [],
    rawParts: design?.rawParts || null,
  };

  return {
    name: explicitName || 'pptx-extracted-theme',
    colors: {
      primary: normalizeHexColor(
        palette.dk1 || palette.tx1 || palette.accent2 || palette.accent1,
        '#1F2937'
      ),
      secondary: normalizeHexColor(
        palette.dk2 || palette.tx2 || palette.accent2 || palette.accent3,
        '#4B5563'
      ),
      accent,
      background: normalizeHexColor(palette.lt1 || palette.bg1 || palette.lt2, '#FFFFFF'),
      text: normalizeHexColor(palette.tx1 || palette.dk1 || palette.dk2, '#111827'),
    },
    fonts: {
      heading: titleFont || slideTitleFont || fallbackFont || 'Aptos, sans-serif',
      body: bodyFont || slideBodyFont || fallbackFont || 'Aptos, sans-serif',
    },
    pptx: pptxHeritage,
  };
}

export {
  resolveDiagramSource,
  resolveDiagramTheme,
  generateDrawioDocument,
  extractChromeGeometryFromPptxDesign,
  deriveLayoutTemplateFromPptxDesign,
  matchLayoutTemplate,
  deriveThemeFromPptxDesign,
  normalizeFontFamily,
  escapeXml,
};
