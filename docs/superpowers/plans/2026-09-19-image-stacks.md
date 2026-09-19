# Image Stacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** An image everywhere a food or meal is named, and an overlapping carb-ordered stack wherever several items collapse onto one row.

**Architecture:** One pure ordering function in each core, driven by shared JSON vectors so web and iOS cannot drift; one presentational component per client consuming it; then the surfaces that are missing icons get them.

**Tech Stack:** TypeScript core + React PWA, Swift core + SwiftUI, vitest, Playwright, XCTest.

**Spec:** `docs/superpowers/specs/2026-09-19-image-stacks-design.md`
**Branch:** `feat/image-stacks` (spec commit `6871c9e`)

---

## Task 1: The shared ordering rule

**Files:** create `packages/core/src/imageStack.ts`, `testdata/image-stack-vectors.json`, `packages/core/test/imageStack.test.ts`; mirror in `ios/CarbBookCore/Sources/CarbBookCore/ImageStack.swift` + tests.

The rule, exactly:

```ts
export interface StackEntry { imageId: string | null; carbs: number | null }
export interface StackLayout { imageIds: string[]; overflow: number }

/** Photos to draw, biggest carb contribution first, and how many items they do not cover. */
export function imageStackLayout(entries: StackEntry[], max = IMAGE_STACK_MAX): StackLayout
```

- Entries with a null/blank `imageId` are discarded but still counted in `overflow`.
- Remaining entries sort by `carbs` descending; **null carbs sort last**; ties keep original order (stable).
- `imageIds` is the first `max` of that order; `overflow = entries.length - imageIds.length`.
- `IMAGE_STACK_MAX = 3`, exported from core so both clients and the CSS agree.
- Empty input, or input where nothing has an image, yields `{ imageIds: [], overflow: <count> }`; callers render nothing when `imageIds` is empty.

Vectors in `testdata/image-stack-vectors.json` covering: empty; all images; more than three; some missing images; all missing; null carbs mixed with numbers; ties preserving order; a single entry. Both cores run the same file, as the dose vectors already do — follow that harness exactly.

Commit: `core: carb-ordered image stack layout`

---

## Task 2: Web — circular icons, the stack component, and the log

**Files:** `web/src/ui/ImageThumb.tsx`, `web/src/ui/ImageStack.tsx` (new), `web/src/styles.css`, `web/src/screens/Log.tsx`, `web/src/log/LogEntryEditor.tsx`, `web/src/screens/Meals.tsx`, `web/src/screens/Plan.tsx`, tests + e2e.

1. `ImageThumb` gains a `shape?: 'circle' | 'rounded'` prop defaulting to `circle`; the editor previews pass `rounded`. Pure styling — no behaviour change, and the existing tests must pass untouched.
2. `ImageStack` takes `entries: StackEntry[]` and a `size`, calls `imageStackLayout`, renders the photos absolutely positioned at 55% overlap with descending `z-index`, plus a `+N` badge. `aria-hidden` on the images, one `aria-label` of `"N items"` on the container. Renders `null` when `imageIds` is empty.
3. **Log entry rows** (`Log.tsx`): a stack built from that entry's `log_item` rows — `imageId` from the item's resolved food/meal, `carbs` from the stored `carbs_g`. Reuse the resolution the row already does for `display_name`; add no per-row query.
4. **Log item rows** (`LogEntryEditor.tsx`): a single icon each.
5. **Meals list** (`Meals.tsx`): the meal's own image when set, else a stack of its components via `itemCarbs` against the catalog the screen holds.
6. **Plan** (`Plan.tsx`): slot rows get a stack.

Tests: component tests for the three-photo cap, the badge, the nothing-to-show case and the meal fallback; an e2e asserting a log row with two photographed items renders a stack.

Commit: `web: circular icons, image stacks, and images in the log`

---

## Task 3: iOS — the same, plus the week cells

**Files:** `ios/CarbBook/Images/ImageThumbView.swift`, `ios/CarbBook/Images/ImageStackView.swift` (new), `ios/CarbBook/Log/LogView.swift`, `ios/CarbBook/Log/LogEntryView.swift`, `ios/CarbBook/Plan/PlanWeekView.swift`, `ios/CarbBook/Meals/MealsView.swift`.

`ImageThumbView` gains the same `shape` parameter, defaulting to circle. `ImageStackView` mirrors the web component using `ImageStackLayout` from `CarbBookCore` — `ZStack` with per-layer `offset`, `zIndex` and the badge.

Surfaces: `LogView` entry rows (stack), `LogEntryView` item rows (icons), `PlanWeekView` cells (stack beside the existing joined caption — do **not** restructure the caption), `MealsView` (own image, else component stack).

`./ios/scripts/swift-test.sh CarbBookCore` and `CarbBookKit` must pass; the app target is verified by CI.

Commit: `ios: circular icons, image stacks, and images in the log`

---

## Task 4: Ship

Full suites, push, PR, CI green, merge, deploy (`./deploy/deploy.sh`), bump `MARKETING_VERSION` to 0.4.0, let the release workflow publish, run `systemctl --user start ipa-sync.service`, verify `ipa.dxshdw.dev/source.json`.
