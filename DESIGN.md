---
name: WhatsApp for Home Assistant
description: An account workspace for connections, agent calls, and saved audio.
colors:
  ground: "light-dark(#f4f6f7, #141a1d)"
  surface: "light-dark(#ffffff, #1c2428)"
  rail: "light-dark(#f7f9f9, #182024)"
  ink: "light-dark(#21312d, #e7eeeb)"
  secondary: "light-dark(#62716d, #acbcb6)"
  rule: "light-dark(#e0e7e3, #35433d)"
  accent: "light-dark(#176b50, #89d6b5)"
  on-accent: "light-dark(#ffffff, #102d22)"
  selection: "light-dark(#e8f3ee, #273f34)"
  warning: "light-dark(#875a15, #edc684)"
  warning-ground: "light-dark(#fbf2df, #372e20)"
  danger: "light-dark(#b03a3b, #ffb0ad)"
  danger-ground: "light-dark(#fbecee, #492b2d)"
  hover: "light-dark(#eef2f0, #2a3630)"
typography:
  headline:
    fontFamily: '"Segoe UI", Roboto, Arial, sans-serif'
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-.025em"
  title:
    fontFamily: '"Segoe UI", Roboto, Arial, sans-serif'
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-.02em"
  content-title:
    fontFamily: '"Segoe UI", Roboto, Arial, sans-serif'
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: '"Segoe UI", Roboto, Arial, sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  label:
    fontFamily: '"Segoe UI", Roboto, Arial, sans-serif'
    fontSize: "13px"
    fontWeight: 500
  small:
    fontFamily: '"Segoe UI", Roboto, Arial, sans-serif'
    fontSize: "12px"
rounded:
  control: "8px"
  account: "10px"
  panel: "12px"
  frame: "14px"
  pill: "20px"
  circle: "50%"
spacing:
  compact: "8px"
  control: "10px"
  small: "12px"
  standard: "16px"
  panel: "18px"
  section: "22px"
  large: "24px"
  workspace: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  button-danger:
    backgroundColor: "{colors.danger-ground}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  status:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "5px 10px"
  panel:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "18px"
---

<!-- MD025 mistakes the nested typography.title token for a frontmatter page title. -->
<!-- markdownlint-disable-next-line MD025 -->
# Design System: WhatsApp for Home Assistant

## Overview

The workspace makes account identity, connection health, and audio tasks easy
to scan. Use neutral surfaces, a forest-green accent, slim dividers, and system
fonts consistently across connection controls and saved recordings.

Key priorities:

- Account identity stays separate from the selected task.
- Compact forms and recording rows show the information needed for each task.
- Light and dark appearances retain the same hierarchy and density.

## Colors

### Primary

Forest green identifies primary actions, selection, connected status, and playback. Its pale selection surface supports state without overwhelming the workspace.

### Neutral

Use the ground color around the main surface and the rail color for inset
panels. Use the ink color for primary text, secondary text for metadata, and
the rule color for dividers.

Warning amber marks waiting states. Danger red marks errors, recovery, and destructive actions. Both use a matching soft background.

The runtime QR image keeps a white scan surface in both appearances.

Use the same action, selection, warning, and danger colors in both appearances.

## Typography

Use the system font stack for headings, forms, and metadata. Headline and title roles use restrained negative tracking; labels use ordinary case. Supporting text is compact, with tabular numerals for durations and file metadata where alignment matters.

The main headline steps down to `23px` at the narrow container breakpoint. Inputs increase to `16px` there. Section headings and labels otherwise preserve the same hierarchy.

Make account and section headings prominent. Keep status, capability, and time
metadata secondary.

## Layout

The workspace is centered with a maximum width of `1440px` and an outer gutter of `16px`. Desktop uses a `218px` account rail beside flexible content with `29px 28px 24px` padding. The Calls form and readiness facts share a divided two-column region.

Container queries at `780px` narrow the rail to `188px` and stack call content. At `620px`, accounts become a three-column selector above the workspace, pairing stacks with QR first, and task tabs span the width. At a viewport width of `620px`, the outer gutter and frame border disappear. Controls reflow; recording size is omitted on smaller layouts.

## Surfaces and layering

Surfaces are flat. Tonal differences, one-pixel borders, and spacing establish depth without shadows. The modal backdrop uses translucent black. The active-call strip remains sticky near the top of the workspace.

## Shapes

Controls use gently curved corners; account selections are slightly softer, and inset panels are softer again. The outer desktop frame is rounded. Initial avatars and playback controls are circular; status badges are pills.

## Components

- **Buttons:** Compact, bordered secondary controls; solid accent primary controls; soft red destructive controls. Default minimum height is `38px`. Hover changes the surface or slightly darkens the primary control.
- **Fields:** A surface fill, thin rule border, and control radius. Labels sit above fields, with concise help below. Browser-native audio controls handle playback and seeking.
- **Navigation:** Account buttons use a tonal selected state. Task tabs use accent text and a thin underline for the current view.
- **Status:** A small dot accompanies text, so state is not conveyed by color alone. Waiting and recovery retain their own labels.
- **Panels:** Tonal inset regions group connection summaries and settings. Recording rows use separators rather than individual cards.
- **Active call:** A compact selected-tone strip shows the owning account and a destructive Hang up control across views.
- **Focus and motion:** Keyboard focus uses a `2px` accent outline offset by `3px`. Button color transitions use `160ms ease-out` only when reduced motion is not requested. Coarse-pointer icon, playback, tab, and text controls have `44px` targets.

## Do's and Don'ts

### Do

- Preserve the same type hierarchy and semantic colors in light and dark appearances.
- Reflow forms and media rows at narrow widths.
- Retain visible focus and text labels alongside state color.

### Don't

- Do not add shadows to flat workspace panels.
- Do not use the accent role for errors or destructive actions.
- Do not replace native audio controls with an imitation player.
