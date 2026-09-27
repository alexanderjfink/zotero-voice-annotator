#!/usr/bin/env python3
"""
Zotero Zotero Voice Annotator Helper Script
Handles audio transcription and PDF text location.

Dependencies:
    pip install faster-whisper pymupdf

Usage:
    zaa-helper.py transcribe --audio <path> --model <size> --output <json_path>
    zaa-helper.py match --pdf <path> --quote <text> --output <json_path> [--page-hint N]
    zaa-helper.py locate --pdf <path> --text <text> --output <json_path> [--page-hint N]
"""

import argparse
import json
import os
import re
import sys
import tempfile
import time


def normalize_word(word):
    """Lowercase and strip punctuation from a word."""
    return re.sub(r"[^\w\-]", "", word).lower()


def transcribe(args):
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        write_output(args.output, {"error": f"faster-whisper not installed: {e}"})
        return

    try:
        model_size = args.model or "base"
        # Determine device
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
            compute_type = "float16" if device == "cuda" else "int8"
        except ImportError:
            device = "cpu"
            compute_type = "int8"

        model = WhisperModel(model_size, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            args.audio,
            beam_size=5,
            word_timestamps=True
        )

        texts = []
        words = []
        for segment in segments:
            texts.append(segment.text.strip())
            segment_words = getattr(segment, "words", None)
            if segment_words:
                for w in segment_words:
                    # Some versions return objects with .word, .start, .end
                    # Others return tuples
                    if isinstance(w, tuple):
                        word_text, start, end = w[0], w[1], w[2]
                    else:
                        word_text, start, end = w.word, w.start, w.end
                    word_text = word_text.strip()
                    clean = normalize_word(word_text)
                    if clean:
                        words.append({
                            "word": word_text,
                            "normalized": clean,
                            "start": round(float(start), 3),
                            "end": round(float(end), 3)
                        })

        # Join segment texts with single spaces and collapse any runs of whitespace
        transcript = re.sub(r"\s+", " ", " ".join(texts)).strip()
        write_output(args.output, {
            "text": transcript,
            "words": words,
            "language": info.language,
            "duration": info.duration,
            "success": True
        })
    except Exception as e:
        write_output(args.output, {"error": str(e), "success": False})


def normalize_word(word):
    """Lowercase and strip punctuation from a word."""
    return re.sub(r"[^\w\-]", "", word).lower()


def words_match(spoken_word, pdf_word):
    """Check if spoken word matches PDF word, allowing hyphenation differences."""
    s = spoken_word.replace("-", "")
    p = pdf_word.replace("-", "")
    return s == p and len(s) > 0


def extract_pdf_words(doc):
    """Extract all words from PDF with page index and bounding boxes.

    PyMuPDF returns rects with top-left origin. Zotero's PDF reader expects
    bottom-left origin (PDF user space), so we convert y coordinates.
    """
    words = []
    for page_num in range(doc.page_count):
        page = doc.load_page(page_num)
        page_height = page.rect.height
        page_words = page.get_text("words")
        for w in page_words:
            # w = (x0, y0, x1, y1, word, block_no, line_no, word_no)
            # PyMuPDF: y increases downward from top-left
            # Convert to bottom-left origin: y' = page_height - y
            x0, y0, x1, y1 = w[0], w[1], w[2], w[3]
            rect = [round(x0, 2), round(page_height - y1, 2), round(x1, 2), round(page_height - y0, 2)]
            words.append({
                "text": w[4],
                "normalized": normalize_word(w[4]),
                "page": page_num,
                "rect": rect
            })
    return words


