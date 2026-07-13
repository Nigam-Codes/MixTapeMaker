/* MixTape Maker — build medleys from YouTube clips. */
"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const STORAGE_KEY = "mixtape.tracks.v1";

/** @type {{uid:string, videoId:string, title:string, start:number, end:number|null, duration:number|null}[]} */
let tracks = [];
let currentIndex = -1;      // index of the track loaded in the player
let player = null;          // YT.Player instance
let playerReady = false;
let progressTimer = null;

// ---------------------------------------------------------------------------
// URL + time parsing
// ---------------------------------------------------------------------------

function parseYouTubeUrl(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    // Allow bare video IDs
    if (/^[\w-]{11}$/.test(raw.trim())) return { videoId: raw.trim(), start: null };
    return null;
  }

  const host = url.hostname.replace(/^www\.|^m\./, "");
  let videoId = null;

  if (host === "youtu.be") {
    videoId = url.pathname.slice(1).split("/")[0];
  } else if (host === "youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v");
    } else {
      const m = url.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
      if (m) videoId = m[2];
    }
  }

  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return null;

  const t = url.searchParams.get("t") || url.searchParams.get("start");
  return { videoId, start: t !== null ? parseTimestampParam(t) : null };
}

// "1h2m3s", "2m30s", "90s", "90"
function parseTimestampParam(t) {
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m) return null;
  return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
}

