# Food images everywhere, and image stacks for groups

Date: 2026-09-19
Status: approved, not implemented

Follows `2026-09-18-food-images-design.md`, which added one optional image per food and
per meal. That spec put images in the editors, both library lists, search results, item
rows and plan item rows — and explicitly left them out of the log, on the reasoning that
items inherit their food's image and so did not need one.

That reasoning was wrong. The log is where the user looks at what they actually ate, so it
is the surface where identifying a food at a glance matters most. The first thing the user
did after the feature shipped was add photos to two snack foods and go looking for them in
the log, where nothing appeared.

This spec closes that gap and adds a second idea: where several items are collapsed onto
one row, show an overlapping stack of their photos, biggest carb contribution frontmost.

## Goals

1. An image appears **everywhere a food or meal is named**. No exceptions, on either client.
2. A row representing several items shows a stack, so a meal or a logged snack is
   identifiable without reading the text.
3. The stack encodes something useful rather than being decoration: the item contributing
   the most carbohydrate is the most visible.

## Non-goals

- Tapping a stack, or tapping an individual photo within one. The row's existing tap target
  is unchanged.
- Animation or transitions.
- Cropping, focal points, or any per-image art direction.
- Images on quick-carb rows. They reference no food and have nothing to show.
- Any change to dose or carb maths. Images remain identification only.

## Shape: circular icons

List thumbnails become **circles** in every context. The user's own words were "profile
icons", and circles carry that meaning; they also overlap far more legibly than rounded
squares, which matters for the stack.

The one exception is the large preview inside the editor, where the user is choosing and
judging the image itself — that stays a rounded rectangle. So: circular when the image
identifies a thing in a list, rectangular when the image *is* the subject.

## The stack

One shared component — `ImageStack` on web, `ImageStackView` on iOS — used in every
collapsed-group context. Not three bespoke layouts.

**Input:** an ordered list of `{ imageId: string | null, carbs: number }`, one entry per
item in the group, in the group's own display order.

**Rules:**

1. Discard entries with no `imageId`. They are counted, never drawn.
2. Sort the remainder by `carbs` **descending**. Ties break by the original position, so
   the order is stable across renders rather than jittering.
3. Draw at most **3** photos. The first is frontmost and fully visible; each subsequent
   photo sits behind and to the right at **55% overlap**, so every one is partly visible.
4. Append a `+N` badge where `N = total entries - photos drawn`. This absorbs both items
   whose food has no image and quick-carb rows. Omit the badge when `N` is 0.
5. If no entry has an image, render **nothing** — no empty scaffold, no placeholder ring.
   This matches how a single missing thumbnail already behaves.

**Why biggest-carb-frontmost:** in a diabetes app the item driving the dose is the one worth
recognising first. It also gives the stack a defensible order rather than an arbitrary one.

**Accessibility:** the photos are decorative and are hidden from assistive technology; the
stack carries a single label of the form "3 items". Every row already states its contents in
text, so nothing is conveyed by image alone.

## Where each surface gets what

| Surface | Shows |
| --- | --- |
| Foods list, search results | single circular icon |
| Meals list | the meal's own image; **falls back to a stack of its components** |
| Log entry row | stack of the entry's items |
| Log item rows (expanded entry) | single circular icon each |
| Plan slot row, plan week cell | stack of the slot's items |
| Meal component rows, calculator item rows | single circular icon each |
| Food and meal editors | large rectangular preview and picker (unchanged) |

The meal fallback matters: most meals will never get a photo of their own, but their
ingredients increasingly will, so a soup shows its sausage and tomatoes rather than an empty
slot. A meal *with* its own image always shows that image — an explicit choice beats a
derived one.

## Where the carb numbers come from

- **Log items** already store `carbs_g` on the row. Free.
- **Meal and plan items** compute through the existing `itemCarbs` against the catalog the
  screen already holds. No new queries and no per-row lookups — every one of these surfaces
  already resolves each item to render its name, and the same resolved record supplies both
  the image id and the carbs.

An item whose carbs cannot be computed (an incomplete food) sorts last rather than being
dropped; it still has an image worth showing, and a missing number is not a reason to hide it.

## Missing surfaces this closes

Audited across both clients:

- **Web:** `src/screens/Log.tsx` (entry rows → stack) and `src/log/LogEntryEditor.tsx`
  (item rows → icons). Every other naming site already has an icon.
- **iOS:** `Log/LogView.swift` (entry rows → stack), `Log/LogEntryView.swift` (item rows →
  icons), and `Plan/PlanWeekView.swift` (week cells → stack). The week cells were skipped
  during the previous spec because that view renders a slot's items as one joined caption
  string rather than as rows; a stack sits beside that caption without restructuring it.

## Testing

- **Shared ordering rule** — the sort, the 3-photo cap, the badge arithmetic, the
  discard-then-count behaviour, ties, all-missing, and the incomplete-carbs case. Tested in
  both cores against the same cases so web and iOS cannot drift.
- **Web component** — renders 3 photos and a badge for a five-item group; renders nothing
  for a group with no images; the meal fallback picks the meal's own image when present.
- **Web e2e** — a logged entry with two photographed items shows a stack on the log row.
- **iOS** — the ordering helper under test in `CarbBookCore`; the SwiftUI views compile in CI
  and are verified on device.
- The existing image tests must keep passing untouched; circular styling changes no behaviour.

## Risks

1. **Cold-cache trickle.** A log screen full of stacks fetches many small images on first
   paint. They are cached by content hash forever afterwards, and each is ~10-40KB, but the
   first view of a long log on a new device will populate visibly. Accepted; prefetching is a
   separate concern and would be premature here.
2. **Row height.** Adding a 40px circle to log rows changes their metrics on a narrow phone.
   The stack's width is bounded by 3 photos plus a badge, but this needs checking on device
   rather than in a simulator alone.
3. **The meal fallback can mislead.** A stack of component photos is not a picture of the
   finished dish. It is an identification aid, and the row still names the meal — but it is
   worth knowing that "what the soup looks like" and "what went into the soup" are different
   things.
