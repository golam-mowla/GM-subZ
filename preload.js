const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gmAPI", {
  pickVideo: () => ipcRenderer.invoke("pick-video"),
  saveSrt: (content, name) => ipcRenderer.invoke("save-srt", content, name),
  extractAudio: (videoPath) => ipcRenderer.invoke("extract-audio", videoPath),
  runWhisper: (wavPath, model) => ipcRenderer.invoke("run-whisper", wavPath, model),
  getVideoUrl: (videoPath) => ipcRenderer.invoke("get-video-path-url", videoPath),
  onWhisperProgress: (cb) => ipcRenderer.on("whisper-progress", (e, pct) => cb(pct))
});
