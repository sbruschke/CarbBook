# Log webhook (Discord)

A device that *creates* a log entry posts the accountability text to a user-configured webhook,
with a per-item breakdown the copy-pasteable text does not have.

Decisions (user, 2026-09-23):
- Fires **client-side, immediately on save** — not server-side on sync. Instant, and the URL
  never reaches the server.
- **Once per entry**: only entry *creation* posts. Editing a logged entry posts nothing, so no
  dedupe state is needed — the creation moment is the only send site (Calculator `logIt`).
- **Web + iOS** both get the settings field. The URL is a per-device secret: web keeps it in
  IndexedDB `meta`, iOS in the Keychain. It is never put in a sync table.
- The existing copy-pasteable accountability text is unchanged. The breakdown is webhook-only.

## Message

```
As of 9/20/26, 12:24:58 PM CDT my blood sugar is 170. I am eating something with 59 carbs and so am giving myself 7 units of fast acting insulin.

In it:
• Cheerios — 1 cup · 24 g carbs
• Milk, 2% — 8 fl oz · 12 g carbs
• Gatorade — 23 g carbs
```

Sentence first, verbatim from `accountabilityText`, so the webhook and the copy button never
disagree. Items are pre-formatted by the caller (`name`, `amount`, `carbs_g`) exactly as `when`
already is — locale/portion formatting is client work, not core work. Over Discord's 2000-char
cap the tail of the list is replaced with `• …and N more`; the sentence is never truncated.

## Tasks

1. `packages/core/src/webhook.ts` — `webhookMessage`, `webhookUrlProblem`, `isDiscordWebhookUrl`,
   `DISCORD_CONTENT_LIMIT`. Exported from `index.ts`.
2. `testdata/webhook-vectors.json` — message + URL cases, shared by both cores.
3. `packages/core/test/webhook.test.ts` — runs the vectors.
4. `web/src/lib/webhook.ts` — `postWebhook(url, content)`: JSON `{content}`, timeout, non-2xx throws.
5. `web/src/db/meta.ts` — `webhook_url` meta key.
6. `web/src/settings/WebhookSettings.tsx` + wire into `screens/Settings.tsx`: URL field, save,
   clear, "Send test message". Says plainly that it is this device only.
7. `web/src/screens/Calculator.tsx` — `logIt` posts after `saveMany`; a failed post is reported in
   the status line and never blocks or unwinds the log.
8. iOS core mirror `Webhook.swift` + `WebhookTests.swift`; register the vectors in
   `ios/scripts/sync-testdata.sh`.
9. `ios/CarbBookKit/.../WebhookSender.swift` over the existing `HTTPTransport`, + tests.
10. iOS `Keychain` generalised to any account; `WebhookSettings` store.
11. iOS `Settings/WebhookSettingsView.swift` + a "Webhook" section in `SettingsView`.
12. `CalculatorModel.logIt` posts after `app.save`.
13. README env/behaviour note. Full `pnpm test` + both Swift packages.

## Status

Done 2026-09-23. `pnpm test` (1145) + `pnpm typecheck` green; CarbBookCore (130) and CarbBookKit
(242) green under `ios/scripts/swift-test.sh`. The iOS **app target** is not compiled here (no
Xcode on this machine) — `build-ipa.yml` is the first real compile of the SwiftUI changes.
