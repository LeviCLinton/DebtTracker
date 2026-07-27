# DebtTracker — Android build

This is a ready-to-build Capacitor project that wraps the DebtTracker web app
in a native Android shell. Everything (React, your data, IndexedDB,
WebCrypto) runs bundled locally on the device — no server, no hosting
needed, same as the browser version.

**Why this isn't already a finished .apk:** building one requires the Android
SDK, Gradle, and Google's Maven repository — none of which are reachable from
the sandboxed environment these files were generated in. You'll need to run
the actual build step yourself, once, on a machine with normal internet
access and Android Studio installed. It's about 10 minutes total.

## What's in here
```
debttracker-android/
├── package.json          — Capacitor dependencies
├── capacitor.config.json — app id, name, points at www/
└── www/                  — the actual app:
    ├── debt-dashboard.html
    ├── manifest.json
    ├── service-worker.js
    ├── icon-192.png
    ├── icon-512.png
    └── icon-512-maskable.png
```

## Option A — Build the APK yourself (fully offline app, recommended)

**You'll need:** [Node.js](https://nodejs.org) and [Android Studio](https://developer.android.com/studio) installed once.

```bash
cd debttracker-android
npm install
npx cap add android
npx cap sync android
npx cap open android
```

That last command opens the project in Android Studio. Once it finishes
indexing/Gradle-syncing:

1. Menu: **Build → Generate Signed Bundle / APK**
2. Choose **APK**
3. Create a new keystore the first time (Android requires every app be signed —
   save this keystore file somewhere safe, you'll reuse it for future updates)
4. Choose **release**, click **Finish**

Android Studio will output a real, installable `app-release.apk` — copy it to
your phone (or `adb install app-release.apk`) and open it like any app.

## Option B — No Android Studio at all (PWABuilder)

Since DebtTracker already ships a proper PWA manifest and service worker, you
can skip Android tooling entirely:

1. Host the contents of the `www/` folder somewhere with HTTPS — even a free
   static host like GitHub Pages, Netlify, or Vercel works
2. Go to **https://www.pwabuilder.com**, paste that URL in
3. It analyzes the manifest/service worker (already configured correctly)
   and gives you a signed, downloadable Android package — no local build step

This is the faster route if you don't want to install Android Studio, at the
cost of the app loading from your hosted URL rather than being fully bundled
offline inside the APK (Option A embeds everything locally instead).

## A note on updates

Whenever you change the app, re-run `npx cap sync android` before rebuilding
in Android Studio — that's the step that copies the latest `www/` contents
into the native project.

## A note on optional network features

A couple of DebtTracker's features are opt-in exceptions to "nothing leaves
this device," and are worth knowing about before you ship a build:

- **Connect your own AI (assistant settings):** if the person supplies their
  own Anthropic API key, chat messages are sent directly from the device to
  `api.anthropic.com`. Off by default.
- **Live currency conversion (Settings → Currency):** converting balances
  fetches a live exchange rate from a free, keyless service
  (`open.er-api.com`). Only the two currency codes are sent — no financial
  data leaves the device.
- **Background reminders (Settings → Background reminders):** opt-in due-date
  and backup nudges via Periodic Background Sync, available only on
  Chromium-based browsers/WebViews. The service worker never has access to
  the encryption key, so it can't decrypt real entries — it only reads a
  small unencrypted due-soon count and some timestamps.

None of these are required for the app to function, and all are disclosed to
the person in-app before they're ever enabled.
