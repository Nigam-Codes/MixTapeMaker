#!/usr/bin/env python3
"""Local companion server for MixTape Maker.

Runs on your own machine and gives the web app one-click, direct
mixtape.mp3 / mixtape.mp4 downloads. The page (local or the GitHub Pages
deployment) detects it on http://127.0.0.1:8765 automatically.

Requirements: yt-dlp and ffmpeg available on your PATH.
    pip install yt-dlp        (or: brew install yt-dlp / your package manager)
    ffmpeg from your package manager

Usage:
    python3 server/mixtape_server.py

Only download content you own or have permission to use.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
MAX_TRACKS = 50
CLIP_TIMEOUT = 600  # seconds per yt-dlp/ffmpeg invocation
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")


def tools_present():
    return shutil.which("yt-dlp") is not None and shutil.which("ffmpeg") is not None


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
            cmd = ["yt-dlp", "-x", "--audio-format", "mp3", "--audio-quality", "0"]
        else:
            cmd = ["yt-dlp", "-f", "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"]
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
            run(["ffmpeg", "-y", "-i", f,
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
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
             "-c:a", "libmp3lame", "-b:a", "192k", out_path], workdir)
    else:
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
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


class Handler(BaseHTTPRequestHandler):
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
        body = json.dumps({"ok": tools_present(), "service": "mixtape-maker"}).encode()
        self._headers(200, "application/json", len(body))
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/export":
            return self._text(404, "not found")
        if not tools_present():
            return self._text(500, "yt-dlp and/or ffmpeg not found on PATH")
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
    if not tools_present():
        print("WARNING: yt-dlp and/or ffmpeg not found on PATH — exports will fail.")
        print("Install them first: pip install yt-dlp && <package manager> install ffmpeg")
    print(f"MixTape Maker helper listening on http://127.0.0.1:{PORT}")
    print("Keep this running, then use the MP3/MP4 buttons in the web app.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
