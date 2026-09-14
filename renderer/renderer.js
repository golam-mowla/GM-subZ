import WaveSurfer from "./lib/wavesurfer.esm.js";
import RegionsPlugin from "./lib/regions.esm.js";

const videoEl = document.getElementById("videoEl");
const videoPlaceholder = document.getElementById("videoPlaceholder");
const captionOverlay = document.getElementById("captionOverlay");
const loadVideoBtn = document.getElementById("loadVideoBtn");
const openSrtBtn = document.getElementById("openSrtBtn");
const transcribeBtn = document.getElementById("transcribeBtn");
const exportBtn = document.getElementById("exportBtn");
const rechunkBtn = document.getElementById("rechunkBtn");
const undoBtn = document.getElementById("undoBtn");
const redoBtn = document.getElementById("redoBtn");
const statusText = document.getElementById("statusText");
const progressFill = document.getElementById("progressFill");
const captionListEl = document.getElementById("captionList");
const captionCountEl = document.getElementById("captionCount");
const addCaptionBtn = document.getElementById("addCaptionBtn");
const splitCaptionBtn = document.getElementById("splitCaptionBtn");
const mergeCaptionBtn = document.getElementById("mergeCaptionBtn");
const findBox = document.getElementById("findBox");
const replaceBox = document.getElementById("replaceBox");
const replaceAllBtn = document.getElementById("replaceAllBtn");
const shiftAllBox = document.getElementById("shiftAllBox");
const shiftAllBtn = document.getElementById("shiftAllBtn");

let videoPath = null;
let rawWordCues = [];   // raw word-level timing straight from whisper, never mutated by dragging
let captions = [];      // the editable, chunked/regrouped set the user sees and drags
let ws = null;
let regionsPlugin = null;
let suppressRegionSync = false;
let selectedIdx = -1;

// ---------- UNDO/REDO ----------
const undoStack = [];
const redoStack = [];
function snapshotForUndo() {
  undoStack.push(JSON.stringify(captions.map(({ start, end, text }) => ({ start, end, text }))));
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  updateUndoRedoButtons();
}
function restoreSnapshot(json) {
  const restored = JSON.parse(json);
  captions = restored.map((c) => ({ ...c }));
  rebuildRegions();
  renderCaptionList();
}
undoBtn.onclick = () => {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(captions.map(({ start, end, text }) => ({ start, end, text }))));
  restoreSnapshot(undoStack.pop());
  updateUndoRedoButtons();
};
redoBtn.onclick = () => {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(captions.map(({ start, end, text }) => ({ start, end, text }))));
  restoreSnapshot(redoStack.pop());
  updateUndoRedoButtons();
};
function updateUndoRedoButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "z") { e.preventDefault(); undoBtn.click(); }
  if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); redoBtn.click(); }
});

function setStatus(msg, pct) {
  statusText.textContent = msg || "";
  if (pct !== undefined) progressFill.style.width = pct + "%";
}

// ---------- PREFS ----------
function linkSliderAndBox(sliderId, boxId) {
  const slider = document.getElementById(sliderId);
  const box = document.getElementById(boxId);
  slider.addEventListener("input", () => (box.value = slider.value));
  box.addEventListener("input", () => (slider.value = box.value));
}
linkSliderAndBox("maxCharsSlider", "maxCharsBox");
linkSliderAndBox("minDurSlider", "minDurBox");
linkSliderAndBox("gapSlider", "gapBox");
linkSliderAndBox("offsetSlider", "offsetBox");

function getPrefs() {
  return {
    format: document.getElementById("formatSelect").value,
    lines: document.querySelector('input[name="lines"]:checked').value,
    wordByWord: document.getElementById("wordByWordToggle").checked,
    maxChars: +document.getElementById("maxCharsBox").value,
    minDuration: +document.getElementById("minDurBox").value,
    gapFrames: +document.getElementById("gapBox").value,
    offsetFrames: +document.getElementById("offsetBox").value,
    frameRate: +document.getElementById("frameRateInput").value || 60
  };
}

