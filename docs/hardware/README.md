# Hardware drawings

**TD18-HW-002 — 16 PPG pad wheel harness**, 2 sheets, revision A.

| File | What |
|---|---|
| `wheel_harness_16pads.py` | generator: run it to rebuild both sheets and the PDF |
| `wheel_harness_16pads.svg` | sheet 1 — interconnect diagram |
| `wheel_harness_16pads_sheet2.svg` | sheet 2 — parts list and wire list |
| `wheel_harness_16pads.pdf` | both sheets, ANSI B proportions, for printing or the report |

```
python3 wheel_harness_16pads.py                       # rebuild .svg x2 and .pdf
rsvg-convert -w 3400 wheel_harness_16pads.svg -o sheet1.png
```

The SVGs open in a browser, Inkscape or draw.io if you prefer to edit by hand,
but changes are easier in the generator (one pad count, one list of notes).

Device data on the sheets is cited from the primary datasheets:

- **TCA9548A** — TI SCPS207H, May 2012, revised September 2024: 8 channels;
  address byte `1110 A2 A1 A0` → 0x70–0x77 (Figure 7-3, §7.5.2); VCC
  1.65–5.5 V; fSCL 0–400 kHz; active-low RESET.
- **MAX30102** — Maxim 19-7740 Rev 1, 10/18: I²C write 0xAE / read 0xAF
  (7-bit 0x57); VDD 1.7–2.0 V; VLED+ 3.1–5.0 V; fSCL 0–400 kHz; FIFO 32
  samples.
- The IMU's address is **not** verified here: confirm it against the datasheet
  of whichever module is fitted.

The bench prototype sheet (2 pads, revision A) is Andrew's separate drawing.