def find_quote_in_words(words, quote_text, page_hint=None):
    """
    Find the quote in the PDF words.
    Returns dict with sentence, pageIndex, pageLabel, rects, matched_words or None.
    """
    quote_words = [normalize_word(w) for w in quote_text.split() if normalize_word(w)]
    if not quote_words:
        return None

    max_words = min(6, len(quote_words))
    min_words = min(1, len(quote_words))

    # Optionally prioritize a page
    search_words = words
    if page_hint is not None:
        search_words = [w for w in words if w["page"] == page_hint] + [w for w in words if w["page"] != page_hint]

    best_match = None
    best_matched_count = 0

    for count in range(max_words, min_words - 1, -1):
        probe = quote_words[:count]
        for i in range(len(search_words) - count + 1):
            candidate = search_words[i:i + count]
            if all(words_match(probe[j], candidate[j]["normalized"]) for j in range(count)):
                # Short matches (titles, single terms) should not expand into the
                # following sentence when the title lacks ending punctuation.
                if count <= 3:
                    expanded = match_from_words(words, i, count)
                else:
                    expanded = expand_to_sentence(words, i, count)
                if expanded and (best_match is None or count > best_matched_count):
                    best_match = expanded
                    best_matched_count = count
        if best_match:
            break

    if not best_match:
        return None

    # Commentary is everything after matched words in the original quote
    commentary_words = quote_text.split()[best_matched_count:]
    best_match["commentary"] = " ".join(commentary_words).strip()
    return best_match


def rects_on_same_line(r1, r2, tolerance=3.0):
    """Check if two rects are on the same line (similar y coordinates)."""
    return abs(r1[1] - r2[1]) <= tolerance and abs(r1[3] - r2[3]) <= tolerance


def merge_word_rects(word_rects):
    """Merge adjacent word rects on the same line into line rects."""
    if not word_rects:
        return []
    merged = []
    current = list(word_rects[0])
    for r in word_rects[1:]:
        if rects_on_same_line(current, r):
            # Extend current rect to include this word
            current[0] = min(current[0], r[0])
            current[1] = min(current[1], r[1])
            current[2] = max(current[2], r[2])
            current[3] = max(current[3], r[3])
        else:
            merged.append([round(x, 2) for x in current])
            current = list(r)
    merged.append([round(x, 2) for x in current])
    return merged


def match_from_words(words, match_start, match_count):
    """Return a result dict for exactly the matched words without expanding."""
    matched = words[match_start:match_start + match_count]
    if not matched:
        return None
    word_rects = [w["rect"] for w in matched]
    merged_rects = merge_word_rects(word_rects)
    page = matched[0]["page"]
    return {
        "sentence": " ".join(w["text"] for w in matched),
        "pageIndex": page,
        "pageLabel": str(page + 1),
        "rects": merged_rects,
        "matched_words": match_count
    }


def expand_to_sentence(words, match_start, match_count):
    """Expand match to sentence boundaries using punctuation."""
    # Find sentence start: go back until a sentence ender
    start = match_start
    while start > 0:
        prev_word = words[start - 1]["text"]
        if prev_word.endswith((".", "!", "?")):
            break
        start -= 1

    # Find sentence end
    end = match_start + match_count
    while end < len(words):
        curr_word = words[end - 1]["text"]
        if curr_word.endswith((".", "!", "?")):
            break
        end += 1

    sentence_words = words[start:end]
    if not sentence_words:
        return None

    sentence_text = " ".join(w["text"] for w in sentence_words)
    word_rects = [w["rect"] for w in sentence_words]
    merged_rects = merge_word_rects(word_rects)
    page = sentence_words[0]["page"]

    return {
        "sentence": sentence_text,
        "pageIndex": page,
        "pageLabel": str(page + 1),
        "rects": merged_rects,
        "matched_words": match_count
    }


