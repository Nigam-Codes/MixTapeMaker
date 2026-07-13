# 📼 MixTape Maker

Make mixtapes / medleys out of YouTube videos, right in your browser.

Paste YouTube links, trim each one with a start and end timestamp, arrange the
order, and hit play — the app plays your clips back-to-back like one continuous
mixtape.

## Features

- **Add any YouTube link** — `youtube.com/watch`, `youtu.be`, Shorts, embeds,
  even a bare video ID. A `?t=` timestamp in the URL is picked up as the clip's
  start time automatically.
- **Timestamp control per clip** — set a start and end time for every track
  (`m:ss`, `h:mm:ss`, or plain seconds). Edit them inline any time.
- **Order control** — drag and drop tracks, or use the ↑ / ↓ buttons.
- **Continuous playback** — clips play in sequence with prev / next / pause
  controls, a clip-relative progress bar, and an optional loop mode.
- **Saved automatically** — your mixtape persists in the browser
  (`localStorage`).
- **Shareable** — the 🔗 Share button copies a link that encodes the whole
  tracklist in the URL, so anyone can open your mixtape.

## Running it

It's a fully static site — no build step, no dependencies.

- Open `index.html` in a browser, or serve the folder:
  `python3 -m http.server` and visit <http://localhost:8000>.
- Or use the GitHub Pages deployment (see below).

## GitHub Pages

The included workflow (`.github/workflows/deploy-pages.yml`) publishes the site
with GitHub Actions on every push. If the site doesn't appear after the first
run, enable it once under **Settings → Pages → Source: GitHub Actions**.

## How it works

- Playback uses the [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
  (`loadVideoById` with `startSeconds` / `endSeconds`), so trimming needs no
  server and no API key.
- Video titles are looked up best-effort via noembed.com; thumbnails come from
  `i.ytimg.com`.
- Share links use a compact URL hash format:
  `#m=<videoId>.<start>.<end>~<videoId>.<start>.<end>…`

## Notes / limitations (first draft)

- Videos that disallow embedding are skipped automatically with a notice.
- Playback needs one click to start (browser autoplay policies).
- No crossfading between clips yet — clips cut from one to the next.
