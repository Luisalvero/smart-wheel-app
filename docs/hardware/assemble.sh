#!/usr/bin/env bash
# Builds TD18-HW-002 as one PDF: the drawn sheets, the KiCad schematic and the
# verification record, all on A1 landscape pages.
#   ./assemble.sh          (run verify.py and report_sheets.py first)
set -euo pipefail
cd "$(dirname "$0")"
OUT=TD18-HW-002_wheel_harness_package.pdf
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# A1 landscape, with each drawn sheet fitted to the page width and centred.
page() {   # page <in.svg> <out.pdf>
  rsvg-convert -f pdf --page-width=841mm --page-height=594mm \
    --width=841mm --keep-aspect-ratio --left=0 --top=25mm "$1" -o "$2"
}
page wheel_harness_16pads.svg        "$TMP/p1.pdf"
page wheel_harness_16pads_sheet2.svg "$TMP/p2.pdf"
cp kicad/wheel_harness_schematic.pdf "$TMP/p3.pdf"     # already A1 from KiCad
page sheet4_verification.svg         "$TMP/p4.pdf"
page sheet5_findings.svg             "$TMP/p5.pdf"

pdfunite "$TMP"/p1.pdf "$TMP"/p2.pdf "$TMP"/p3.pdf "$TMP"/p4.pdf "$TMP"/p5.pdf "$OUT"
printf '%s: %s pages, %s\n' "$OUT" "$(pdfinfo "$OUT" | awk '/Pages/{print $2}')" \
       "$(du -h "$OUT" | cut -f1)"