def match_quote(args):
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        write_output(args.output, {"error": f"PyMuPDF not installed: {e}", "found": False})
        return

    try:
        doc = fitz.open(args.pdf)
        words = extract_pdf_words(doc)
        doc.close()

        # In live mode we know which page the user is reading; restrict the
        # search to that page so a short/fuzzy match can't land on a wrong
        # section elsewhere in the document.
        if args.strict_page and args.page_hint is not None:
            words = [w for w in words if w["page"] == args.page_hint]

        result = find_quote_in_words(words, args.quote, args.page_hint)
        # Require a solid exact match (>= 3 words); anything less is likely a
        # garbled live transcription. Fall back to a sentence-level fuzzy match
        # so a mostly-correct quote still highlights the right sentence.
        if result and result.get("matched_words", 0) >= 3:
            write_output(args.output, {**result, "found": True})
            return

        fuzzy = fuzzy_sentence_match(words, args.quote, args.page_hint)
        if fuzzy:
            write_output(args.output, {**fuzzy, "found": True, "fuzzy": True})
            return

        if result:
            write_output(args.output, {**result, "found": True})
        else:
            write_output(args.output, {"found": False, "error": "Quote not found in PDF"})
    except Exception as e:
        write_output(args.output, {"found": False, "error": str(e)})


def fuzzy_sentence_match(words, quote_text, page_hint=None, min_overlap=2):
    """Find the PDF sentence with the highest normalized word overlap with
    the spoken quote. Used for live mode where transcription is imperfect."""
    spoken = [normalize_word(w) for w in quote_text.split() if normalize_word(w)]
    if len(spoken) < min_overlap:
        return None

    # Split the PDF words into sentences at . ! ?
    sentence_ranges = []
    cur_start = 0
    for i, w in enumerate(words):
        if w["text"].endswith((".", "!", "?")):
            sentence_ranges.append((cur_start, i + 1))
            cur_start = i + 1
    if cur_start < len(words):
        sentence_ranges.append((cur_start, len(words)))

    best = None
    best_score = 0
    for start, end in sentence_ranges:
        sentence_words = words[start:end]
        if not sentence_words:
            continue
        norm_set = set(sw["normalized"] for sw in sentence_words if sw["normalized"])
        # Count distinct spoken words present in this sentence
        present = sum(1 for wn in spoken if wn in norm_set)
        # Prefer sentences that contain the early spoken words (the quote's
        # beginning) and score higher overall
        early = sum(1 for wn in spoken[:3] if wn in norm_set)
        score = present + early
        if score > best_score and present >= min_overlap:
            best_score = score
            best = (start, end, present)

    if not best:
        return None

    start, end, present = best
    sentence_words = words[start:end]
    word_rects = [w["rect"] for w in sentence_words]
    merged_rects = merge_word_rects(word_rects)
    page = sentence_words[0]["page"]
    return {
        "sentence": " ".join(w["text"] for w in sentence_words),
        "pageIndex": page,
        "pageLabel": str(page + 1),
        "rects": merged_rects,
        "matched_words": present,
    }


def locate(args):
    try:
        import fitz  # PyMuPDF
    except ImportError as e:
        write_output(args.output, {"error": f"PyMuPDF not installed: {e}", "found": False})
        return

    try:
        doc = fitz.open(args.pdf)
        search_text = args.text.strip()
        page_hint = args.page_hint

        best_result = None
        best_score = 0.0

        start_page = max(0, page_hint) if page_hint is not None else 0
        end_page = min(doc.page_count, page_hint + 1) if page_hint is not None else doc.page_count

        # If page hint didn't work, search all pages
        for attempt in range(2):
            for page_num in range(start_page, end_page):
                page = doc.load_page(page_num)
                page_height = page.rect.height

                # Search for text
                text_instances = page.search_for(search_text)
                if text_instances:
                    # Exact match found
                    rects = [[round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)] for r in text_instances]
                    write_output(args.output, {
                        "found": True,
                        "pageIndex": page_num,
                        "pageLabel": str(page_num + 1),
                        "rects": rects,
                        "method": "exact"
                    })
                    doc.close()
                    return

                # Try partial match: first sentence or first N words
                words = search_text.split()
                for n in range(len(words), max(2, len(words) - 10), -1):
                    partial = " ".join(words[:n])
                    text_instances = page.search_for(partial)
                    if text_instances:
                        score = n / len(words)
                        if score > best_score:
                            best_score = score
                            best_result = {
                                "found": True,
                                "pageIndex": page_num,
                                "pageLabel": str(page_num + 1),
                                "rects": [[round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)] for r in text_instances],
                                "method": "partial",
                                "matched_words": n
                            }

            if best_result and best_score >= 0.6:
                break

            # Second attempt: search all pages if page_hint was used and nothing found
            if page_hint is not None and attempt == 0 and not best_result:
                start_page = 0
                end_page = doc.page_count
            else:
                break

        doc.close()

        if best_result:
            write_output(args.output, best_result)
        else:
            write_output(args.output, {"found": False, "error": "Text not found in PDF"})

    except Exception as e:
        write_output(args.output, {"found": False, "error": str(e)})


