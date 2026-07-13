#!/usr/bin/env python3
"""Local companion server for MixTape Maker.

Runs on your own machine and gives the web app one-click, direct
mixtape.mp3 / mixtape.mp4 downloads. The page (local or the GitHub Pages
deployment) detects it on http://127.0.0.1:8765 automatically.

Setup: none. On first run this script downloads standalone yt-dlp and
ffmpeg builds into ~/.mixtape-helper/bin if they aren't already on your
PATH. Python 3.8+ is the only requirement.

Usage:
    python3 mixtape_server.py        (Windows: py mixtape_server.py)

Only download content you own or have permission to use.
"""

import json
import os
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
MAX_TRACKS = 50
CLIP_TIMEOUT = 600  # seconds per yt-dlp/ffmpeg invocation
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")
BIN_DIR = os.path.join(os.path.expanduser("~"), ".mixtape-helper", "bin")

# Resolved absolute paths of the tools ({} until bootstrap() runs)
TOOLS = {}


# ---------------------------------------------------------------------------
# Tool bootstrap: find yt-dlp/ffmpeg on PATH, or download standalone builds
# ---------------------------------------------------------------------------

def _download(url, dest):
    print(f"  fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "mixtape-helper"})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def _extract_single(archive, match, dest):
    """Pull one file out of a zip/tar archive into dest."""
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as z:
            member = next(m for m in z.namelist() if match(m))
            with z.open(member) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
    else:
        with tarfile.open(archive) as tf:
            member = next(m for m in tf.getmembers() if match(m.name))
            with tf.extractfile(member) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)


