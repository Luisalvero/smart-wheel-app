#!/usr/bin/env python3
"""Terminal dashboard for the PPG relay.

Shows the ESP32 link, connected phones/laptops, live vitals with a two-minute
trend, packet counters, the latest packets and the relay's event log.

It only READS the relay's state file, so closing this window never affects
logging or relaying: the relay keeps running as a systemd service.

    python3 ppg_monitor.py            (opened automatically at boot by setup_pi.sh)
    Ctrl+C to close.
"""

import json
import os
import socket
import sys
import time
from datetime import datetime
from pathlib import Path

from rich.align import Align
from rich.console import Console, Group
from rich.layout import Layout
from rich.live import Live
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

STATE_CANDIDATES = [
    Path("/run/ppg-relay/state.json"),               # systemd RuntimeDirectory
    Path(f"/tmp/ppg-relay-{os.getuid()}/state.json"),  # relay run by hand
]
STALE_AFTER = 5.0   # seconds without a state update -> relay presumed down

OK, WARN, BAD, DIM = "green3", "orange1", "red1", "grey50"
BPM_COLOR, SPO2_COLOR = "indian_red1", "deep_sky_blue1"
BLOCKS = " ▁▂▃▄▅▆▇█"


def hms(seconds: float | None) -> str:
    if seconds is None:
        return "--:--:--"
    s = max(0, int(seconds))
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def clock(ts: float | None) -> str:
    return datetime.fromtimestamp(ts).strftime("%H:%M:%S") if ts else "--"


def sparkline(values: list, lo: float, hi: float, width: int) -> Text:
    """One character per second; a gap is a second with no usable reading."""
    vals = values[-width:]
    out = Text(" " * (width - len(vals)))
    for v in vals:
        if v is None:
            out.append("·", style=DIM)
        else:
            f = (min(max(v, lo), hi) - lo) / (hi - lo)
            out.append(BLOCKS[1 + round(f * (len(BLOCKS) - 2))])
    return out


def auto_range(values: list, min_span: float, floor: float, ceil: float) -> tuple[float, float]:
    """Scale to the data so normal variation is visible, but never tighter than
    min_span (or noise looks like a trend) and never outside [floor, ceil]."""
    vals = [v for v in values if v is not None]
    if not vals:
        return floor, ceil
    lo, hi = min(vals), max(vals)
    pad = max(0.0, (min_span - (hi - lo)) / 2)
    lo, hi = max(floor, lo - pad), min(ceil, hi + pad)
    if hi - lo < min_span:  # clipped against a limit: extend away from it
        if hi >= ceil:
            lo = max(floor, hi - min_span)
        else:
            hi = min(ceil, lo + min_span)
    return lo, hi


def dot(ok: bool | None, warn: bool = False) -> Text:
    color = OK if ok else WARN if warn else BAD
    return Text("●", style=color)


def load_state() -> tuple[dict | None, Path | None]:
    for path in STATE_CANDIDATES:
        try:
            return json.loads(path.read_text()), path
        except (OSError, ValueError):
            continue
    return None, None


# --------------------------------------------------------------- panels ---

def header(st: dict | None, alive: bool) -> Panel:
    now = time.time()
    t = Text()
    t.append(" PPG RELAY ", style="bold black on deep_sky_blue1")
    t.append(f"  {(st or {}).get('host') or socket.gethostname()}", style="bold")
    t.append(f"   {datetime.now():%a %b %d  %H:%M:%S}", style=DIM)
    if st and alive:
        t.append(f"   relay up {hms(now - st['started'])}", style=DIM)
    return Panel(t, border_style=DIM, padding=(0, 1))


