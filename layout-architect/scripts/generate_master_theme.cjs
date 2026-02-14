#!/usr/bin/env node
/**
 * layout-architect/scripts/generate_master_theme.cjs
 * Generates Marp CSS from Master Slide Specification JSON.
 */

const fs = require('fs');
const path = require('path');
const { runSkill } = require('@agent/core');
const { safeWriteFile } = require('../../scripts/lib/secure-io.cjs');

runSkill('layout-architect', () => {
  const specsPath = path.resolve(
    __dirname,
    '../../knowledge/standards/design/master-slide-specs.json'
  );
  if (!fs.existsSync(specsPath)) throw new Error('Master specs not found.');

  const specs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));
  const t = specs.typography;
  const c = specs.color_palette;
  const l = specs.layout_specs;

  const css = `/* @theme ${specs.master_name} */
@import 'default';

section {
    width: 1280px;
    height: 720px;
    background-color: ${c.background_main};
    color: ${t.body.color};
    font-family: ${t.body.font_family};
    font-size: ${t.body.size};
    padding: ${l.padding};
    line-height: ${t.body.line_height};
}

h1 {
    color: ${t.heading.color};
    font-family: ${t.heading.font_family};
    font-weight: ${t.heading.weight};
    border-left: ${l.accent_border_width} solid ${c.brand_accent};
    padding-left: 20px;
    margin-bottom: 30px;
}

h2 {
    color: ${c.brand_accent};
    font-weight: bold;
    margin-top: 0;
}

li::before {
    content: "◼";
    color: ${c.brand_accent};
    margin-right: 10px;
}

section.lead {
    background: ${specs.slide_variants.lead.bg_gradient};
    color: white;
    justify-content: center;
}

section.lead h1 {
    color: ${specs.slide_variants.lead.title_color};
    border-left: none;
    font-size: 70px;
}

section.divider {
    background-color: ${specs.slide_variants.divider.bg_color};
    justify-content: center;
    text-align: center;
}

footer {
    font-size: 14px;
    color: ${c.brand_accent};
    border-top: 1px solid ${c.border_muted};
}
`;

  const outPath = path.resolve(
    __dirname,
    `../../knowledge/templates/themes/${specs.master_name.toLowerCase()}.css`
  );
  safeWriteFile(outPath, css);

  return {
    status: 'theme_generated',
    masterName: specs.master_name,
    output: outPath,
  };
});
