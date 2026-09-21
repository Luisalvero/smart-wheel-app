#!/usr/bin/env python3
"""Laptop PPG viewer: live BPM / SpO2 charts, PPG waveform, packet log.

Sources:
  (default)  Raspberry Pi relay ("PPG-Relay-Pi")
  --direct   the ESP32 itself, skipping the Pi -- same frame format, so this is
             the fastest way to isolate a fault to the ESP32 or the Pi
  --demo     synthetic frames through the real encode/deframe path; no radio

Every frame is CRC-checked here even when relayed: the Pi forwards frames
byte-for-byte, so the ESP32's CRC is verified end to end.

BLE runs on its own asyncio loop in a worker thread and hands decoded frames to
the Qt thread through signals, so neither side can stall the other.
"""

import argparse
import asyncio
import json
import math
import random
import sys
import time
from collections import deque
from datetime import datetime

import numpy as np
import pyqtgraph as pg
from PySide6.QtCore import QObject, Qt, QThread, QTimer, Signal
from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import (QApplication, QFrame, QGridLayout, QHBoxLayout, QHeaderView,
                               QLabel, QMainWindow, QSplitter, QTableWidget, QTableWidgetItem,
                               QVBoxLayout, QWidget)

import ppg_protocol as p
from bluez_links import release_orphaned

HISTORY_S = 300          # vitals chart window
WAVE_S = 20              # PPG waveform window
TABLE_ROWS = 300

# Palette: dark instrument panel. BPM and SpO2 get distinct, colour-blind-safe
# hues (warm vs cool) so the two charts never read as one series.
BG, PANEL, GRID = "#0d1117", "#151b23", "#2a3340"
INK, MUTED = "#e6edf3", "#8b98a8"
BPM_C, SPO2_C, WAVE_C = "#ff7b54", "#4fc3f7", "#9ccc65"
OK_C, WARN_C, BAD_C = "#3fb950", "#d29922", "#f85149"


# =========================================================================
# BLE worker
# =========================================================================