// ---------- SRT PARSE / SERIALIZE ----------
function parseSrt(srtText) {
  const blocks = srtText.replace(/\r/g, "").trim().split(/\n\n+/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(" ").trim();
    cues.push({ start: srtTimeToSeconds(startStr), end: srtTimeToSeconds(endStr), text });
  }
  return cues;
}
function srtTimeToSeconds(t) {
  const [h, m, rest] = t.split(":");
  const [s, ms] = rest.split(",");
  return (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
}
function secondsToSrtTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
// Short mm:ss.mmm form for the compact per-row time inputs
function secondsToShort(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(2);
  return `${String(m).padStart(2, "0")}:${s.padStart(5, "0")}`;
}
function shortToSeconds(str) {
  const parts = str.trim().split(":");
  if (parts.length === 2) return (+parts[0]) * 60 + parseFloat(parts[1]);
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}
function cuesToSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${secondsToSrtTime(c.start)} --> ${secondsToSrtTime(c.end)}\n${c.text}\n`).join("\n");
}

// ---------- CHUNKING (same semantics as the Premiere panel) ----------
function rechunkCues(cues, prefs) {
  if (prefs.wordByWord) {
    return applyMinDurationAndGap(
      cues.filter((c) => c.text.trim()).map((c) => ({ start: c.start, end: c.end, text: c.text.trim() })),
      prefs
    );
  }
  const out = [];
  let buffer = "", bufStart = null, bufEnd = null;
  const flush = () => {
    if (!buffer) return;
    out.push({ start: bufStart, end: bufEnd, text: buffer.trim() });
    buffer = ""; bufStart = null; bufEnd = null;
  };
  for (const cue of cues) {
    const word = cue.text.trim();
    if (!word) continue;
    const candidate = buffer ? buffer + " " + word : word;
    if (buffer && candidate.length > prefs.maxChars) {
      flush();
      buffer = word; bufStart = cue.start; bufEnd = cue.end;
    } else {
      if (!buffer) bufStart = cue.start;
      buffer = candidate; bufEnd = cue.end;
    }
  }
  flush();
  return applyMinDurationAndGap(out, prefs);
}
function applyMinDurationAndGap(cards, prefs) {
  const gapSeconds = (prefs.gapFrames || 0) / (prefs.frameRate || 30);
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    const minEnd = card.start + (prefs.minDuration || 0);
    if (card.end < minEnd) card.end = minEnd;
    const next = cards[i + 1];
    if (next && card.end + gapSeconds > next.start) {
      card.end = Math.max(card.start + 0.1, next.start - gapSeconds);
    }
  }
  return cards;
}
function wrapTwoLines(text, halfLen) {
  if (text.length <= halfLen) return text;
  let splitAt = text.lastIndexOf(" ", halfLen);
  if (splitAt === -1) splitAt = halfLen;
  return text.slice(0, splitAt) + "\n" + text.slice(splitAt + 1);
}
function roundToFrame(seconds, frameRate) {
  return Math.round(seconds * frameRate) / frameRate;
}

function applyOffsetAndRounding(cues, prefs) {
  const offsetSeconds = (prefs.offsetFrames || 0) / prefs.frameRate;
  return cues.map((c) => ({
    ...c,
    start: roundToFrame(Math.max(0, c.start + offsetSeconds), prefs.frameRate),
    end: roundToFrame(Math.max(0, c.end + offsetSeconds), prefs.frameRate)
  }));
}

// ---------- LOAD VIDEO ----------
loadVideoBtn.onclick = async () => {
  const p = await window.gmAPI.pickVideo();
  if (!p) return;
  videoPath = p;
  const url = await window.gmAPI.getVideoUrl(p);
  videoEl.src = url;
  videoPlaceholder.style.display = "none";

  if (ws) { ws.destroy(); }
  regionsPlugin = RegionsPlugin.create();
  ws = WaveSurfer.create({
    container: "#waveform",
    waveColor: "#8b8578",
    progressColor: "#c15f3c",
    cursorColor: "#7a8f6e",
    height: 80,
    media: videoEl,
    plugins: [regionsPlugin]
  });

  regionsPlugin.on("region-updated", (region) => {
    if (suppressRegionSync) return;
    const idx = captions.findIndex((c) => c._regionId === region.id);
    if (idx === -1) return;
    captions[idx].start = region.start;
    captions[idx].end = region.end;
    renderCaptionList();
  });

  transcribeBtn.disabled = false;
  setStatus("Video loaded: " + p.split(/[\\/]/).pop());
};

// ---------- OPEN EXISTING SRT ----------
openSrtBtn.onclick = async () => {
  const result = await window.gmAPI.openSrt();
  if (!result) return;
  snapshotForUndo();
  rawWordCues = parseSrt(result);
  captions = parseSrt(result);
  exportBtn.disabled = false;
  rebuildRegions();
  renderCaptionList();
  setStatus(`Loaded ${captions.length} captions from SRT.`);
};

// ---------- TRANSCRIBE ----------
window.gmAPI.onWhisperProgress((pct) => setStatus(`Transcribing... ${pct}%`, pct));
window.gmAPI.onModelDownloadStatus(({ modelKey, status, progress }) => {
  if (status === "downloading") {
    setStatus(`Downloading ${modelKey} model (first use only)... ${progress}%`, progress);
  } else if (status === "error") {
    setStatus(`Failed to download ${modelKey} model. Check your internet connection.`);
  }
});

transcribeBtn.onclick = async () => {
  if (!videoPath) return;
  transcribeBtn.disabled = true;
  try {
    setStatus("Extracting audio...", 5);
    const wavPath = await window.gmAPI.extractAudio(videoPath);

    setStatus("Running Whisper...", 10);
    const model = document.getElementById("modelSelect").value;
    const srtText = await window.gmAPI.runWhisper(wavPath, model);

    snapshotForUndo();
    rawWordCues = parseSrt(srtText);
    applySettingsAndRender();
    exportBtn.disabled = false;
    setStatus(`Done - ${captions.length} captions.`, 100);
    setTimeout(() => setStatus(""), 2000);
  } catch (err) {
    setStatus("Error: " + err.message);
    console.error(err);
  } finally {
    transcribeBtn.disabled = false;
  }
};

// ---------- RE-APPLY SETTINGS WITHOUT RE-TRANSCRIBING ----------
rechunkBtn.onclick = () => {
  if (!rawWordCues.length) return setStatus("Transcribe first.");
  snapshotForUndo();
  applySettingsAndRender();
};

function applySettingsAndRender() {
  const prefs = getPrefs();
  let grouped = rechunkCues(rawWordCues, prefs);
  grouped = applyOffsetAndRounding(grouped, prefs);
  if (prefs.lines === "double" && !prefs.wordByWord) {
    grouped.forEach((c) => (c.text = wrapTwoLines(c.text, Math.ceil(prefs.maxChars / 2))));
  }
  captions = grouped;
  rebuildRegions();
  renderCaptionList();
}

// ---------- REGIONS ----------
function rebuildRegions() {
  if (!regionsPlugin) return;
  regionsPlugin.clearRegions();
  captions.forEach((c, i) => {
    const region = regionsPlugin.addRegion({
      start: c.start,
      end: c.end,
      content: c.text.replace(/\n/g, " "),
      color: i % 2 === 0 ? "rgba(193,95,60,0.25)" : "rgba(122,143,110,0.25)",
      drag: true,
      resize: true
    });
    c._regionId = region.id;
  });
}

// ---------- ADD / SPLIT / MERGE ----------
addCaptionBtn.onclick = () => {
  snapshotForUndo();
  const t = videoEl.currentTime || 0;
  const newCap = { start: t, end: t + 1.5, text: "New caption" };
  let insertAt = captions.findIndex((c) => c.start > t);
  if (insertAt === -1) insertAt = captions.length;
  captions.splice(insertAt, 0, newCap);
  rebuildRegions();
  renderCaptionList();
  selectedIdx = insertAt;
};

splitCaptionBtn.onclick = () => {
  if (selectedIdx === -1 || !captions[selectedIdx]) return setStatus("Select a caption row first.");
  const t = videoEl.currentTime;
  const c = captions[selectedIdx];
  if (t <= c.start || t >= c.end) return setStatus("Move the playhead inside the selected caption to split.");
  snapshotForUndo();
  const words = c.text.replace(/\n/g, " ").split(" ");
  const mid = Math.max(1, Math.round(words.length * ((t - c.start) / (c.end - c.start))));
  const firstText = words.slice(0, mid).join(" ");
  const secondText = words.slice(mid).join(" ") || "...";
  const first = { start: c.start, end: t, text: firstText };
  const second = { start: t, end: c.end, text: secondText };
  captions.splice(selectedIdx, 1, first, second);
  rebuildRegions();
  renderCaptionList();
  setStatus("Caption split.");
};

mergeCaptionBtn.onclick = () => {
  if (selectedIdx === -1 || !captions[selectedIdx] || !captions[selectedIdx + 1]) {
    return setStatus("Select a caption that has a next one to merge with.");
  }
  snapshotForUndo();
  const c = captions[selectedIdx];
  const next = captions[selectedIdx + 1];
  c.end = next.end;
  c.text = (c.text.replace(/\n/g, " ") + " " + next.text.replace(/\n/g, " ")).trim();
  captions.splice(selectedIdx + 1, 1);
  rebuildRegions();
  renderCaptionList();
  setStatus("Captions merged.");
};

// ---------- FIND & REPLACE ----------
replaceAllBtn.onclick = () => {
  const find = findBox.value;
  if (!find) return;
  const replace = replaceBox.value;
  snapshotForUndo();
  let count = 0;
  captions.forEach((c) => {
    if (c.text.includes(find)) {
      c.text = c.text.split(find).join(replace);
      count++;
    }
  });
  rebuildRegions();
  renderCaptionList();
  setStatus(`Replaced in ${count} caption(s).`);
};

// ---------- BULK SHIFT ----------
shiftAllBtn.onclick = () => {
  const shift = parseFloat(shiftAllBox.value);
  if (!shift || !captions.length) return;
  snapshotForUndo();
  captions.forEach((c) => {
    c.start = Math.max(0, c.start + shift);
    c.end = Math.max(0, c.end + shift);
  });
  rebuildRegions();
  renderCaptionList();
  setStatus(`Shifted all captions by ${shift > 0 ? "+" : ""}${shift}s.`);
};

// ---------- CAPTION LIST ----------
function renderCaptionList() {
  captionCountEl.textContent = captions.length ? `${captions.length} caption${captions.length === 1 ? "" : "s"}` : "";
  captionListEl.innerHTML = "";
  if (!captions.length) {
    captionListEl.innerHTML = '<div id="emptyListMsg">No captions yet. Transcribe a video or open an SRT file.</div>';
    return;
  }
  captions.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "capRow" + (i === selectedIdx ? " active" : "");
    const overLimit = c.text.replace(/\n/g, " ").length > 42;
    row.innerHTML = `
      <span class="idx">${i + 1}</span>
      <input class="timeIn" type="text" value="${secondsToShort(c.start)}" title="Start time">
      <input class="timeOut" type="text" value="${secondsToShort(c.end)}" title="End time">
      <input class="text${overLimit ? " charWarn" : ""}" type="text" value="${c.text.replace(/\n/g, " ").replace(/"/g, "&quot;")}">
      <button class="del" title="Delete caption">✕</button>
    `;
    row.querySelector(".text").addEventListener("focus", () => { selectedIdx = i; highlightRow(); });
    row.querySelector(".text").addEventListener("input", (e) => {
      const overNow = e.target.value.length > 42;
      e.target.classList.toggle("charWarn", overNow);
      captions[i].text = e.target.value;
      if (regionsPlugin) {
        const region = regionsPlugin.getRegions().find((r) => r.id === c._regionId);
        if (region) region.setContent(e.target.value);
      }
    });
    row.querySelector(".text").addEventListener("blur", () => snapshotForUndo());

    row.querySelector(".timeIn").addEventListener("change", (e) => {
      const val = shortToSeconds(e.target.value);
      if (val === null) { e.target.value = secondsToShort(c.start); return; }
      snapshotForUndo();
      captions[i].start = Math.max(0, val);
      rebuildRegions();
      renderCaptionList();
    });
    row.querySelector(".timeOut").addEventListener("change", (e) => {
      const val = shortToSeconds(e.target.value);
      if (val === null) { e.target.value = secondsToShort(c.end); return; }
      snapshotForUndo();
      captions[i].end = Math.max(captions[i].start + 0.05, val);
      rebuildRegions();
      renderCaptionList();
    });

    row.querySelector(".del").addEventListener("click", () => {
      snapshotForUndo();
      captions.splice(i, 1);
      selectedIdx = -1;
      rebuildRegions();
      renderCaptionList();
    });
    row.addEventListener("click", (e) => {
      selectedIdx = i;
      if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
      videoEl.currentTime = c.start;
      highlightRow();
    });
    captionListEl.appendChild(row);
  });
}
function highlightRow() {
  captionListEl.querySelectorAll(".capRow").forEach((row, i) => row.classList.toggle("active", i === selectedIdx));
}

// ---------- LIVE PREVIEW OVERLAY ----------
videoEl.addEventListener("timeupdate", () => {
  const t = videoEl.currentTime;
  const active = captions.find((c) => t >= c.start && t < c.end);
  captionOverlay.textContent = active ? active.text : "";
  captionListEl.querySelectorAll(".capRow").forEach((row, i) => {
    if (captions[i] === active && i !== selectedIdx) row.classList.add("active");
    else if (i !== selectedIdx) row.classList.remove("active");
  });
});

// ---------- EXPORT ----------
exportBtn.onclick = async () => {
  if (!captions.length) return;
  const srt = cuesToSrt(captions);
  const suggested = (videoPath ? videoPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, "") : "captions") + "_captions.srt";
  const savedPath = await window.gmAPI.saveSrt(srt, suggested);
  if (savedPath) setStatus("Saved: " + savedPath);
};
