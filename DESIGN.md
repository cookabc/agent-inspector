---
name: "Agent Inspector"
description: "Extracted visual system for the storage ledger"
colors:
  slate-1: "#fcfcfd"
  slate-2: "#f9f9fb"
  slate-3: "#f0f0f3"
  slate-4: "#e8e8ec"
  slate-12: "#1c2024"
  slate-11: "#60646c"
  slate-6: "#d9d9e0"
  slate-8: "#b9bbc6"
  indigo-9: "#3e63dd"
  indigo-3: "#edf2fe"
  indigo-1: "#fdfdfe"
  teal-11: "#008573"
  amber-11: "#ab6400"
  red-11: "#ce2c31"
  ruby-11: "#ca244d"
  slate-7: "#cdced6"
  indigo-11: "#3a5bc7"
  indigo-12: "#1f2d5c"
  teal-4: "#ccf3ea"
  teal-12: "#0d3d38"
  amber-4: "#ffee9c"
  amber-12: "#4f3422"
  red-4: "#ffdbdc"
  red-12: "#641723"
  ruby-4: "#ffdce1"
  ruby-12: "#64172b"
  indigo-8: "#8da4ef"
  red-9: "#e5484d"
  red-1: "#fffcfc"
  indigo-5: "#d2deff"
  teal-3: "#e0f8f3"
  amber-3: "#fff7c2"
  red-3: "#feebec"
  ruby-3: "#feeaed"
  amber-7: "#e9c162"
  teal-7: "#83cdc1"
  slate-1-dark: "#111113"
  slate-2-dark: "#18191b"
  slate-3-dark: "#212225"
  slate-4-dark: "#272a2d"
  slate-12-dark: "#edeef0"
  slate-11-dark: "#b0b4ba"
  slate-6-dark: "#363a3f"
  slate-8-dark: "#5a6169"
  indigo-9-dark: "#3e63dd"
  indigo-3-dark: "#182449"
  indigo-1-dark: "#11131f"
  teal-11-dark: "#0bd8b6"
  amber-11-dark: "#ffca16"
  red-11-dark: "#ff9592"
  ruby-11-dark: "#ff949d"
  slate-7-dark: "#43484e"
  indigo-11-dark: "#9eb1ff"
  indigo-12-dark: "#d6e1ff"
  teal-4-dark: "#023b37"
  teal-12-dark: "#adf0dd"
  amber-4-dark: "#3f2700"
  amber-12-dark: "#ffe7b3"
  red-4-dark: "#500f1c"
  red-12-dark: "#ffd1d9"
  ruby-4-dark: "#4e1325"
  ruby-12-dark: "#fed2e1"
  indigo-8-dark: "#435db1"
  red-9-dark: "#e5484d"
  red-1-dark: "#191111"
  indigo-5-dark: "#253974"
  teal-3-dark: "#0d2d2a"
  amber-3-dark: "#302008"
  red-3-dark: "#3b1219"
  ruby-3-dark: "#3a141e"
  amber-7-dark: "#714f19"
  teal-7-dark: "#1c6961"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "32px"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "20px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "12px"
rounded:
  control: "4px"
  surface: "6px"
  drawer: "8px"
  filter-pill: "999px"
spacing:
  space-8: "8px"
  space-12: "12px"
  space-16: "16px"
  space-20: "20px"
  space-24: "24px"
  space-28: "28px"
  space-32: "32px"
components:
  btn-primary:
    backgroundColor: "{colors.indigo-9}"
    textColor: "#fdfdfe"
  btn-danger:
    backgroundColor: "{colors.red-9}"
    textColor: "#fffcfc"
  search:
    padding: "6px 11px"
  chip:
    padding: "5px 10px 5px 8px"
  space-index-button:
    backgroundColor: "transparent"
    padding: "10px"
    height: "44px"
  tm-box:
    backgroundColor: "{colors.indigo-3}"
    textColor: "{colors.indigo-12}"
    padding: "6px 8px"
---

# Design System: Agent Inspector

## Overview

**Creative North Star: "The Storage Ledger"**