// "1:02:03", "2:30", "95" -> seconds; "" -> null
function parseTimeInput(str) {
  const s = String(str || "").trim();
  if (s === "") return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const parts = s.split(":");
  if (parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
}

function formatTime(sec) {
  if (sec == null || isNaN(sec)) return "";
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Persistence + sharing
// ---------------------------------------------------------------------------

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
}

function load() {
  const fromHash = decodeShareHash();
  if (fromHash) {
    tracks = fromHash;
    history.replaceState(null, "", location.pathname + location.search);
    save();
    return;
  }
  try {
    tracks = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    tracks = [];
  }
  tracks.forEach(t => { if (!("duration" in t)) t.duration = null; });
}

// Hash format: #m=videoId.start.end~videoId.start.end (end empty = play to video end)
function buildShareHash() {
  const parts = tracks.map(t => `${t.videoId}.${t.start || 0}.${t.end == null ? "" : t.end}`);
  return "#m=" + parts.join("~");
}

function decodeShareHash() {
  const m = location.hash.match(/^#m=(.+)$/);
  if (!m) return null;
  const out = [];
  for (const part of m[1].split("~")) {
    const [videoId, start, end] = part.split(".");
    if (!/^[\w-]{11}$/.test(videoId)) continue;
    out.push(makeTrack(videoId, parseInt(start, 10) || 0, end === "" || end === undefined ? null : parseInt(end, 10)));
  }
  return out.length ? out : null;
}

function makeTrack(videoId, start, end) {
  return {
    uid: Math.random().toString(36).slice(2, 10),
    videoId,
    title: `YouTube video (${videoId})`,
    start: start || 0,
    end: end ?? null,
    duration: null,
  };
}

// Best-effort title lookup (noembed.com is CORS-friendly; failure is fine).
async function fetchTitle(track) {
  try {
    const res = await fetch(`https://noembed.com/embed?url=${encodeURIComponent("https://www.youtube.com/watch?v=" + track.videoId)}`);
    const data = await res.json();
    if (data && data.title) {
      track.title = data.title;
      save();
      renderPlaylist();
      if (currentIndex >= 0 && tracks[currentIndex] && tracks[currentIndex].uid === track.uid) {
        document.getElementById("np-title").textContent = track.title;
      }
    }
  } catch { /* offline or blocked — keep the fallback title */ }
}

// ---------------------------------------------------------------------------
// Duration probing (hidden muted player — lets the trim sliders know each
// video's length without needing a YouTube API key)
// ---------------------------------------------------------------------------

let probePlayer = null;
let probeReady = false;
let probeCurrent = null;
let probeTimer = null;
const probeQueue = [];

function enqueueProbe(track) {
  if (track.duration || probeQueue.includes(track) || probeCurrent === track) return;
  probeQueue.push(track);
  pumpProbe();
}

function pumpProbe() {
  if (!probeReady || probeCurrent) return;
  probeCurrent = probeQueue.shift() || null;
  if (!probeCurrent) return;
  try {
    probePlayer.mute();
    probePlayer.loadVideoById(probeCurrent.videoId);
    probeTimer = setTimeout(finishProbe, 10000); // give up on slow/blocked videos
  } catch {
    finishProbe();
  }
}

function onProbeStateChange(e) {
  if (e.data !== YT.PlayerState.PLAYING || !probeCurrent) return;
  const d = Math.floor(probePlayer.getDuration());
  probePlayer.stopVideo();
  if (d > 0) {
    const t = probeCurrent;
    t.duration = d;
    if (t.start >= d) t.start = 0;
    if (t.end != null && (t.end > d || t.end <= t.start)) t.end = null;
    save();
    renderPlaylist();
  }
  finishProbe();
}

function finishProbe() {
  clearTimeout(probeTimer);
  probeCurrent = null;
  pumpProbe();
}

// ---------------------------------------------------------------------------
// YouTube IFrame API
// ---------------------------------------------------------------------------

window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player("player", {
    width: "100%",
    height: "100%",
    playerVars: { playsinline: 1, rel: 0 },
    events: {
      onReady: () => { playerReady = true; },
      onStateChange: onPlayerStateChange,
      onError: () => { toast("This video can't be embedded — skipping."); next(); },
    },
  });
  probePlayer = new YT.Player("probe", {
    width: "1",
    height: "1",
    playerVars: { playsinline: 1, mute: 1 },
    events: {
      onReady: () => { probeReady = true; pumpProbe(); },
      onStateChange: onProbeStateChange,
      onError: finishProbe,
    },
  });
};

function onPlayerStateChange(e) {
  const playBtn = document.getElementById("btn-play");
  if (e.data === YT.PlayerState.PLAYING) {
    playBtn.textContent = "⏸";
    startProgressTimer();
  } else {
    playBtn.textContent = "▶";
  }
  if (e.data === YT.PlayerState.ENDED) next();
}

function playIndex(i) {
  if (!playerReady || tracks.length === 0) return;
  if (i < 0 || i >= tracks.length) return;
  currentIndex = i;
  const t = tracks[i];
  const opts = { videoId: t.videoId, startSeconds: t.start || 0 };
  if (t.end != null && t.end > (t.start || 0)) opts.endSeconds = t.end;
  player.loadVideoById(opts);
  document.getElementById("player-placeholder").classList.add("hidden");
  const np = document.getElementById("now-playing");
  np.hidden = false;
  document.getElementById("np-title").textContent = t.title;
  renderPlaylist();
}

function next() {
  if (tracks.length === 0) return;
  if (currentIndex + 1 < tracks.length) {
    playIndex(currentIndex + 1);
  } else if (document.getElementById("chk-loop").checked) {
    playIndex(0);
  } else {
    stopProgressTimer();
    document.getElementById("btn-play").textContent = "▶";
  }
}

function prev() {
  if (tracks.length === 0) return;
  playIndex(Math.max(0, currentIndex - 1));
}

function togglePlay() {
  if (!playerReady || tracks.length === 0) return;
  if (currentIndex === -1) { playIndex(0); return; }
  const state = player.getPlayerState();
  if (state === YT.PlayerState.PLAYING) player.pauseVideo();
  else player.playVideo();
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(updateProgress, 250);
}

function stopProgressTimer() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function updateProgress() {
  if (!playerReady || currentIndex < 0 || !tracks[currentIndex]) return;
  const t = tracks[currentIndex];
  const pos = player.getCurrentTime();
  const clipStart = t.start || 0;
  const clipEnd = t.end != null && t.end > clipStart ? t.end : player.getDuration();
  const clipLen = Math.max(1, clipEnd - clipStart);
  const elapsed = Math.min(Math.max(0, pos - clipStart), clipLen);
  document.getElementById("np-progress-bar").style.width = `${(elapsed / clipLen) * 100}%`;
  document.getElementById("np-elapsed").textContent = formatTime(elapsed);
  document.getElementById("np-duration").textContent = formatTime(clipLen);
}

// ---------------------------------------------------------------------------
// Playlist rendering + editing
// ---------------------------------------------------------------------------

function clipLength(t) {
  const start = t.start || 0;
  if (t.end != null && t.end > start) return t.end - start;
  if (t.duration != null) return Math.max(0, t.duration - start);
  return null;
}

function renderPlaylist() {
  const list = document.getElementById("playlist");
  const tpl = document.getElementById("track-template");
  list.innerHTML = "";

  tracks.forEach((t, i) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.uid = t.uid;
    if (i === currentIndex) li.classList.add("playing");
    li.querySelector(".track-index").textContent = i + 1;
    const thumb = li.querySelector(".track-thumb");
    thumb.src = `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg`;
    thumb.alt = t.title;
    li.querySelector(".track-title").textContent = t.title;
    li.querySelector(".track-title").title = t.title;
    li.querySelector(".edit-start").value = formatTime(t.start) || "0:00";
    li.querySelector(".edit-end").value = t.end != null ? formatTime(t.end) : "";
    const len = clipLength(t);
    li.querySelector(".track-duration").textContent = len != null ? `· ${formatTime(len)} clip` : "";

    setupSlider(li, t);

    li.querySelector(".btn-play-track").addEventListener("click", () => playIndex(i));
    li.querySelector(".btn-up").addEventListener("click", () => moveTrack(i, i - 1));
    li.querySelector(".btn-down").addEventListener("click", () => moveTrack(i, i + 1));
    li.querySelector(".btn-remove").addEventListener("click", () => removeTrack(i));
    li.querySelector(".edit-start").addEventListener("change", (e) => editTime(i, "start", e.target));
    li.querySelector(".edit-end").addEventListener("change", (e) => editTime(i, "end", e.target));
    // Don't start a drag from the inputs/sliders/buttons
    li.querySelectorAll("input, button").forEach(el => {
      el.addEventListener("mousedown", ev => ev.stopPropagation());
      el.addEventListener("dragstart", ev => ev.preventDefault());
    });

    addDragHandlers(li);
    list.appendChild(li);

    if (t.duration == null) enqueueProbe(t);
  });

  updateSummary();
  document.getElementById("empty-state").classList.toggle("hidden", tracks.length > 0);
}