def ensure_tool(name):
    """Return an absolute path to `name`, downloading a standalone build
    into BIN_DIR the first time if it isn't installed."""
    found = shutil.which(name)
    if found:
        return found
    exe = name + (".exe" if os.name == "nt" else "")
    dest = os.path.join(BIN_DIR, exe)
    if os.path.exists(dest):
        return dest

    os.makedirs(BIN_DIR, exist_ok=True)
    sysname = platform.system()
    print(f"{name} not found — downloading a standalone build (one-time)...")

    if name == "yt-dlp":
        asset = {"Windows": "yt-dlp.exe", "Darwin": "yt-dlp_macos"}.get(sysname, "yt-dlp")
        _download(f"https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset}", dest)
    else:  # ffmpeg
        archive = dest + ".download"
        if sysname == "Windows":
            _download("https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", archive)
            _extract_single(archive, lambda m: m.endswith("/bin/ffmpeg.exe"), dest)
        elif sysname == "Darwin":
            _download("https://evermeet.cx/ffmpeg/getrelease/zip", archive)
            _extract_single(archive, lambda m: os.path.basename(m) == "ffmpeg", dest)
        else:
            arch = "arm64" if platform.machine().lower() in ("aarch64", "arm64") else "amd64"
            _download(f"https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-{arch}-static.tar.xz", archive)
            _extract_single(archive, lambda m: m.endswith("/ffmpeg"), dest)
        os.remove(archive)

    if os.name != "nt":
        os.chmod(dest, os.stat(dest).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    print(f"  installed {name} → {dest}")
    return dest


def bootstrap():
    for name in ("yt-dlp", "ffmpeg"):
        try:
            TOOLS[name] = ensure_tool(name)
        except Exception as e:  # network down, unexpected archive layout, ...
            print(f"WARNING: could not set up {name}: {e}")
            print(f"         Install it manually and re-run (make sure '{name}' is on your PATH).")


def tools_present():
    return len(TOOLS) == 2


# ---------------------------------------------------------------------------
# Mixtape building
# ---------------------------------------------------------------------------

def run(cmd, cwd):
    subprocess.run(cmd, cwd=cwd, check=True, timeout=CLIP_TIMEOUT,
                   stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)


def section_args(track):
    start = int(track.get("start") or 0)
    end = track.get("end")
    if start == 0 and end is None:
        return []
    return ["--download-sections", f"*{start}-{end if end is not None else 'inf'}",
            "--force-keyframes-at-cuts"]


def build_mixtape(kind, tracks, workdir):
    """Download every clip at its timestamps and stitch them into one file.
    Returns the absolute path of the finished mixtape."""
    for i, t in enumerate(tracks, 1):
        out = os.path.join(workdir, f"{i:02d}.%(ext)s")
        url = f"https://www.youtube.com/watch?v={t['videoId']}"
        if kind == "mp3":
            cmd = [TOOLS["yt-dlp"], "-x", "--audio-format", "mp3", "--audio-quality", "0"]
        else:
            cmd = [TOOLS["yt-dlp"], "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"]
        run(cmd + section_args(t) + ["-o", out, url], workdir)

    ext = "mp3" if kind == "mp3" else "mp4"
    clips = sorted(f for f in os.listdir(workdir) if re.match(rf"^\d\d\.{ext}$", f))
    if not clips:
        raise RuntimeError("no clips were downloaded")

    if kind == "mp4":
        # Normalize size/fps/codecs so the clips concatenate cleanly
        normalized = []
        for i, f in enumerate(clips, 1):
            norm = f"norm_{i:02d}.mp4"
            run([TOOLS["ffmpeg"], "-y", "-i", f,
                 "-vf", "scale=1280:720:force_original_aspect_ratio=decrease,"
                        "pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30",
                 "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                 "-c:a", "aac", "-b:a", "192k", "-ar", "44100", norm], workdir)
            normalized.append(norm)
        clips = normalized

    concat_list = os.path.join(workdir, "concat.txt")
    with open(concat_list, "w") as fh:
        for f in clips:
            fh.write(f"file '{f}'\n")

    out_path = os.path.join(workdir, f"mixtape.{ext}")
    if kind == "mp3":
        run([TOOLS["ffmpeg"], "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
             "-c:a", "libmp3lame", "-b:a", "192k", out_path], workdir)
    else:
        run([TOOLS["ffmpeg"], "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
             "-c", "copy", out_path], workdir)
    return out_path


def parse_request(data):
    kind = data.get("kind")
    if kind not in ("mp3", "mp4"):
        raise ValueError("kind must be 'mp3' or 'mp4'")
    tracks = data.get("tracks")
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= MAX_TRACKS:
        raise ValueError(f"tracks must be a list of 1-{MAX_TRACKS} items")
    for t in tracks:
        if not VIDEO_ID_RE.match(str(t.get("videoId", ""))):
            raise ValueError("invalid videoId")
        start = t.get("start") or 0
        end = t.get("end")
        if not isinstance(start, int) or start < 0:
            raise ValueError("invalid start time")
        if end is not None and (not isinstance(end, int) or end <= start):
            raise ValueError("invalid end time")
    return kind, tracks


# ---------------------------------------------------------------------------
# HTTP server
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    browser_seen = False

    def log_message(self, *args):
        pass  # keep the terminal clean; we print our own status lines

    def _headers(self, status, ctype, length=None, extra=None):
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", ctype)
        if length is not None:
            self.send_header("Content-Length", str(length))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def _text(self, status, msg):
        body = msg.encode()
        self._headers(status, "text/plain; charset=utf-8", len(body))
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._headers(204, "text/plain", 0)

    def do_GET(self):
        if self.path != "/health":
            return self._text(404, "not found")
        if not Handler.browser_seen:
            Handler.browser_seen = True
            print("✅ Browser connected — the MP3/MP4 buttons now download files directly.")
        body = json.dumps({"ok": tools_present(), "service": "mixtape-maker"}).encode()
        self._headers(200, "application/json", len(body))
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/export":
            return self._text(404, "not found")
        if not tools_present():
            return self._text(500, "yt-dlp and/or ffmpeg unavailable — check the helper's terminal output")
        try:
            length = int(self.headers.get("Content-Length", 0))
            kind, tracks = parse_request(json.loads(self.rfile.read(length)))
        except (ValueError, json.JSONDecodeError) as e:
            return self._text(400, f"bad request: {e}")

        print(f"[export] building mixtape.{kind} from {len(tracks)} clip(s)...")
        with tempfile.TemporaryDirectory(prefix="mixtape-") as workdir:
            try:
                out_path = build_mixtape(kind, tracks, workdir)
            except subprocess.CalledProcessError as e:
                return self._text(500, f"download/stitch failed: {e}")
            except (subprocess.TimeoutExpired, RuntimeError) as e:
                return self._text(500, str(e))

            size = os.path.getsize(out_path)
            ctype = "audio/mpeg" if kind == "mp3" else "video/mp4"
            self._headers(200, ctype, size,
                          {"Content-Disposition": f'attachment; filename="mixtape.{kind}"'})
            with open(out_path, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile)
        print(f"[export] done — sent mixtape.{kind} ({size} bytes)")


if __name__ == "__main__":
    print("MixTape Maker helper starting...")
    bootstrap()
    if not tools_present():
        print("Exports will fail until yt-dlp and ffmpeg are available (see warnings above).")
    print(f"Listening on http://127.0.0.1:{PORT} — keep this window open and")
    print("go back to the MixTape Maker page; it connects automatically.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
