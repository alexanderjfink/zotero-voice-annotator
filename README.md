# Zotero Voice Annotator

A Zotero plugin that transcribes audio recordings and turns spoken quotes into PDF highlight annotations.

## What it does

Zotero Voice Annotator listens to audio attachments in your Zotero library, transcribes them locally with OpenAI Whisper (via `faster-whisper`), and looks for spoken quotes triggered by a keyword or phrase. When it finds text in the attached PDF that matches what you said, it creates a colored highlight annotation on the exact sentence and attaches your remaining spoken commentary as an annotation note.

You can define multiple trigger phrases, each with its own highlight color. For example:

- `quote` → yellow
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

### Example

If you say:

> "Main Theory the EU has adopted a comprehensive regulatory framework and I'm thinking about how this will affect member states."

And the PDF contains the sentence:

> "The EU has adopted a comprehensive regulatory framework."

Zotero Voice Annotator will:
- Highlight that full sentence in **blue**.
- Attach a note reading: "and I'm thinking about how this will affect member states."

### Trigger phrase behavior

A trigger phrase is only treated as a keyword when the words immediately after it match text in the PDF. If you say a trigger phrase in passing and the following words don't match anything, it is ignored. This lets you talk naturally without every casual use of the word creating an annotation.

Multi-word triggers such as "Main Theory" or "Key Point" are supported.

## Configuration

Open **Zotero Preferences → Zotero Voice Annotator** to change:

- **Trigger Words &amp; Colors**: add, remove, or edit trigger phrases and assign each a highlight color. Defaults are `quote` (yellow), `Main Theory` (blue), `Key Point` (red), and `Definition` (green).
- **Silence Timeout**: maximum silence gap (in seconds) before a spoken annotation commentary is cut off. Requires Python transcription mode with word timestamps.
- **Whisper Model**: transcription model size (`tiny`, `base`, `small`, `medium`, `large`); larger is more accurate but slower.
- **Python Path**: path to the Python interpreter if Zotero doesn't use the right one.
- **Log Level**: how much detail to write to the Zotero debug log.

### Live Voice Annotation

Live annotation lets you dictate highlights directly into the PDF reader:

1. Open a PDF in Zotero's built-in reader.
2. Press the configured shortcut (**⌘/Ctrl+Shift+V** by default) or click the 🎙 button in the reader toolbar.
3. Speak a trigger phrase, pause briefly, and continue with the quote and commentary — highlights appear as you talk.

**Recording modes** (set in Preferences → Zotero Voice Annotator):

- **Toggle**: press the shortcut once to start, again to stop.
- **Push-to-talk**: hold the shortcut while speaking, release to stop.
- **Voice-activated**: press to start; annotations are created automatically on silence gaps.

While live annotation is active, a trigger word overlay appears in the top-right corner of the PDF (just below the reader toolbar). It shows the configured trigger phrases with their colors and the current status (Listening / Processing). It can be dragged, minimized, or disabled in preferences; it is hidden whenever live annotation is not running.

Note: live mode requires microphone access for the Python process. On macOS you may need to grant microphone permission to Zotero (or the terminal running Python) under System Settings → Privacy & Security → Microphone.

## Building from source

```bash
cd zotero-voice-annotator
./build.sh
```

The output is `zotero-voice-annotator-1.1.0.xpi` in the project root.

## License

MIT