function updateSummary() {
  const n = tracks.length;
  let total = 0, unknown = false;
  tracks.forEach(t => {
    const len = clipLength(t);
    if (len == null) unknown = true; else total += len;
  });
  const totalStr = n && total > 0 ? ` · ${unknown ? "≥" : ""}${formatTime(total)}` : "";
  document.getElementById("track-count").textContent = n ? `· ${n} track${n === 1 ? "" : "s"}${totalStr}` : "";
}

// Dual-handle trim slider: visible once the video's duration has been probed.
function setupSlider(li, t) {
  const wrap = li.querySelector(".track-slider");
  if (t.duration == null) { wrap.hidden = true; return; }
  wrap.hidden = false;

  const dur = t.duration;
  const rs = li.querySelector(".range-start");
  const re = li.querySelector(".range-end");
  const fill = li.querySelector(".slider-fill");
  rs.max = dur;
  re.max = dur;
  rs.value = Math.min(t.start || 0, dur);
  re.value = t.end != null ? t.end : dur;

  const sync = () => {
    const s = +rs.value, e = +re.value;
    fill.style.left = `${(s / dur) * 100}%`;
    fill.style.width = `${((e - s) / dur) * 100}%`;
    li.querySelector(".edit-start").value = formatTime(s);
    li.querySelector(".edit-end").value = e >= dur ? "" : formatTime(e);
    li.querySelector(".track-duration").textContent = `· ${formatTime(e - s)} clip`;
  };
  sync();

  rs.addEventListener("input", () => {
    if (+rs.value > +re.value - 1) rs.value = Math.max(0, +re.value - 1);
    sync();
  });
  re.addEventListener("input", () => {
    if (+re.value < +rs.value + 1) re.value = Math.min(dur, +rs.value + 1);
    sync();
  });
  // Save without re-rendering: a rebuild would destroy the slider mid-drag
  // (and drop focus during keyboard adjustment).
  const commit = () => {
    t.start = +rs.value;
    t.end = +re.value >= dur ? null : +re.value;
    save();
    updateSummary();
  };
  rs.addEventListener("change", commit);
  re.addEventListener("change", commit);
}