class Worker(QObject):
    frame = Signal(object, float)          # (p.Frame, laptop receive time)
    link = Signal(str, str)                # (state, detail)
    connected = Signal(float, str)         # (timestamp, address)
    status = Signal(dict)                  # Pi relay status JSON
    counters = Signal(int, int)            # (crc_errors, bytes_dropped)

    def __init__(self, mode):
        super().__init__()
        self.mode = mode
        self._stop = False
        self._loop = None
        self._task = None

    def stop(self):
        """Thread-safe. Cancels whatever the worker is awaiting -- a scan or a
        connect can otherwise block for up to 20 s, and Qt aborts the process if
        the window destroys a QThread that is still running."""
        self._stop = True
        if self._loop and self._task:
            self._loop.call_soon_threadsafe(self._task.cancel)

    def run(self):
        asyncio.run(self._main())

    async def _main(self):
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.current_task()
        try:
            await (self._demo() if self.mode == "demo" else self._ble())
        except asyncio.CancelledError:
            pass  # normal shutdown; BleakClient's context manager disconnects cleanly

    def _emit_frames(self, deframer, data):
        for f in deframer.feed(data):
            self.frame.emit(f, time.time())
        self.counters.emit(deframer.crc_errors, deframer.bytes_dropped)

    async def _ble(self):
        from bleak import BleakClient, BleakScanner

        relay = self.mode == "relay"
        svc = p.RELAY_SERVICE_UUID if relay else p.ESP32_SERVICE_UUID
        notify_uuid = p.RELAY_FRAME_UUID if relay else p.ESP32_TX_UUID
        label = p.RELAY_NAME if relay else "SteeringWheelESP32"

        while not self._stop:
            self.link.emit("scanning", f"looking for {label}")
            dev = await BleakScanner.find_device_by_filter(
                lambda _d, adv: svc in (u.lower() for u in adv.service_uuids), timeout=8.0)
            if dev is None:
                # A device still tied to a dead connection (e.g. after this app
                # crashed) stops advertising; close that link and look again.
                if await release_orphaned(svc):
                    self.link.emit("scanning", "released a stale connection")
                    continue
                self.link.emit("searching", f"{label} not found - retrying")
                continue

            self.link.emit("connecting", dev.address)
            gone = asyncio.Event()
            deframer = p.Deframer()
            try:
                async with BleakClient(dev, timeout=20.0,
                                       disconnected_callback=lambda _c: gone.set()) as client:
                    self.connected.emit(time.time(), dev.address)
                    self.link.emit("connected", dev.address)
                    if relay:
                        # Read status before subscribing: the read tells the Pi the
                        # negotiated MTU, so it can send each frame in one piece.
                        await self._read_status(client)
                    await client.start_notify(notify_uuid, lambda _c, d: self._emit_frames(deframer, d))
                    while not gone.is_set() and not self._stop:
                        if relay:
                            await self._read_status(client)
                        try:
                            await asyncio.wait_for(gone.wait(), timeout=2.0)
                        except asyncio.TimeoutError:
                            pass
            except Exception as e:  # noqa: BLE001
                self.link.emit("error", f"{type(e).__name__}: {e}")
            self.link.emit("disconnected", "reconnecting")
            await asyncio.sleep(1.0)

    async def _read_status(self, client):
        try:
            raw = await client.read_gatt_char(p.RELAY_STATUS_UUID)
            self.status.emit(json.loads(raw))
        except Exception:  # noqa: BLE001 -- status is informational
            pass

    async def _demo(self):
        """Synthetic wheel: plausible vitals drift and a real pulse shape,
        pushed through encode -> 20-byte chunks -> deframer."""
        self.connected.emit(time.time(), "demo")
        self.link.emit("connected", "synthetic data")
        deframer, seq, t0 = p.Deframer(), 0, time.monotonic()
        bpm, spo2 = 72.0, 97.0
        while not self._stop:
            bpm = min(110, max(55, bpm + random.uniform(-1.5, 1.5)))
            spo2 = min(100, max(92, spo2 + random.choice((-1, 0, 0, 0, 1))))
            finger = seq % 45 < 42          # periodically lift the finger
            start = int((time.monotonic() - t0) * 1000)
            samples = []
            for n in range(8):
                dt = n * 125
                phase = 2 * math.pi * (bpm / 60) * (start + dt) / 1000
                ac = 1800 * (math.sin(phase) + 0.35 * math.sin(2 * phase + 0.9))
                dc = 120000 if finger else 8000
                samples.append(p.Sample(dt, int(dc * 0.8 + ac * 0.7), int(dc + ac)))
            flags = (p.FLAG_HR_VALID | p.FLAG_SPO2_VALID | p.FLAG_IN_RANGE | p.FLAG_FINGER) if finger else 0
            raw = p.encode(seq, start, start + 1000,
                           round(bpm) if finger else -999, round(spo2) if finger else -999,
                           flags, samples)
            for i in range(0, len(raw), 20):         # default-MTU chunking
                self._emit_frames(deframer, raw[i:i + 20])
            seq += 1
            await asyncio.sleep(1.0)


# =========================================================================
# UI
# =========================================================================

def label(text, size=10, color=MUTED, bold=False, mono=False):
    w = QLabel(text)
    f = QFont("JetBrains Mono" if mono else "Inter")
    f.setPointSize(size)
    f.setBold(bold)
    w.setFont(f)
    w.setStyleSheet(f"color:{color};")
    return w


