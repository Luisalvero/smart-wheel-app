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

## Simulations (`sim/`)

| Tool | Question it answers |
|---|---|
| `sim/i2c_bus.py` | does a bus segment still meet the I²C timing spec with this harness length and pull-up? |
| `sim/rail_drop.py` | how much of the 5 V reaches the far pad, given a **measured** per-pad current? |

```
python3 sim/i2c_bus.py --len 1.0 --pads 1        # rise-time table, PASS/FAIL
python3 sim/i2c_bus.py --len 1.0 --spice bus.cir # netlist for a real SPICE run
ngspice -b bus.cir                               # needs: sudo pacman -S ngspice
python3 sim/rail_drop.py --ma 25 --pads 16 --awg 22 --len 1.2
```

Limits are from the **I²C-bus specification, NXP UM10204 Rev 7.0, 1 October
2021, Table 10**: fast mode (400 kbit/s) needs a rise time of 300 ns or less,
with at most 400 pF on a line.

**A result that changed the drawing:** at an assumed 60 pF/m, a 1 m branch is
about 82 pF, and a 4.7 kΩ pull-up gives a 327 ns rise — over the limit. The
sheets now specify **2.2 kΩ**. Cable capacitance is an assumption until the
harness is measured, so re-run `i2c_bus.py --cpm <measured>` and check the rise
time on a scope before trusting it.