function moveTrack(from, to) {
  if (to < 0 || to >= tracks.length) return;
  const [t] = tracks.splice(from, 1);
  tracks.splice(to, 0, t);
  if (currentIndex === from) currentIndex = to;
  else if (from < currentIndex && to >= currentIndex) currentIndex--;
  else if (from > currentIndex && to <= currentIndex) currentIndex++;
  save();
  renderPlaylist();
}

function removeTrack(i) {
  tracks.splice(i, 1);
  if (i === currentIndex) currentIndex = -1;
  else if (i < currentIndex) currentIndex--;
  save();
  renderPlaylist();
}

function editTime(i, field, input) {
  const val = parseTimeInput(input.value);
  const t = tracks[i];
  if (Number.isNaN(val)) {
    toast("Couldn't read that time — use m:ss or seconds.");
    input.value = field === "start" ? formatTime(t.start) : (t.end != null ? formatTime(t.end) : "");
    return;
  }
  if (field === "start") t.start = val || 0;
  else t.end = val;
  if (t.duration != null) {
    if (t.start >= t.duration) t.start = 0;
    if (t.end != null && t.end > t.duration) t.end = null;
  }
  if (t.end != null && t.end <= (t.start || 0)) {
    toast("End time must be after start time.");
    t.end = null;
  }
  save();
  renderPlaylist();
}

// ---------------------------------------------------------------------------
// Drag & drop reordering
// ---------------------------------------------------------------------------

let dragUid = null;

function addDragHandlers(li) {
  li.addEventListener("dragstart", (e) => {
    dragUid = li.dataset.uid;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    dragUid = null;
    li.classList.remove("dragging");
    document.querySelectorAll(".track.drag-over").forEach(el => el.classList.remove("drag-over"));
  });
  li.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (li.dataset.uid !== dragUid) li.classList.add("drag-over");
  });
  li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
  li.addEventListener("drop", (e) => {
    e.preventDefault();
    li.classList.remove("drag-over");
    if (!dragUid || li.dataset.uid === dragUid) return;
    const from = tracks.findIndex(t => t.uid === dragUid);
    const to = tracks.findIndex(t => t.uid === li.dataset.uid);
    if (from !== -1 && to !== -1) moveTrack(from, to);
  });
}

// ---------------------------------------------------------------------------
// Export (MP3 / MP4)
//
// A browser page can't pull media streams out of YouTube (CORS + signed
// URLs), so export produces a ready-to-run bash script that uses yt-dlp +
// ffmpeg to download each clip at its exact timestamps and stitch them into
// a single mixtape file on the user's machine.
// ---------------------------------------------------------------------------

function sectionArg(t) {
  const start = t.start || 0;
  if (start === 0 && t.end == null) return "";
  const end = t.end != null ? t.end : "inf";
  return ` --download-sections "*${start}-${end}" --force-keyframes-at-cuts`;
}