def write_output(path, data):
    if path:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2))


def _stream_write(path, obj):
    """Append a JSON line to the stream output file (or stdout)."""
    line = json.dumps(obj, ensure_ascii=False)
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()
    else:
        print(line, flush=True)


def stream(args):
    """Live microphone transcription that appends JSON lines to a file or stdout.

    Protocol (one JSON object per line):
      {"type": "ready"}
      {"type": "words", "offset": <abs seconds>, "words": [{word, normalized, start, end}, ...]}
      {"type": "done"}
      {"type": "error", "error": "..."}

    The process exits cleanly (after a final flush) when --stop-file exists.
    """
    try:
        import numpy as np
        import sounddevice as sd
        from faster_whisper import WhisperModel
    except ImportError as e:
        _stream_write(args.output_file, {"type": "error", "error": f"Missing dependency for live mode (pip install sounddevice): {e}"})
        return

    def emit(obj):
        _stream_write(args.output_file, obj)

    try:
        model_size = args.model or "base"
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
            compute_type = "float16" if device == "cuda" else "int8"
        except ImportError:
            device = "cpu"
            compute_type = "int8"
        # Cap CPU threads so live transcription doesn't starve Zotero's UI.
        # beam_size=5 matches the batch transcription accuracy.
        model = WhisperModel(model_size, device=device, compute_type=compute_type, cpu_threads=4)
    except Exception as e:
        emit({"type": "error", "error": f"Failed to load Whisper model: {e}"})
        return

    sample_rate = 16000
    flush_interval = max(0.5, float(args.flush_interval or 2))
    min_chunk = max(0.25, float(args.min_chunk or 0.5))
    window_seconds = 15.0   # rolling transcription window (context for accuracy)

    # If a stale stop file exists from a previous run, clear it so we don't
    # exit immediately.
    if args.stop_file and os.path.exists(args.stop_file):
        try:
            os.remove(args.stop_file)
        except OSError:
            pass

    buffer = np.zeros(0, dtype=np.float32)  # rolling raw mic audio
    buffer_start = 0                          # absolute sample index of buffer[0]
    abs_total = 0                             # samples recorded (monotonic)
    abs_flushed = 0                           # samples already emitted (monotonic)
    last_word = None                          # (normalized, end) of last emitted word

    def do_flush(force=False):
        nonlocal buffer, buffer_start, abs_total, abs_flushed, last_word
        if abs_total - abs_flushed < min_chunk * sample_rate and not force:
            return
        # Transcribe the whole rolling window so the model has plenty of
        # context (short 2s chunks lose too many words); emit only words
        # newer than the last flush point.
        t_start = max(buffer_start, abs_total - int(window_seconds * sample_rate))
        audio = buffer[t_start - buffer_start:]
        if audio.size == 0:
            return
        offset = t_start / sample_rate
        try:
            segments, _info = model.transcribe(
                audio,
                beam_size=5,
                word_timestamps=True,
                condition_on_previous_text=False,
                vad_filter=True,
            )
        except Exception as e:
            emit({"type": "error", "error": f"Transcription error: {e}"})
            return
        words = []
        emit_from = abs_flushed / sample_rate
        for segment in segments:
            sw = getattr(segment, "words", None)
            if not sw:
                continue
            for w in sw:
                if isinstance(w, tuple):
                    word_text, start, end = w[0], w[1], w[2]
                else:
                    word_text, start, end = w.word, w.start, w.end
                word_text = (word_text or "").strip()
                norm = normalize_word(word_text)
                if not norm:
                    continue
                wstart = float(start) + offset
                wend = float(end) + offset
                if wstart < emit_from:
                    continue  # already emitted in a previous flush
                # Skip near-duplicate re-recognitions of the previous word
                if last_word and last_word[0] == norm and wstart - last_word[1] < 0.3:
                    continue
                last_word = (norm, wend)
                words.append({
                    "word": word_text,
                    "normalized": norm,
                    "start": round(wstart, 3),
                    "end": round(wend, 3),
                })
        if words:
            emit({"type": "words", "offset": round(offset, 3), "words": words})
        abs_flushed = abs_total
        # Trim the buffer to the window to bound memory usage
        keep_from = max(buffer_start, abs_total - int(window_seconds * sample_rate))
        if keep_from > buffer_start:
            buffer = buffer[keep_from - buffer_start:]
            buffer_start = keep_from

    def callback(indata, frames, time_info, status):
        nonlocal buffer, abs_total
        buffer = np.concatenate([buffer, indata.reshape(-1)])
        abs_total += len(indata)

    emit({"type": "ready"})

    try:
        with sd.InputStream(samplerate=sample_rate, channels=1, dtype="float32", callback=callback) as audio_stream:
            last_flush = time.monotonic()
            while True:
                now = time.monotonic()
                if now - last_flush >= flush_interval:
                    last_flush = now
                    do_flush()
                if args.stop_file and os.path.exists(args.stop_file):
                    break
                time.sleep(0.1)
    except Exception as e:
        emit({"type": "error", "error": f"Microphone error: {e}"})
        return

    # Final flush of any remaining audio, then signal completion.
    do_flush(force=True)
    emit({"type": "done"})


