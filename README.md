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
- **Trim slider** — every track gets a dual-handle slider between the video's
  start and finish; drag the handles to pick the clip visually. (The video's
  length is probed with a hidden muted player — no API key needed.)
- **Order control** — drag and drop tracks, or use the ↑ / ↓ buttons; each
  track has a 🗑 remove button.
- **MP3 / MP4 export** — the ⬇ MP3 / ⬇ MP4 buttons build a single
  `mixtape.mp3` / `mixtape.mp4` from all your clips at their exact timestamps.
  Browsers can't extract media from YouTube directly (CORS + signed streams),
  so there are two modes:
  - **Direct download** — run the local helper once
    (see [Direct MP3/MP4 downloads](#direct-mp3--mp4-downloads)) and the
    buttons return the finished file in one click.
  - **Script fallback** — without the helper, the buttons download a
    ready-to-run bash script (yt-dlp + ffmpeg) that produces the same file.

  Only download content you have the rights to.
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

## Direct MP3 / MP4 downloads

The web app can't rip media out of YouTube itself, but it automatically talks
to a small helper server when one is running on your machine. Setup is one
file and one command (the app also walks you through this in the
"⚡ Set up the helper" banner):

```sh
# Download server/mixtape_server.py (or use the in-app link), then:
python3 mixtape_server.py           # Windows: py mixtape_server.py
```

No other installs: on first run the helper downloads standalone yt-dlp and
ffmpeg builds into `~/.mixtape-helper/bin` automatically (it uses your system
copies if you already have them). Keep it running (it listens on
`http://127.0.0.1:8765`), open the app — local or the GitHub Pages site — and
the ⬇ MP3 / ⬇ MP4 buttons now download the finished `mixtape.mp3` /
`mixtape.mp4` directly. Long mixtapes take a few minutes; watch the helper's
terminal for progress.

Why a local helper instead of a hosted backend? YouTube blocks most
cloud-server IPs, so downloads only work reliably from a residential machine —
and this way your mixtape never leaves your computer.

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