function buildExportScript(kind) {
  const isMp3 = kind === "mp3";
  const lines = [
    "#!/usr/bin/env bash",
    `# MixTape Maker export — builds mixtape.${kind} from your tracklist.`,
    "# Requires yt-dlp (https://github.com/yt-dlp/yt-dlp) and ffmpeg.",
    "# Only download content you own or have permission to use.",
    "set -euo pipefail",
    "command -v yt-dlp >/dev/null || { echo 'yt-dlp is not installed'; exit 1; }",
    "command -v ffmpeg >/dev/null || { echo 'ffmpeg is not installed'; exit 1; }",
    "",
    'mkdir -p mixtape_clips',
    "",
  ];

  tracks.forEach((t, i) => {
    const n = String(i + 1).padStart(2, "0");
    lines.push(`# ${i + 1}. ${t.title.replace(/[\r\n]/g, " ")} (${formatTime(t.start)}${t.end != null ? "–" + formatTime(t.end) : "–end"})`);
    if (isMp3) {
      lines.push(`yt-dlp -x --audio-format mp3 --audio-quality 0${sectionArg(t)} -o "mixtape_clips/${n}.%(ext)s" "https://www.youtube.com/watch?v=${t.videoId}"`);
    } else {
      lines.push(`yt-dlp -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"${sectionArg(t)} -o "mixtape_clips/${n}.%(ext)s" "https://www.youtube.com/watch?v=${t.videoId}"`);
    }
    lines.push("");
  });

  lines.push('echo "Stitching clips into one file..."');
  if (isMp3) {
    lines.push("ls mixtape_clips/*.mp3 | sort | sed \"s/.*/file '&'/\" > mixtape_concat.txt");
    lines.push("ffmpeg -y -f concat -safe 0 -i mixtape_concat.txt -c:a libmp3lame -b:a 192k mixtape.mp3");
    lines.push('echo "Done → mixtape.mp3 (individual clips are in mixtape_clips/)"');
  } else {
    lines.push("# Normalize every clip to the same size/fps/codecs so they concatenate cleanly");
    lines.push("i=0");
    lines.push("for f in $(ls mixtape_clips/*.mp4 | sort); do");
    lines.push("  i=$((i+1))");
    lines.push('  ffmpeg -y -i "$f" -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30" \\');
    lines.push('    -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 192k -ar 44100 "mixtape_clips/norm_$(printf %02d $i).mp4"');
    lines.push("done");
    lines.push("ls mixtape_clips/norm_*.mp4 | sed \"s/.*/file '&'/\" > mixtape_concat.txt");
    lines.push("ffmpeg -y -f concat -safe 0 -i mixtape_concat.txt -c copy mixtape.mp4");
    lines.push('echo "Done → mixtape.mp4 (individual clips are in mixtape_clips/)"');
  }
  lines.push("");
  return lines.join("\n");
}

function downloadText(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportMixtape(kind) {
  if (!tracks.length) { toast("Add some tracks first!"); return; }
  downloadText(`make-mixtape-${kind}.sh`, buildExportScript(kind));
  toast(`Script downloaded — run it with yt-dlp + ffmpeg installed to build mixtape.${kind}.`);
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function showAddError(msg) {
  const el = document.getElementById("add-error");
  el.textContent = msg;
  el.hidden = !msg;
}

let toastTimer = null;
function toast(msg) {
  document.querySelectorAll(".toast").forEach(el => el.remove());
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3500);
}

document.getElementById("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  showAddError("");

  const urlInput = document.getElementById("input-url");
  const startInput = document.getElementById("input-start");
  const endInput = document.getElementById("input-end");

  const parsed = parseYouTubeUrl(urlInput.value);
  if (!parsed) {
    showAddError("That doesn't look like a YouTube link. Try a URL like https://youtu.be/dQw4w9WgXcQ");
    return;
  }

  let start = parseTimeInput(startInput.value);
  const end = parseTimeInput(endInput.value);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    showAddError("Times should look like 1:30, 0:02:15 or plain seconds.");
    return;
  }
  if (start == null && parsed.start != null) start = parsed.start; // ?t= from the URL
  if (end != null && end <= (start || 0)) {
    showAddError("End time must be after the start time.");
    return;
  }

  const track = makeTrack(parsed.videoId, start || 0, end);
  tracks.push(track);
  save();
  renderPlaylist();
  fetchTitle(track);

  urlInput.value = "";
  startInput.value = "";
  endInput.value = "";
  urlInput.focus();
});

document.getElementById("btn-play").addEventListener("click", togglePlay);
document.getElementById("btn-next").addEventListener("click", next);
document.getElementById("btn-prev").addEventListener("click", prev);
document.getElementById("btn-export-mp3").addEventListener("click", () => exportMixtape("mp3"));
document.getElementById("btn-export-mp4").addEventListener("click", () => exportMixtape("mp4"));

document.getElementById("btn-clear").addEventListener("click", () => {
  if (tracks.length && !confirm("Remove all tracks from this mixtape?")) return;
  tracks = [];
  currentIndex = -1;
  save();
  renderPlaylist();
});

document.getElementById("btn-share").addEventListener("click", async () => {
  if (!tracks.length) { toast("Add some tracks first!"); return; }
  const url = location.origin + location.pathname + buildShareHash();
  try {
    await navigator.clipboard.writeText(url);
    toast("Share link copied to clipboard!");
  } catch {
    prompt("Copy this mixtape link:", url);
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

load();
renderPlaylist();
tracks.forEach(t => { if (t.title.startsWith("YouTube video (")) fetchTitle(t); });

const tag = document.createElement("script");
tag.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(tag);