def links(st: dict) -> Panel:
    now = time.time()
    esp = st["esp"]
    g = Table.grid(padding=(0, 2))
    g.add_column(style="bold", width=16)
    g.add_column()

    state = esp["state"]
    connected = state == "connected"
    row = Text()
    row.append_text(dot(connected, warn=state in ("scanning", "connecting", "starting")))
    row.append(f" {state.upper()}", style="bold " + (OK if connected else WARN))
    g.add_row("ESP32 sensor", row)
    if connected:
        g.add_row("", Text(f"{esp['addr']}   since {clock(esp['since'])}   up {hms(now - esp['since'])}", style=DIM))
    else:
        g.add_row("", Text("looking for SteeringWheelESP32 …", style=DIM))

    clients = st["clients"]
    row = Text()
    if not st["advertising"]:
        row.append_text(dot(None))
        row.append(" relay to phone disabled (--no-relay)", style=DIM)
    elif clients:
        row.append_text(dot(True))
        row.append(f" {len(clients)} CONNECTED", style="bold " + OK)
    else:
        row.append_text(dot(False, warn=True))
        row.append(" WAITING", style="bold " + WARN)
        row.append("  advertising as PPG-Relay-Pi", style=DIM)
    g.add_row("Phone / laptop", row)
    for c in clients:
        g.add_row("", Text(f"{c['name']}   since {clock(c['since'])}   up {hms(now - c['since'])}", style=DIM))
    if clients:
        sub = Text("receiving frames" if st["subscribed"] else "connected, not yet subscribed",
                   style=OK if st["subscribed"] else WARN)
        sub.append(f"   MTU {st['mtu']}", style=DIM)
        g.add_row("", sub)
    return Panel(g, title="[bold]LINKS", title_align="left", border_style=DIM)


def vitals(st: dict, width: int) -> Panel:
    last = st["recent"][-1] if st["recent"] else None
    age = time.time() - st["last_frame_at"] if st["last_frame_at"] else None

    if last is None or age is None or age > 3:
        signal, scol = "no data", DIM
    elif not last["finger"]:
        signal, scol = "no finger on sensor", WARN
    elif not last["usable"]:
        signal, scol = "reading pulse …", WARN
    else:
        signal, scol = "good signal", OK

    def big(label, value, avg, unit, color):
        t = Text()
        t.append(f"{label}\n", style=f"bold {DIM}")
        t.append(f"{value if value is not None else '--':>4}", style=f"bold {color if value is not None else DIM}")
        t.append(f" {unit}", style=DIM)
        t.append(f"\n5-pt avg {avg:.0f}" if avg is not None else "\n5-pt avg --", style=DIM)
        return t

    top = Table.grid(expand=True)
    for _ in range(3):
        top.add_column(ratio=1)
    top.add_row(
        big("HEART RATE", last["bpm"] if last else None, st["avg_bpm"], "bpm", BPM_COLOR),
        big("SpO₂", last["spo2"] if last else None, st["avg_spo2"], "%", SPO2_COLOR),
        Text.assemble(("SIGNAL\n", f"bold {DIM}"), (f"● {signal}", f"bold {scol}"),
                      (f"\nlast packet {age:.1f} s ago" if age is not None else "\n--", DIM)),
    )

    # panel border + padding (4) + label column (14) + gap (1)
    w = max(10, width - 19)
    trend = Table.grid(padding=(0, 1))
    trend.add_column(style=DIM, width=14, no_wrap=True)
    trend.add_column(no_wrap=True)
    blo, bhi = auto_range(st["bpm_trend"], 20, 30, 220)
    slo, shi = auto_range(st["spo2_trend"], 6, 70, 100)
    bpm_line = sparkline(st["bpm_trend"], blo, bhi, w)
    bpm_line.stylize(BPM_COLOR)      # stylize() works in place and returns None
    spo2_line = sparkline(st["spo2_trend"], slo, shi, w)
    spo2_line.stylize(SPO2_COLOR)
    trend.add_row(f"BPM  {blo:.0f}-{bhi:.0f}", bpm_line)
    trend.add_row(f"SpO₂ {slo:.0f}-{shi:.0f}", spo2_line)
    return Panel(Group(top, Text(""), trend), title="[bold]VITALS  [dim](trend: last 2 min, · = no reading)",
                 title_align="left", border_style=DIM)


def packets(st: dict, rows: int) -> Panel:
    t = Table(expand=True, box=None, header_style=f"bold {DIM}", padding=(0, 1))
    for col, just, w in (("time", "left", 8), ("seq", "right", 7), ("bpm", "right", 4), ("SpO₂", "right", 4),
                         ("finger", "center", 6), ("CRC", "center", 3), ("→ phone", "center", 7)):
        t.add_column(col, justify=just, min_width=w)
    for r in reversed(st["recent"][-rows:]):
        t.add_row(
            clock(r["t"]), str(r["seq"]),
            Text(str(r["bpm"]) if r["bpm"] is not None else "--", style=BPM_COLOR if r["bpm"] else DIM),
            Text(str(r["spo2"]) if r["spo2"] is not None else "--", style=SPO2_COLOR if r["spo2"] else DIM),
            Text("yes" if r["finger"] else "no", style=OK if r["finger"] else WARN),
            Text("✓", style=OK),  # frames only reach this list after the CRC check
            Text("✓" if r["fwd"] else "–", style=OK if r["fwd"] else DIM),
        )
        if r.get("missing"):
            t.add_row(Text(f"  {r['missing']} frame(s) lost", style=BAD), "", "", "", "", "", "")
    return Panel(t, title="[bold]LATEST PACKETS", title_align="left", border_style=DIM)


