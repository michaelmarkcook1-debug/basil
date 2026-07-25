# Basil for iOS — native Siri App Intents

A minimal SwiftUI app whose only job is first-class Siri integration: say
**"Hey Siri, Ask Basil"** (no Shortcuts app involved), Siri asks what you want,
Basil answers out loud. Works on iPhone, iPad and Apple Watch (via iPhone).

Under the hood it POSTs to Basil's existing voice endpoint
(`/api/stig/siri`) with your personal Siri token, exactly like the Shortcut —
but App Intents give real Siri phrases, follow-up dialogs, and no plumbing to
break.

## Build & install (~15 minutes, one time)

1. Open **Xcode 15+** → File → New → Project → **iOS App**.
   - Product Name: `Basil`  (the Siri phrase becomes "Ask Basil" from this name)
   - Interface: SwiftUI · Language: Swift · Uncheck tests.
   - Organisation identifier: `io.talentgenius` (or anything).
2. In the new project, **delete** the generated `BasilApp.swift` and
   `ContentView.swift`, then drag the four `.swift` files from this folder into
   the project navigator (check "Copy items if needed" + your app target).
3. Project → target **Basil** → General → Minimum Deployment: **iOS 17.0**.
4. Signing & Capabilities → Team: your personal Apple ID team
   (free account works; app re-signs every 7 days, or lives for a year with a
   paid developer account).
5. Plug in your iPhone → select it as the run destination → **Run** (⌘R).
   - First run: on the phone, Settings → General → VPN & Device Management →
     trust your developer certificate.
6. Open the Basil app on the phone → paste your **server URL**
   (`https://basil-app.vercel.app`) and your **Siri token**
   (Basil → Settings → Developer → Siri Shortcut setup → step 1) → Save.
7. Say **"Hey Siri, Ask Basil"**. First time, iOS may show a Siri permission
   prompt. The phrase also appears automatically in the Shortcuts app under
   "App Shortcuts".

## Files

- `BasilApp.swift` — app entry + settings screen (server URL + token).
- `KeychainHelper.swift` — token storage in the iOS Keychain (never UserDefaults).
- `BasilAPI.swift` — the one network call to `/api/stig/siri`.
- `AskBasilIntent.swift` — the App Intent + Siri phrases ("Ask Basil …").

## Notes

- The token is entered by you, on the device, and stored in the Keychain.
- If Siri says it can't reach Basil, re-check the token in the app; a revoked
  or regenerated token in Basil's settings must be re-pasted here.
- This scaffold intentionally has no other features — Basil's PWA remains the
  full experience; this app is the Siri bridge.
