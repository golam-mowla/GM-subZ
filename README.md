# GM SubEdit (v1 scaffold)

Standalone caption editor - the "Subtitle Edit"-style tool you asked for. Load
any video, transcribe with local Whisper, see captions rendered live over the
video as it plays, drag the waveform regions to retime individual captions,
edit text inline, then export a clean SRT to import into Premiere the normal
way (File > Import).

## What's here

- Video player with a live caption overlay (real preview, not just numbers)
- Waveform (wavesurfer.js) with one draggable region per caption - drag the
  edges to adjust timing by ear/eye
- Same settings as the Premiere panel: model, format, lines, max chars, min
  duration, gap, timing offset, word-by-word mode
- **"Re-apply settings to existing words" button** - tweak any preference and
  regroup instantly without re-transcribing. This is the fast-iteration loop
  the Premiere panel couldn't give you (every settings change there meant a
  full re-run).
- Frame rate field - set this to match whatever sequence you're targeting in
  Premiere (24/30/60fps etc.) since this app has no direct link to Premiere
  and can't read it automatically.

## Setup

1. **Install Node.js** if you don't have it (nodejs.org, LTS version).
2. Open a terminal in this folder, run:
   ```
   npm install
   ```
3. To just run it locally without building an installer:
   ```
   npm start
   ```
   (This works even before the GitHub Actions build, but whisper/ffmpeg won't
   be there yet - you'll only be able to load a video and scrub the waveform,
   not transcribe, until host_bin/ is populated - see step 4.)

4. **Get whisper-cli.exe + ffmpeg.exe + models**: push this folder to a new
   GitHub repo (separate from GM_Captions, or a subfolder - your call), add
   `.github/workflows/build-subedit.yml` via GitHub's web UI using the
   contents of `build-subedit.yml` here, run it from the Actions tab. It
   builds everything AND packages a full Windows installer in one go this
   time (no manual file-copying between folders needed - it all bundles into
   the app automatically).

5. Download the `gm-subedit-installer` artifact, run the `.exe` inside it to
   install GM SubEdit like any normal Windows app.

## Workflow

1. Load Video → pick any mp4/mov/etc.
2. Set Frame rate to match your target Premiere sequence.
3. Pick a Whisper model, hit Transcribe.
4. Watch the video with live captions - drag waveform regions if timing's
   off, or use the timing offset slider + "Re-apply settings" for a global
   nudge instead of dragging each one by hand.
5. Edit any caption's text directly in the list on the right side of the
   waveform.
6. Export SRT, then in Premiere: File > Import that .srt, drag onto a new
   caption track (or use your GM Captions panel's import step if you'd
   rather keep it in that same pipeline).

## Known first-test items

- Regions plugin + `media:` binding to an existing `<video>` element is a
  slightly less common wavesurfer.js setup than the usual "load its own
  audio" mode - confirm dragging a region actually updates that caption's
  timing correctly and the video doesn't fight the waveform for playback
  control on first run.
- ES module imports (`type="module"`) loading local files under Electron's
  `file://` protocol can occasionally need `webSecurity` tweaks depending on
  Electron version - if the waveform doesn't render at all, check the
  DevTools console (Ctrl+Shift+I) for module loading errors first.