def stats(st: dict) -> Panel:
    c = st["counters"]
    uptime = time.time() - st["started"]
    g = Table.grid(padding=(0, 2))
    g.add_column(style=DIM)
    g.add_column(justify="right")
    g.add_row("received from ESP32", f"{c['rx']:,}")
    g.add_row("forwarded to phone", f"{c['forwarded']:,}")
    g.add_row("rows logged", f"{c['logged']:,}")
    g.add_row("rate", f"{c['rx'] / uptime:.2f}/s" if uptime > 5 else "--")
    fi = st.get("frame")
    if fi:
        # v3 packets carry every raw sample; v2 carried 8. Shown so a firmware
        # mismatch (old ESP32 image) is obvious at a glance.
        g.add_row("packet", f"v{fi['version']} · {fi['samples']} samples"
                  + (f" @ {fi['rate_hz']} Hz" if fi.get("rate_hz") else "") + f" · {fi['bytes']} B")
    if uptime > 5 and st.get("bytes_rx") is not None:
        g.add_row("throughput", f"{st['bytes_rx'] / uptime:,.0f} B/s")
    g.add_row("lost frames", Text(str(c["lost"]), style=BAD if c["lost"] else OK))
    g.add_row("CRC errors", Text(str(c["crc"]), style=BAD if c["crc"] else OK))
    g.add_row("ESP32 restarts", Text(str(c["resets"]), style=WARN if c["resets"] else OK))
    g.add_row("raw PPG logging", Text("ON (dev)" if st["raw_logging"] else "off", style=WARN if st["raw_logging"] else DIM))
    return Panel(g, title="[bold]COUNTERS", title_align="left", border_style=DIM)


def events(st: dict, rows: int) -> Panel:
    t = Text()
    for e in st["events"][-rows:]:
        color = {"WARNING": WARN, "ERROR": BAD}.get(e["level"], DIM)
        t.append(f"{clock(e['t'])} ", style=DIM)
        t.append(e["msg"][:90] + "\n", style=color if color != DIM else "")
    return Panel(t, title="[bold]EVENTS", title_align="left", border_style=DIM)


def down(path: Path | None, st: dict | None) -> Panel:
    msg = Text(justify="center")
    msg.append("RELAY NOT RUNNING\n\n", style=f"bold {BAD}")
    if st:
        msg.append(f"last update {time.time() - st['now']:.0f} s ago\n\n", style=DIM)
    msg.append("check it with:\n", style=DIM)
    msg.append("systemctl status ppg-relay\njournalctl -u ppg-relay -n 30\n", style="bold")
    msg.append("\nthis screen recovers by itself once the relay is back", style=DIM)
    return Panel(Align.center(msg, vertical="middle"), border_style=BAD)


def render(console: Console) -> Layout:
    st, path = load_state()
    alive = bool(st) and time.time() - st["now"] < STALE_AFTER
    width, height = console.size

    root = Layout()
    root.split_column(Layout(header(st, alive), size=3), Layout(name="body"))
    if not alive:
        root["body"].update(down(path, st))
        return root

    link_h = 7 + len(st["clients"])
    body = root["body"]
    body.split_column(Layout(name="links", size=link_h), Layout(name="vitals", size=10), Layout(name="bottom"))
    body["links"].update(links(st))
    body["vitals"].update(vitals(st, width))
    bottom_h = max(6, height - 3 - link_h - 10)
    body["bottom"].split_row(Layout(name="packets", ratio=3), Layout(name="side", ratio=2))
    body["bottom"]["packets"].update(packets(st, bottom_h - 3))
    body["bottom"]["side"].split_column(Layout(stats(st), size=10), Layout(events(st, max(1, bottom_h - 12))))
    return root


def main() -> int:
    console = Console()
    if "--once" in sys.argv:          # one frame to stdout, for scripts/tests
        console.print(render(console))
        return 0
    try:
        with Live(render(console), console=console, screen=True, refresh_per_second=4) as live:
            while True:
                time.sleep(0.25)
                live.update(render(console))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
