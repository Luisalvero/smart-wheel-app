# Hardware drawings

| File | What |
|---|---|
| `wheel_harness_16pads.py` | generator for the 16-pad wheel harness sheet (`python3 wheel_harness_16pads.py`) |
| `wheel_harness_16pads.svg` | the sheet, rendered. Opens in a browser, Inkscape or draw.io |

Export a PNG for a report:

```
rsvg-convert -w 3200 wheel_harness_16pads.svg -o harness.png
```

The bench prototype sheet (2 pads, revision A) is Andrew's separate drawing.
This one is the wheel build: 16 MAX30102 pads behind two TCA9548A
multiplexers, with one pad streaming at a time.
