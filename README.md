# Zotero Voice Annotator

Turn spoken words into PDF highlights — from pre-recorded audio files or straight from your microphone while you read.

## What it does

Zotero Voice Annotator gives you two equally powerful ways to annotate your PDFs with your voice. Both run entirely on your machine, use the same underlying pipeline, and produce the same result: colored highlight annotations on the exact sentence you read aloud, with your spoken commentary attached as a note.

- **Audio recordings** — transcribe audio attachments (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`) and turn every spoken quote into highlights.
- **Live voice annotation** — dictate directly inside the PDF reader and watch highlights appear as you talk.

In both modes you define trigger phrases, each mapped to a highlight color. For example:

- `Highlight` → yellow
- `Main Theory` → blue
- `Key Point` → red
- `Definition` → green

## Installation

1. Install the Python dependencies:
   ```bash
   pip install faster-whisper pymupdf sounddevice
   ```

2. Download the latest `zotero-voice-annotator.xpi` from the [releases page](https://github.com/alexanderjfink/zotero-voice-annotator/releases).

3. In Zotero, go to **Tools → Plugins**.

4. Click the gear icon and choose **Install Plugin From File...**.

5. Select `zotero-voice-annotator.xpi`.

6. Restart Zotero when prompted.

## Usage

### Annotating audio recordings

The classic workflow: record or collect audio of yourself (or anyone) reading, attach it to a Zotero item, and let the plugin do the rest.

1. Attach an audio file (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`) to a Zotero item that also has a PDF attachment.

2. In the Zotero items pane, right-click the audio attachment.

3. Choose **Zotero Voice Annotator → Transcribe and Annotate** to process the selected audio, or **Transcribe and Annotate All Audio** to process every audio attachment on the parent item.

4. The plugin will:
   - Transcribe the audio locally, capturing word-level timestamps.
   - Detect each time you say a configured trigger phrase.
   - Try to match the next 4-6 words against the PDF text, with tolerance for hyphenation differences.
   - Expand the match to the full sentence in the PDF.
   - Create a highlight annotation on that sentence using the trigger's color.
   - Attach everything you said after the matched words as a note on the annotation.
   - End the current annotation if a long silence (longer than the configured timeout) is detected.

### Annotating live in the PDF reader

The live workflow: read your PDF and speak, with no pre-recorded file needed. Highlights are created as you go.

1. Open a PDF in Zotero's built-in reader.

2. Press the configured shortcut (**⌘/Ctrl+Shift+V** by default) or click the 🎙 button in the reader toolbar.

3. Speak a trigger phrase, pause briefly, and continue with the quote and commentary — highlights appear as you talk.

**Recording modes** (set in Preferences → Voice Annotator):

- **Toggle**: press the shortcut once to start, again to stop.
- **Push-to-talk**: hold the shortcut while speaking, release to stop.
- **Voice-activated**: press to start; annotations are created automatically on silence gaps.

While live annotation is active, a trigger word overlay appears in the top-right corner of the PDF (just below the reader toolbar). It shows the configured trigger phrases with their colors and the current status (Listening / Processing). It can be dragged, minimized, or disabled in preferences; it is hidden whenever live annotation is not running.

Note: live mode requires microphone access for the Python process. On macOS you may need to grant microphone permission to Zotero (or the terminal running Python) under System Settings → Privacy & Security → Microphone.

### How trigger phrases work

Both modes share the same trigger logic. A trigger phrase is only treated as a keyword when the words immediately after it match text in the PDF. If you say a trigger phrase in passing and the following words don't match anything, it is ignored. This lets you talk naturally without every casual use of the word creating an annotation.

Multi-word triggers such as "Main Theory" or "Key Point" are supported.

### Example

The same interaction works identically in both modes. If you say:

> "Main Theory the EU has adopted a comprehensive regulatory framework and I'm thinking about how this will affect member states."

And the PDF contains the sentence:

> "The EU has adopted a comprehensive regulatory framework."

Zotero Voice Annotator will:
- Highlight that full sentence in **blue**.
- Attach a note reading: "and I'm thinking about how this will affect member states."

## Configuration

Open **Zotero Preferences → Voice Annotator** to change:

- **Trigger Words &amp; Colors**: add, remove, or edit trigger phrases and assign each a highlight color. Defaults are `Highlight` (yellow), `Main Theory` (blue), `Key Point` (red), and `Definition` (green). These apply to both audio and live modes.
- **Whisper Model**: transcription model size (`tiny`, `base`, `small`, `medium`, `large`); larger is more accurate but slower. Used by both modes.
- **Silence Timeout**: maximum silence gap (in seconds) before a spoken annotation commentary is cut off. Used by both modes.
- **Recording Mode**: how live annotation captures your voice (`Toggle`, `Push-to-talk`, `Voice-activated`).
- **Keyboard Shortcut**: the key combination that starts/stops live annotation (click the field, then press the keys you want).
- **Live Transcription Interval**: how often (in seconds) live audio is transcribed in the reader.
- **Show Trigger Word Overlay**: show/hide the trigger + status overlay in the PDF reader during live annotation.
- **Python Path**: path to the Python interpreter if Zotero doesn't use the right one.
- **Log Level**: how much detail to write to the Zotero debug log.

## Building from source

```bash
cd zotero-voice-annotator
./build.sh
```

The output is `zotero-voice-annotator-1.1.0.xpi` in the project root.

## License

MIT