"""Builds docs/Team18_System_Guide.pdf from docs/SYSTEM_GUIDE.md.

    python3 -m pip install markdown-it-py   # once
    python3 docs/tools/build_pdf.py      # needs chromium (or google-chrome) on PATH

Markdown -> HTML with a CommonMark parser (markdown-it, so lists nest exactly
as they do on GitHub) -> print stylesheet, cover page, contents -> headless
Chromium's PDF printer. The Markdown file stays the source of truth.
"""
import datetime
import html
import os
import re
import shutil
import subprocess
import sys

from markdown_it import MarkdownIt

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.dirname(HERE)
SRC = os.path.join(DOCS, "SYSTEM_GUIDE.md")
OUT_HTML = os.path.join(DOCS, "tools", "guide_print.html")
OUT_PDF = os.path.join(DOCS, "Team18_System_Guide.pdf")

CSS = """
@page { size: Letter; margin: 20mm 17mm 18mm 17mm;
  @bottom-left { content: "Team 18 · Biometric Steering Wheel · System Guide"; font: 8pt 'IBM Plex Sans', sans-serif; color: #6b7c79; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 8pt 'IBM Plex Sans', sans-serif; color: #6b7c79; } }
@page :first { @bottom-left { content: none; } @bottom-right { content: none; } }
:root { --ink:#10201e; --muted:#536663; --line:#d5e0dd; --accent:#0f766e; --soft:#e7f3f1; --code:#f1f5f4; }
* { box-sizing: border-box; }
body { margin:0; color:var(--ink); font: 10pt/1.5 'IBM Plex Sans', system-ui, sans-serif; background:#fff; }
.cover { height: 235mm; display:flex; flex-direction:column; justify-content:space-between; break-after: page; }
.cover .eyebrow { font: 500 9pt 'IBM Plex Mono', monospace; letter-spacing:.14em; text-transform:uppercase; color:var(--accent); }
.cover h1 { font: 700 34pt/1.05 'Bricolage Grotesque', 'IBM Plex Sans', sans-serif; margin: 10mm 0 6mm; letter-spacing:-.01em; }
.cover .lede { font-size: 12pt; color: var(--muted); max-width: 130mm; }
.chain { margin-top: 10mm; display:flex; flex-wrap:wrap; gap:2mm 3mm; align-items:center; font: 500 8.5pt 'IBM Plex Mono', monospace; color:var(--muted); }
.chain b { color:var(--ink); font-weight:500; border:0.3mm solid var(--line); padding:1.5mm 2.5mm; border-radius:1.5mm; }
.chain i { font-style:normal; color:var(--accent); }
.cover .meta { border-top: 0.3mm solid var(--line); padding-top: 4mm; font-size: 9pt; color: var(--muted); display:grid; grid-template-columns: 1fr 1fr; gap: 2mm 10mm; }
.cover .meta b { color: var(--ink); font-weight: 600; }
.toc { break-after: page; }
.toc h2 { font: 700 18pt 'Bricolage Grotesque', sans-serif; margin: 0 0 6mm; }
.toc ol { margin:0; padding-left: 0; list-style: none; counter-reset: s; columns: 1; }
.toc li { counter-increment: s; padding: 1.6mm 0; border-bottom: 0.2mm solid var(--line); font-size: 10.5pt; }
.toc li::before { content: counter(s, decimal-leading-zero); font: 9pt 'IBM Plex Mono', monospace; color: var(--accent); display:inline-block; width: 10mm; }
.toc ul { list-style:none; margin: 1mm 0 0 10mm; padding:0; color: var(--muted); font-size: 9pt; }
article h2 { font: 700 17pt/1.2 'Bricolage Grotesque', sans-serif; break-before: page; margin: 0 0 4mm; padding-bottom: 2mm; border-bottom: 0.6mm solid var(--accent); }
article h3 { font: 600 12pt/1.3 'IBM Plex Sans', sans-serif; margin: 6mm 0 2mm; color: var(--ink); break-after: avoid; }
article p, article li { orphans: 3; widows: 3; }
article ul, article ol { padding-left: 5mm; }
article li + li { margin-top: 1mm; }
a { color: var(--accent); text-decoration: none; overflow-wrap: anywhere; }
code { font: 8.6pt 'IBM Plex Mono', monospace; background: var(--code); padding: 0.2mm 1mm; border-radius: 1mm; overflow-wrap: anywhere; }
pre { background: var(--code); border: 0.3mm solid var(--line); border-radius: 1.5mm; padding: 3mm 3.5mm; font-size: 7.8pt; line-height: 1.45; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 7.8pt; }
table { width: 100%; border-collapse: collapse; margin: 3mm 0 4mm; font-size: 8.6pt; break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { text-align: left; vertical-align: top; padding: 1.6mm 2mm; border-bottom: 0.25mm solid var(--line); }
th { background: var(--soft); font-weight: 600; font-size: 7.8pt; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
em { color: var(--muted); }
strong { font-weight: 600; }
"""


def main():
    src = open(SRC, encoding="utf-8").read()
    src = src[src.index("## 1. "):]
    body = MarkdownIt("commonmark", {"html": False, "linkify": False}).enable("table").render(src)
    body = body.replace("<hr />", "").replace("<hr>", "")
    # Contents from the headings (h2 sections, h3 subsections).
    toc, current = [], None
    for level, text in re.findall(r"<h([23])>(.*?)</h\1>", body):
        plain = re.sub(r"<[^>]+>", "", text)
        if level == "2":
            current = {"name": re.sub(r"^\d+\.\s*", "", plain), "subs": []}
            toc.append(current)
        elif current:
            current["subs"].append(plain)
    toc = [
        f"<li>{t['name']}{'<ul>' + ''.join(f'<li>{s}</li>' for s in t['subs']) + '</ul>' if t['subs'] else ''}</li>"
        for t in toc
    ]
    today = datetime.date.today().strftime("%B %-d, %Y")
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Biometric Steering Wheel — System Guide</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>{CSS}</style></head><body>
<section class="cover">
  <div>
    <div class="eyebrow">Team 18 · FIU Senior Design · Prototype, not a medical device</div>
    <h1>Biometric Steering Wheel<br>System Guide</h1>
    <p class="lede">Every part of the working system — sensor, ESP32 firmware, signal processing, Raspberry Pi relay,
    phone app, warning and emergency system, cloud database and live website — with setup instructions for any Linux
    machine, test results and references.</p>
    <div class="chain"><b>MAX30102 · 100 Hz</b><i>→ I²C →</i><b>ESP32</b><i>→ BLE →</i><b>Raspberry Pi 5</b><i>→ BLE →</i><b>iPhone app</b><i>→ cellular →</i><b>Supabase</b><i>→</i><b>Website</b></div>
  </div>
  <div class="meta">
    <div><b>Branch</b><br>luis/full-system</div>
    <div><b>Date</b><br>{today}</div>
    <div><b>Live dashboard</b><br>smart-wheel-dashboard.vercel.app</div>
    <div><b>Source of this document</b><br>docs/SYSTEM_GUIDE.md</div>
  </div>
</section>
<section class="toc"><h2>Contents</h2><ol>{''.join(toc)}</ol></section>
<article>{body}</article>
</body></html>"""
    open(OUT_HTML, "w", encoding="utf-8").write(page)
    browser = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
    if not browser:
        sys.exit("chromium or google-chrome is needed to print the PDF")
    subprocess.run([browser, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                    "--virtual-time-budget=10000", f"--print-to-pdf={OUT_PDF}", f"file://{OUT_HTML}"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"wrote {OUT_PDF}")


if __name__ == "__main__":
    main()
