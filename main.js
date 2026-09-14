const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const isDev = !app.isPackaged;
const HOST_BIN = isDev
  ? path.join(__dirname, "host_bin")
  : path.join(process.resourcesPath, "host_bin");

const WHISPER_BIN = path.join(HOST_BIN, "whisper-cli.exe");
const FFMPEG_BIN = path.join(HOST_BIN, "ffmpeg.exe");
const MODEL_DIR = path.join(HOST_BIN, "models");
const TEMP_DIR = path.join(os.tmpdir(), "gm_subedit");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#1e1e1e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ---------- FILE DIALOGS ----------
ipcMain.handle("pick-video", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Video/Audio", extensions: ["mp4", "mov", "mkv", "avi", "wav", "mp3"] }]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("save-srt", async (event, srtContent, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || "captions.srt",
    filters: [{ name: "SubRip Subtitle", extensions: ["srt"] }]
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, srtContent, "utf8");
  return result.filePath;
});

// ---------- FFMPEG: EXTRACT AUDIO FOR WHISPER + GENERATE WAVEFORM PEAKS ----------
ipcMain.handle("extract-audio", async (event, videoPath) => {
  return new Promise((resolve, reject) => {
    const outWav = path.join(TEMP_DIR, "extracted.wav");
    const proc = spawn(FFMPEG_BIN, ["-y", "-i", videoPath, "-ar", "16000", "-ac", "1", "-vn", outWav]);
    let stderrBuf = "";
    proc.stderr.on("data", (d) => (stderrBuf += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("ffmpeg failed: " + stderrBuf.slice(-500)));
      resolve(outWav);
    });
    proc.on("error", reject);
  });
});

// ---------- WHISPER TRANSCRIPTION ----------
ipcMain.handle("run-whisper", async (event, wavPath, modelKey) => {
  return new Promise((resolve, reject) => {
    const modelFile = {
      "tiny.en": "ggml-tiny.en.bin",
      "base.en": "ggml-base.en.bin",
      "small.en": "ggml-small.en.bin",
      "medium.en": "ggml-medium.en.bin",
      "large-v3-q5": "ggml-large-v3-q5_k.bin"
    }[modelKey];
    const modelPath = path.join(MODEL_DIR, modelFile);
    if (!fs.existsSync(modelPath)) return reject(new Error("Model not found: " + modelFile));
    if (!fs.existsSync(WHISPER_BIN)) return reject(new Error("whisper-cli.exe not found"));

    const outBase = path.join(TEMP_DIR, "out");
    const proc = spawn(WHISPER_BIN, ["-m", modelPath, "-f", wavPath, "-osrt", "-of", outBase, "-l", "en", "-ml", "1", "-sow"]);
    let stderrBuf = "";
    proc.stderr.on("data", (d) => {
      stderrBuf += d.toString();
      const match = stderrBuf.match(/progress\s*=\s*(\d+)%/i);
      if (match) mainWindow.webContents.send("whisper-progress", +match[1]);
    });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("whisper-cli failed: " + stderrBuf.slice(-800)));
      const srtPath = outBase + ".srt";
      if (!fs.existsSync(srtPath)) return reject(new Error("No SRT produced"));
      resolve(fs.readFileSync(srtPath, "utf8"));
    });
    proc.on("error", reject);
  });
});

ipcMain.handle("get-video-path-url", (event, videoPath) => {
  return "file:///" + videoPath.replace(/\\/g, "/");
});