class Tile(QFrame):
    """Big-number readout: current value, 5-point average, unit."""

    def __init__(self, title, unit, color):
        super().__init__()
        self.color = color
        self.setStyleSheet(f"background:{PANEL}; border-radius:8px;")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(18, 14, 18, 14)
        lay.setSpacing(2)
        lay.addWidget(label(title.upper(), 9, MUTED, True))
        row = QHBoxLayout()
        self.value = label("--", 44, color, True, mono=True)
        row.addWidget(self.value)
        row.addWidget(label(unit, 12, MUTED), alignment=Qt.AlignBottom)
        row.addStretch()
        lay.addLayout(row)
        self.avg = label("5-pt avg --", 10, MUTED, mono=True)
        lay.addWidget(self.avg)

    def show(self, value, avg, live):
        self.value.setText("--" if value is None else str(value))
        self.value.setStyleSheet(f"color:{self.color if live else GRID};")
        self.avg.setText("5-pt avg --" if avg is None else f"5-pt avg {avg:.1f}")


def make_plot(title, color, y_range=None):
    w = pg.PlotWidget(axisItems={"bottom": pg.DateAxisItem()})
    w.setBackground(PANEL)
    w.setTitle(f"<span style='color:{MUTED};font-size:10pt'>{title}</span>")
    w.showGrid(x=True, y=True, alpha=0.15)
    for ax in ("left", "bottom"):
        w.getAxis(ax).setPen(GRID)
        w.getAxis(ax).setTextPen(MUTED)
    if y_range:
        w.setYRange(*y_range, padding=0.05)
    w.setMouseEnabled(x=False, y=True)
    fill = QColor(color)
    fill.setAlpha(40)
    # connect="finite": an unusable second (NaN) breaks the line instead of
    # being drawn as a spike to -999.
    curve = w.plot(pen=pg.mkPen(color, width=2), connect="finite",
                   fillLevel=y_range[0] if y_range else None, brush=fill if y_range else None)
    return w, curve