def main():
    parser = argparse.ArgumentParser(description="Zotero Zotero Voice Annotator Helper")
    subparsers = parser.add_subparsers(dest="command")

    # Transcribe subcommand
    transcribe_parser = subparsers.add_parser("transcribe", help="Transcribe audio file")
    transcribe_parser.add_argument("--audio", required=True, help="Path to audio file")
    transcribe_parser.add_argument("--model", default="base", help="Whisper model size")
    transcribe_parser.add_argument("--output", help="Output JSON file path")

    # Match subcommand
    match_parser = subparsers.add_parser("match", help="Match quote in PDF and return position")
    match_parser.add_argument("--pdf", required=True, help="Path to PDF file")
    match_parser.add_argument("--quote", required=True, help="Quote text to match")
    match_parser.add_argument("--page-hint", type=int, default=None, help="Preferred page index (0-based)")
    match_parser.add_argument("--strict-page", action="store_true", help="Only search the page given by --page-hint (live mode)")
    match_parser.add_argument("--output", help="Output JSON file path")

    # Locate subcommand
    locate_parser = subparsers.add_parser("locate", help="Locate text in PDF")
    locate_parser.add_argument("--pdf", required=True, help="Path to PDF file")
    locate_parser.add_argument("--text", required=True, help="Text to locate")
    locate_parser.add_argument("--page-hint", type=int, default=None, help="Preferred page index (0-based)")
    locate_parser.add_argument("--output", help="Output JSON file path")

    # Stream subcommand (live microphone transcription)
    stream_parser = subparsers.add_parser("stream", help="Live microphone transcription (JSONL output)")
    stream_parser.add_argument("--model", default="base", help="Whisper model size")
    stream_parser.add_argument("--flush-interval", type=float, default=2.0, help="Seconds between transcription flushes")
    stream_parser.add_argument("--min-chunk", type=float, default=0.5, help="Minimum seconds of new audio before flushing")
    stream_parser.add_argument("--stop-file", default=None, help="Stop (after final flush) when this file exists")
    stream_parser.add_argument("--output-file", default=None, help="JSONL file to append output to (default: stdout)")

    args = parser.parse_args()

    if args.command == "transcribe":
        transcribe(args)
    elif args.command == "match":
        match_quote(args)
    elif args.command == "locate":
        locate(args)
    elif args.command == "stream":
        stream(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