A storage ledger connects overall disk use to files and sessions. Proportional area gives the overview; aligned numbers and category rows support inspection. Indigo marks navigation and selection, while separate status hues communicate cleanup consequences.

This code-led scan uses public/workspace.css as the final override layer, with inherited rules from public/style.css. Local review captures provide visual evidence; there is no separate visual comp.

**Key Characteristics:**

- Semantic Radix colors
- Four-size hierarchy
- Flat working surfaces
- Original imagery

## Colors

### Primary

Indigo identifies the main task, selection, and actions.

### Secondary

Teal, Amber, Red, and Ruby distinguish cleanup status; keep status semantics separate from tool identity colors.

### Neutral

Slate steps 1–3 distinguish page, surfaces, and controls. Steps 6–8 mark boundaries; steps 11–12 supply ink.

**The Semantic Step Rule.** Use exact Radix values at their implemented semantic role; original raster content is outside the authored UI palette.

Dark-suffixed tokens are exact counterparts in the local Radix file. Runtime CSS variables select the theme. Fixed light text on filled actions intentionally stays light.

## Typography

The frontmatter records the four-size hierarchy. Mobile headings reuse an existing size; weights and spacing distinguish roles without adding sizes. Minimum authored text is 12px. Byte values use tabular numerals. Paths use the existing ui-monospace / SF Mono / Maple Mono NF / JetBrains Mono / Menlo / Consolas stack. Original raster typography is outside this scale.

## Layout

The workspace is capped at 1440px with 28px padding. Overview, files, sessions, and diagnosis follow vertically. A flexible map sits beside a 300px category index; at 900px the index becomes 240px and the topbar wraps. At 640px the index follows the map, padding becomes 20px, and map height changes from 300px to 240px. The category index remains scrollable.

## Elevation & Depth

Flat surfaces use tonal steps, rules, and whitespace. Final overrides remove decorative shadows and backdrop blur. The sidecar shadow vocabulary is empty. State motion is limited to 250ms ease-out where needed, including the inherited cubic-bezier easing recorded in the sidecar. Reduced-motion disables transitions and animation.

## Shapes

4px controls, 6px surfaces, 8px drawers, and the existing 999px status-filter pill exception. Main working regions stay rectangular. Authored boundaries use 0.5px strokes; visible keyboard focus is a distinct 2px outline, not a decorative border.

## Components

### Working surface

Map area is proportional to bytes with no artificial area floor. Labels inherit status hue step 12. The adjacent accessible category list includes tiny items whose map areas cannot carry labels. Selection filters files and focuses their heading. Cleanup options remain in a disclosure; backup, confirmation, and destructive-operation guards remain part of the workflow.

### Reusable controls

The sidecar contains a small set of source-derived actions, navigation, fields, and signature surfaces. Snippets preserve implemented states and CSS variable references; they illustrate appearance rather than application engines or full route behavior.

### Evidence and provenance

Sources: public/workspace.css, public/style.css, and public/radix.css. Desktop and mobile review captures were inspected, including the dark capture. .impeccable/asset-provenance.json records original repository assets with source commit/path and SHA256, plus relevant licenses. Existing screenshots, icons, and game faces were preserved without recoloring. No new AI raster assets were introduced. Radix MIT attribution is adjacent to radix.css. These local observations make no live-deployment claim.

## Do's and Don'ts

### Do:

- Do use Radix steps 1–2 for backgrounds, 3–5 for interactive surfaces, 6–8 for boundaries, 9–10 for solid fills, and 11–12 for readable ink.
- Do preserve original assets and consult .impeccable/asset-provenance.json before changing imagery.
- Do keep at most four authored text sizes and preserve visible keyboard focus.
- Do remove nonessential motion when prefers-reduced-motion is active.

### Don't:

- Don't add decorative shadows, middle-dot separators, or redundant explanatory UI copy.
- Don't treat screenshot colors or embedded text as UI design tokens.
- Don't shrink graph or map labels to make content fit; preserve the implemented panning or adjacent category-list alternative.
