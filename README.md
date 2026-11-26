# Cast to Sonos for Firefox

Stream audio from any **Firefox** tab directly to your **Sonos** speakers and multi-room groups — **100% free, local LAN, zero cloud servers, zero ffmpeg, and no subscriptions**.

---

## Features

- **One-Click Tab Casting** — Works on YouTube, Twitch, SoundCloud, Bandcamp, podcasts, HTML5 players, and Web Audio apps.
- **All Audio Quality Tiers Unlocked (Free)** — Mono (96 kbps), HD Stereo (192 kbps), Hi-Fi Stereo (320 kbps), and **Lossless PCM** (44.1 kHz uncompressed stereo WAV).
- **Automatic Video Frame Sync** — Buffers video frames via a lightweight canvas overlay to match Sonos playback latency and keep video lip-synced with your speakers.
- **Rich Sonos App Presence** — Sends track title, site/artist name, and album artwork via UPnP DIDL-Lite so the official Sonos app displays what's playing.
- **Always In Sync** — Popup, background coordinator, and bridge stay tied together as one single source of truth; reopening the popup immediately restores live casting state, VU meters, Play/Pause, volume, quality, and cross-tab switching.
- **Dynamic Color Matching & Dark Mode** — Adapts the popup accent glow to the active tab while maintaining crisp dark-mode contrast.
- **Zero External Binaries** — Pure Node.js local audio bridge using `@breezystack/lamejs` (no ffmpeg required).

---

## Does Chrome's Cast to Sonos Use a Bridge? Why Do We Need One?

**Yes — Chrome's `casttosonos.com` ALSO uses a bridge, just hosted in their paid cloud instead of on your PC.**

- **Browser security sandbox:** Neither Chrome nor Firefox allows a browser extension to open a listening TCP HTTP server or send UDP multicast (SSDP) discovery packets.
- **Sonos speaker architecture:** Sonos speakers cannot receive raw WebRTC/WebSocket audio pushed from a browser. They only play audio by **pulling an `http(s)://.../stream` URL** over the network.
- **Chrome (`casttosonos.com`):** Streams Chrome tab audio up to their paid cloud server → exposes a public HTTPS stream URL → uses the Sonos Cloud Control API (requiring your Sonos account login + \$4.99–\$7.99/month subscription) to tell your speaker to pull it back down from the internet.
- **This Firefox version:** Runs a tiny silent bridge right on your PC → **\$0/month forever**, **no Sonos login/OAuth**, **supports Lossless 1.4 Mbps WAV**, **lower latency**, and **100% private** (audio never leaves your local Wi-Fi).

---

## Official Installation (Permanent & Silent)

### 1. Install the Silent Local Bridge (Windows)
Double-click **`install-official.bat`** (one time):
- Registers the Firefox Native Messaging auto-launch host.
- Adds a hidden Windows Startup launcher (`CastToSonosBridge.vbs`) so the bridge runs completely silently in the background with **no terminal window**.
- *(To remove it cleanly anytime, run **`uninstall-official.bat`**.)*

### 2. Install the Extension Permanently in Firefox
Release Firefox requires permanent add-ons to carry a Mozilla signature (free & takes ~2 minutes for private/unlisted self-distribution):
1. Build the release package (already built in `dist/`):
   ```bash
   npm run pack:xpi
   ```
2. Open **[Mozilla Add-ons Developer Hub](https://addons.mozilla.org/developers/addon/submit/distribution)**.
3. Sign in with a free Mozilla account and select **"On your own"** (*Unlisted / Self-Distribution*).
4. Upload **`dist/cast-to-sonos-firefox-1.0.0.zip`**.
5. Once automated validation finishes (~1–2 min), download the Mozilla-signed **`.xpi`** file and drag-and-drop it into Firefox (or open it via `about:addons` → gear icon → *Install Add-on From File…*).

*(For quick developer testing without signing, open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select `extension/manifest.json`.)*

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Run the local Sonos bridge in the foreground |
| `npm test` | Run automated unit & integration tests |
| `npm run pack:xpi` | Build official AMO-ready `.zip` and `.xpi` archives in `dist/` |
| `install-official.bat` | Install silent Windows Startup bridge + Firefox Native Messaging host |
| `uninstall-official.bat` | Cleanly remove Startup bridge + Native Messaging registration |