class Viewer(QMainWindow):
    def __init__(self, mode):
        super().__init__()
        self.mode = mode
        self.setWindowTitle("PPG Monitor")
        self.resize(1280, 860)

        self.t, self.bpm, self.spo2 = (deque(maxlen=HISTORY_S * 2) for _ in range(3))
        self.wave_t, self.wave_ir = deque(maxlen=WAVE_S * 8), deque(maxlen=WAVE_S * 8)
        self.avg_bpm, self.avg_spo2 = p.MovingAverage(5), p.MovingAverage(5)
        self.seq = p.SeqTracker()
        self.rx = 0
        self.connected_at = None
        self.last_rx = None
        self.crc_errors = 0
        self.first_rx = None

        root = QWidget()
        root.setStyleSheet(f"background:{BG};")
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(16, 14, 16, 12)
        outer.setSpacing(12)

        # --- connection bar -------------------------------------------------
        bar = QHBoxLayout()
        self.pill = label("● starting", 11, WARN_C, True)
        bar.addWidget(self.pill)
        self.detail = label("", 10, MUTED, mono=True)
        bar.addWidget(self.detail)
        bar.addStretch()
        src = {"relay": "via Raspberry Pi", "direct": "ESP32 direct", "demo": "demo data"}[mode]
        bar.addWidget(label(src, 10, MUTED))
        outer.addLayout(bar)

        times = QGridLayout()
        times.setHorizontalSpacing(28)
        times.addWidget(label("CONNECTED AT", 8, MUTED, True), 0, 0)
        times.addWidget(label("CONNECTED FOR", 8, MUTED, True), 0, 1)
        times.addWidget(label("ESP32 → PI LINK" if mode == "relay" else "DEVICE", 8, MUTED, True), 0, 2)
        times.addWidget(label("LAST PACKET", 8, MUTED, True), 0, 3)
        self.conn_at = label("--", 12, INK, mono=True)
        self.conn_for = label("--", 12, INK, mono=True)
        self.esp_link = label("--", 12, INK, mono=True)
        self.last_pkt = label("--", 12, INK, mono=True)
        for i, w in enumerate((self.conn_at, self.conn_for, self.esp_link, self.last_pkt)):
            times.addWidget(w, 1, i)
        times.setColumnStretch(4, 1)
        outer.addLayout(times)

        # --- readouts -------------------------------------------------------
        tiles = QHBoxLayout()
        tiles.setSpacing(12)
        self.bpm_tile = Tile("Heart rate", "BPM", BPM_C)
        self.spo2_tile = Tile("Oxygen saturation", "% SpO₂", SPO2_C)
        tiles.addWidget(self.bpm_tile)
        tiles.addWidget(self.spo2_tile)
        state = QFrame()
        state.setStyleSheet(f"background:{PANEL}; border-radius:8px;")
        sl = QVBoxLayout(state)
        sl.setContentsMargins(18, 14, 18, 14)
        sl.addWidget(label("SIGNAL", 9, MUTED, True))
        self.finger = label("--", 16, INK, True)
        sl.addWidget(self.finger)
        self.stats = label("", 10, MUTED, mono=True)
        sl.addWidget(self.stats)
        sl.addStretch()
        tiles.addWidget(state)
        outer.addLayout(tiles)

        # --- charts + packet log ---------------------------------------------
        split = QSplitter(Qt.Horizontal)
        charts = QWidget()
        cl = QVBoxLayout(charts)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(10)
        self.bpm_plot, self.bpm_curve = make_plot("Heart rate (BPM)", BPM_C, (40, 140))
        self.spo2_plot, self.spo2_curve = make_plot("SpO₂ (%)", SPO2_C, (85, 100))
        self.wave_plot, self.wave_curve = make_plot("PPG waveform — IR, 8 samples/packet", WAVE_C)
        for w in (self.bpm_plot, self.spo2_plot, self.wave_plot):
            cl.addWidget(w)
        split.addWidget(charts)

        self.table = QTableWidget(0, 7)
        self.table.setHorizontalHeaderLabels(["Received", "Seq", "BPM", "SpO₂", "Finger", "Samples", "CRC"])
        self.table.verticalHeader().hide()
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setSelectionMode(QTableWidget.NoSelection)
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeToContents)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setStyleSheet(
            f"QTableWidget{{background:{PANEL};color:{INK};gridline-color:{GRID};border:none;"
            f"font-family:'JetBrains Mono';font-size:9pt;}}"
            f"QHeaderView::section{{background:{BG};color:{MUTED};border:none;padding:4px;}}")
        split.addWidget(self.table)
        split.setSizes([800, 480])
        outer.addWidget(split, 1)

        # --- worker thread -------------------------------------------------
        self.thread = QThread()
        self.worker = Worker(mode)
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.run)
        self.worker.frame.connect(self.on_frame)
        self.worker.link.connect(self.on_link)
        self.worker.connected.connect(self.on_connected)
        self.worker.status.connect(self.on_status)
        self.worker.counters.connect(self.on_counters)
        self.thread.start()

        self.tick = QTimer(self)
        self.tick.timeout.connect(self.refresh_clock)
        self.tick.start(500)

    # ----------------------------------------------------------- slots ----
    def on_link(self, state, detail):
        color = {"connected": OK_C, "error": BAD_C, "disconnected": BAD_C}.get(state, WARN_C)
        self.pill.setText(f"● {state}")
        self.pill.setStyleSheet(f"color:{color};")
        self.detail.setText(detail)
        if state in ("disconnected", "error"):
            self.connected_at = None

    def on_connected(self, ts, addr):
        self.connected_at = ts
        if self.mode != "relay":
            self.esp_link.setText(addr)
        self.conn_at.setText(datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S"))

    def on_status(self, st):
        if self.mode != "relay":
            return
        if st.get("esp") and st.get("esp_since"):
            since = datetime.fromtimestamp(st["esp_since"]).strftime("%H:%M:%S")
            self.esp_link.setText(f"up since {since}")
            self.esp_link.setStyleSheet(f"color:{OK_C};")
        else:
            self.esp_link.setText("ESP32 not connected")
            self.esp_link.setStyleSheet(f"color:{BAD_C};")

    def on_counters(self, crc_errors, _dropped):
        self.crc_errors = crc_errors

    def on_frame(self, f: p.Frame, rx: float):
        self.rx += 1
        self.last_rx = rx
        self.first_rx = self.first_rx or rx
        self.seq.update(f.seq)
        usable = f.usable
        if usable:
            self.avg_bpm.add(f.heart_rate)
            self.avg_spo2.add(f.spo2)

        self.t.append(rx)
        self.bpm.append(f.heart_rate if usable else np.nan)
        self.spo2.append(f.spo2 if usable else np.nan)
        # Place the 8 samples on the laptop clock using the ESP32's own spacing.
        for s in f.samples:
            self.wave_t.append(rx - 1.0 + s.dt_ms / 1000)
            self.wave_ir.append(s.ir if f.finger else np.nan)

        self.bpm_tile.show(f.heart_rate if usable else None, self.avg_bpm.value, usable)
        self.spo2_tile.show(f.spo2 if usable else None, self.avg_spo2.value, usable)
        if not f.finger:
            self.finger.setText("No finger on sensor")
            self.finger.setStyleSheet(f"color:{WARN_C};")
        elif not usable:
            self.finger.setText("Settling…")
            self.finger.setStyleSheet(f"color:{WARN_C};")
        else:
            self.finger.setText("Good signal")
            self.finger.setStyleSheet(f"color:{OK_C};")

        t = np.fromiter(self.t, float)
        self.bpm_curve.setData(t, np.fromiter(self.bpm, float))
        self.spo2_curve.setData(t, np.fromiter(self.spo2, float))
        for plot in (self.bpm_plot, self.spo2_plot):
            plot.setXRange(rx - HISTORY_S, rx, padding=0)
        self.wave_curve.setData(np.fromiter(self.wave_t, float), np.fromiter(self.wave_ir, float))
        self.wave_plot.setXRange(rx - WAVE_S, rx, padding=0)

        self.table.insertRow(0)
        cells = [datetime.fromtimestamp(rx).strftime("%H:%M:%S.%f")[:-3], str(f.seq),
                 str(f.heart_rate) if usable else "--", str(f.spo2) if usable else "--",
                 "yes" if f.finger else "no", str(len(f.samples)), "✓"]
        for c, text in enumerate(cells):
            item = QTableWidgetItem(text)
            if c == 6:
                item.setForeground(QColor(OK_C))
            self.table.setItem(0, c, item)
        if self.table.rowCount() > TABLE_ROWS:
            self.table.removeRow(TABLE_ROWS)
        self.refresh_clock()

    def refresh_clock(self):
        now = time.time()
        if self.connected_at:
            s = int(now - self.connected_at)
            self.conn_for.setText(f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}")
        else:
            self.conn_for.setText("--")
        if self.last_rx:
            age = now - self.last_rx
            self.last_pkt.setText(f"{age:.1f} s ago")
            self.last_pkt.setStyleSheet(f"color:{OK_C if age < 2.5 else BAD_C};")
        rate = (self.rx - 1) / (now - self.first_rx) if self.first_rx and now > self.first_rx + 1 else 0
        self.stats.setText(f"packets {self.rx}   rate {rate:.2f}/s\n"
                           f"lost {self.seq.lost}   CRC errors {self.crc_errors}")

    def closeEvent(self, e):
        self.worker.stop()
        self.thread.quit()
        self.thread.wait(5000)
        super().closeEvent(e)


def main():
    ap = argparse.ArgumentParser(description="Live PPG viewer")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--direct", action="store_true", help="connect straight to the ESP32")
    g.add_argument("--demo", action="store_true", help="synthetic data, no Bluetooth")
    args = ap.parse_args()
    mode = "demo" if args.demo else "direct" if args.direct else "relay"

    pg.setConfigOptions(antialias=True)
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    pal = QPalette()
    for role, c in ((QPalette.Window, BG), (QPalette.Base, PANEL), (QPalette.Text, INK),
                    (QPalette.WindowText, INK), (QPalette.Button, PANEL), (QPalette.ButtonText, INK)):
        pal.setColor(role, QColor(c))
    app.setPalette(pal)
    w = Viewer(mode)
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
