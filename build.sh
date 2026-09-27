#!/bin/bash
set -e

cd "$(dirname "$0")"

VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
OUTPUT="zotero-voice-annotator-${VERSION}.xpi"

echo "Building Zotero Voice Annotator ${VERSION}..."

rm -f "${OUTPUT}"

zip -r "${OUTPUT}" \
  manifest.json \
  chrome.manifest \
  updates.json \
  bootstrap.js \
  prefs.js \
  modules/ \
  scripts/ \
  chrome/ \
  locale/ \
  skin/ \
  helper/ \
  README.md \
  -x "*/__pycache__/*" "*/.DS_Store"

echo "Built: ${OUTPUT}"
