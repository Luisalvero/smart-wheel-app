#!/usr/bin/env python3
"""Raspberry Pi PPG relay: ESP32 --BLE--> Pi (log) --BLE--> laptop.

One asyncio process does three jobs:

  1. BLE central to the ESP32 (bleak). Reassembles and CRC-checks frames.
  2. BLE peripheral to the laptop (BlueZ GATT server over dbus-fast). Forwards
     every verified frame byte-for-byte, so the laptop re-verifies the same
     CRC end to end; the Pi cannot corrupt data without the laptop noticing.
  3. Logger. Appends CSV rows and keeps latest_ppg.json current.

dbus-fast is already a dependency of bleak on Linux, so the GATT server adds no
packages, and everything shares one event loop -- no threads, no GLib.

Run:  python3 ppg_relay.py            (normally started by systemd)
      python3 ppg_relay.py --no-relay (log only; no laptop link)
"""

import argparse
import asyncio
import csv
import json
import logging
import os
import signal
import sys
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from bleak import BleakClient, BleakScanner
from dbus_fast import BusType, Message, MessageType, Variant
from dbus_fast.aio import MessageBus
from dbus_fast.service import PropertyAccess, ServiceInterface, dbus_property, method

import ppg_protocol as p
from bluez_links import release_orphaned

log = logging.getLogger("relay")

BLUEZ = "org.bluez"
APP_PATH = "/org/ppgrelay"
ADV_PATH = "/org/ppgrelay/advert0"
AGENT_PATH = "/org/ppgrelay/agent"
SERVICE_PATH = APP_PATH + "/service0"
RETRY_MAX_S = 15          # longest pause between ESP32 attempts
STABLE_LINK_S = 30        # a link this long resets the backoff
GATT_RETRY_S = 5          # retry interval for the phone-side service
FRAME_CHAR_PATH = SERVICE_PATH + "/char0"
STATUS_CHAR_PATH = SERVICE_PATH + "/char1"


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


class EventBuffer(logging.Handler):
    """Keeps recent INFO+ log lines so the terminal dashboard can show them.
    Every existing log call becomes a dashboard event for free."""

    def __init__(self, events: deque):
        super().__init__(level=logging.INFO)
        self.events = events

    def emit(self, record):
        self.events.append({"t": record.created, "level": record.levelname, "msg": record.getMessage()})


# =========================================================================
# BlueZ GATT server objects (dbus-fast). Signatures are D-Bus type strings.
# =========================================================================

class GattService(ServiceInterface):
    def __init__(self, uuid):
        super().__init__("org.bluez.GattService1")
        self._uuid = uuid

    @dbus_property(access=PropertyAccess.READ)
    def UUID(self) -> "s":
        return self._uuid

    @dbus_property(access=PropertyAccess.READ)
    def Primary(self) -> "b":
        return True


class GattCharacteristic(ServiceInterface):
    """Read/notify characteristic whose value is pushed with set_value()."""

    def __init__(self, uuid, flags, on_read=None):
        super().__init__("org.bluez.GattCharacteristic1")
        self._uuid = uuid
        self._flags = flags
        self._value = b""
        self._on_read = on_read
        self.notifying = False

    @dbus_property(access=PropertyAccess.READ)
    def UUID(self) -> "s":
        return self._uuid

    @dbus_property(access=PropertyAccess.READ)
    def Service(self) -> "o":
        return SERVICE_PATH

    @dbus_property(access=PropertyAccess.READ)
    def Flags(self) -> "as":
        return self._flags

    @dbus_property(access=PropertyAccess.READ)
    def Notifying(self) -> "b":
        return self.notifying

    @dbus_property(access=PropertyAccess.READ)
    def Value(self) -> "ay":
        return self._value

    @method()
    def ReadValue(self, options: "a{sv}") -> "ay":
        if self._on_read:
            self._on_read(options)
        offset = options["offset"].value if "offset" in options else 0
        return self._value[offset:]

    @method()
    def StartNotify(self):
        if not self.notifying:
            self.notifying = True
            log.info("phone/laptop subscribed to %s", "frames" if self._uuid == p.RELAY_FRAME_UUID else self._uuid[:8])

    @method()
    def StopNotify(self):
        if self.notifying:
            self.notifying = False
            log.info("phone/laptop unsubscribed from %s", "frames" if self._uuid == p.RELAY_FRAME_UUID else self._uuid[:8])

    def set_value(self, value: bytes, notify: bool = True):
        self._value = bytes(value)
        if notify and self.notifying:
            # BlueZ turns a Value PropertiesChanged into an ATT notification.
            self.emit_properties_changed({"Value": self._value})


class Advertisement(ServiceInterface):
    def __init__(self, name, service_uuid):
        super().__init__("org.bluez.LEAdvertisement1")
        self._name = name
        self._uuid = service_uuid

    @dbus_property(access=PropertyAccess.READ)
    def Type(self) -> "s":
        return "peripheral"

    @dbus_property(access=PropertyAccess.READ)
    def ServiceUUIDs(self) -> "as":
        return [self._uuid]

    @dbus_property(access=PropertyAccess.READ)
    def LocalName(self) -> "s":
        return self._name

    @method()
    def Release(self):
        log.info("advertisement released by BlueZ")


class JustWorksAgent(ServiceInterface):
    """NoInputNoOutput pairing agent.

    If a central asks to pair and no agent answers, BlueZ fails the pairing and
    the central drops the link -- the exact failure that broke the iPhone
    prototype's connection. Registering an agent makes pairing succeed silently.
    """

    def __init__(self):
        super().__init__("org.bluez.Agent1")

    @method()
    def Release(self):
        pass

    @method()
    def RequestPinCode(self, device: "o") -> "s":
        return "0000"

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s"):
        pass

    @method()
    def RequestPasskey(self, device: "o") -> "u":
        return 0

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):
        pass

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u"):
        pass

    @method()
    def RequestAuthorization(self, device: "o"):
        pass

    @method()
    def AuthorizeService(self, device: "o", uuid: "s"):
        pass

    @method()
    def Cancel(self):
        pass


# =========================================================================
# Logger
# =========================================================================

class Logger:
    """CSV + JSON output. Files stay open and are flushed per row, instead of
    being reopened for every record as the previous logger did."""

    # First five columns match the original ppg_data.csv so existing tooling
    # and the startup instructions keep working.
    VITALS_HEADER = ["timestamp", "spo2", "avg_spo2", "bpm", "avg_bpm",
                     "seq", "esp_start_ms", "esp_end_ms",
                     "hr_valid", "spo2_valid", "finger", "in_range",
                     "quality", "protocol", "samples", "rate_hz"]
    SAMPLES_HEADER = ["timestamp", "seq", "index", "esp_ms", "red", "ir"]

    def __init__(self, folder: Path, log_raw: bool = False):
        # Owner-only access. The proposal's cybersecurity section requires
        # stored health data to have restricted permissions; the process also
        # runs with umask 077 (see main), so every file created here is 0600.
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        folder.chmod(0o700)
        self.folder = folder
        self.json_path = folder / "latest_ppg.json"
        self._vitals_f, self._vitals = self._open(folder / "ppg_data.csv", self.VITALS_HEADER)
        # Raw PPG is opt-in. The proposal (data-handling Option 3) commits to
        # storing only necessary processed values and not retaining raw PPG
        # waveforms, so raw samples are logged only when explicitly requested
        # for development and validation.
        self._samples_f = self._samples = None
        if log_raw:
            self._samples_f, self._samples = self._open(folder / "ppg_samples.csv", self.SAMPLES_HEADER)

    @staticmethod
    def _open(path: Path, header):
        # A file written by the old logger has a different header. Appending new
        # rows to it would produce a CSV with inconsistent columns, so it is
        # moved aside once instead of being overwritten or silently mixed.
        if path.exists() and path.stat().st_size:
            with path.open(newline="") as f:
                existing = next(csv.reader(f), [])
            if existing != header:
                backup = path.with_name(f"{path.stem}.{datetime.now():%Y%m%d_%H%M%S}.old.csv")
                path.rename(backup)
                log.warning("CSV header changed; previous file kept as %s", backup.name)
        new = not path.exists() or path.stat().st_size == 0
        f = path.open("a", newline="", buffering=1)
        w = csv.writer(f)
        if new:
            w.writerow(header)
        return f, w

    def write(self, ts: str, frame: p.Frame, avg_bpm, avg_spo2):
        usable = frame.usable
        blank = lambda v: v if usable else ""  # noqa: E731 -- never log -999 as a vital
        self._vitals.writerow([
            ts, blank(frame.spo2), "" if avg_spo2 is None else f"{avg_spo2:.1f}",
            blank(frame.heart_rate), "" if avg_bpm is None else f"{avg_bpm:.1f}",
            frame.seq, frame.start_ms, frame.end_ms,
            int(frame.hr_valid), int(frame.spo2_valid), int(frame.finger), int(frame.in_range),
            frame.quality, frame.version, len(frame.samples), frame.rate_hz,
        ])
        self._vitals_f.flush()
        if self._samples is not None:
            self._samples.writerows(
                [ts, frame.seq, i, (frame.start_ms + s.dt_ms) & 0xFFFFFFFF, s.red, s.ir]
                for i, s in enumerate(frame.samples)
            )
            self._samples_f.flush()

        record = {"timestamp": ts, "seq": frame.seq,
                  "spo2": frame.spo2 if usable else None, "avg_spo2": avg_spo2,
                  "bpm": frame.heart_rate if usable else None, "avg_bpm": avg_bpm,
                  "finger": frame.finger, "usable": usable}
        tmp = self.json_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(record))
        os.replace(tmp, self.json_path)  # atomic: readers never see half a file

    def close(self):
        for f in (self._vitals_f, self._samples_f):
            if f is not None:
                f.close()


# =========================================================================
# Relay
# =========================================================================

class Relay:
    def __init__(self, args):
        self.args = args
        self.logger = Logger(Path(args.log_dir).expanduser(), log_raw=args.log_raw)
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=600)
        self.stopping = asyncio.Event()

        self.seq = p.SeqTracker()
        self.avg_bpm = p.MovingAverage(5)
        self.avg_spo2 = p.MovingAverage(5)
        self.frames_rx = 0
        self.bytes_rx = 0
        self.last_frame_info: dict | None = None
        self.crc_errors = 0
        self.started_at = time.time()

        self.esp_addr = None
        self.esp_connected_at = None

        # ---- live state for the terminal dashboard (ppg_monitor.py) ----
        # Written to RAM (systemd RuntimeDirectory -> /run/ppg-relay, tmpfs),
        # never to the SD card, and owner-only like every other file here.
        run_dir = os.environ.get("RUNTIME_DIRECTORY") or f"/tmp/ppg-relay-{os.getuid()}"
        self.state_path = Path(run_dir) / "state.json"
        self.state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.esp_state = "starting"            # scanning | connecting | connected
        self.clients: dict[str, dict] = {}     # phones/laptops connected to us
        self.forwarded = 0
        self.rows_logged = 0
        self.last_frame_at = None
        self.recent: deque = deque(maxlen=30)
        self.bpm_trend: deque = deque(maxlen=120)
        self.spo2_trend: deque = deque(maxlen=120)
        self.events: deque = deque(maxlen=60)
        for name in ("relay", "bluez"):
            logging.getLogger(name).addHandler(EventBuffer(self.events))

        self.bus: MessageBus | None = None
        self.adapter_path = None
        self.frame_char = GattCharacteristic(p.RELAY_FRAME_UUID, ["read", "notify"])
        self.status_char = GattCharacteristic(p.RELAY_STATUS_UUID, ["read"], on_read=self._on_status_read)
        self.advert = Advertisement(p.RELAY_NAME, p.RELAY_SERVICE_UUID)
        # Notification payload limit toward the laptop. Starts at the BLE
        # minimum and is raised when BlueZ reports the exchanged MTU in a
        # ReadValue call; the laptop reads status right after connecting.
        self.link_mtu = 23

    # ---------------------------------------------------------- status ----
    def status_bytes(self) -> bytes:
        return json.dumps({
            "v": p.VERSION, "esp": self.esp_connected_at is not None,
            "addr": self.esp_addr, "esp_since": self.esp_connected_at,
            "rx": self.frames_rx, "crc": self.crc_errors,
            "lost": self.seq.lost, "rst": self.seq.resets, "up": round(self.started_at),
        }, separators=(",", ":")).encode()

    def _on_status_read(self, options):
        if "mtu" in options:  # documented BlueZ option, server side only
            mtu = int(options["mtu"].value)
            if mtu != self.link_mtu:
                self.link_mtu = mtu
                log.info("laptop link MTU %d", mtu)
        self.status_char.set_value(self.status_bytes(), notify=False)

    # ------------------------------------------------------- ESP32 side ----
    def _on_esp_data(self, deframer: p.Deframer, _char, data: bytearray):
        self.bytes_rx += len(data)
        before = deframer.crc_errors
        frames = deframer.feed(data)
        self.crc_errors += deframer.crc_errors - before
        ts = now_iso()
        for f in frames:
            missing = self.seq.update(f.seq)
            if missing:
                log.warning("%d frame(s) lost before seq %d", missing, f.seq)
            self.frames_rx += 1
            self.last_frame_info = {"version": f.version, "samples": len(f.samples),
                                    "rate_hz": f.rate_hz, "bytes": len(f.raw),
                                    "quality": f.quality}
            if f.usable:
                self.avg_bpm.add(f.heart_rate)
                self.avg_spo2.add(f.spo2)
            forwarded = self._forward(f.raw)
            self.last_frame_at = time.time()
            self.recent.append({
                "t": self.last_frame_at, "seq": f.seq,
                "bpm": f.heart_rate if f.usable else None,
                "spo2": f.spo2 if f.usable else None,
                "finger": f.finger, "usable": f.usable,
                "missing": missing, "fwd": forwarded,
            })
            self.bpm_trend.append(f.heart_rate if f.usable else None)
            self.spo2_trend.append(f.spo2 if f.usable else None)
            try:
                self.queue.put_nowait((ts, f, self.avg_bpm.value, self.avg_spo2.value))
            except asyncio.QueueFull:
                log.error("log queue full; dropping row for seq %d", f.seq)

    def _forward(self, raw: bytes) -> bool:
        """Returns True if a subscribed client was sent the frame."""
        if not self.frame_char.notifying:
            self.frame_char.set_value(raw, notify=False)
            return False
        chunk = max(20, min(len(raw), self.link_mtu - 3))
        for off in range(0, len(raw), chunk):
            self.frame_char.set_value(raw[off:off + chunk])
        self.forwarded += 1
        return True

    async def esp_loop(self):
        def is_wheel(_dev, adv):
            return p.ESP32_SERVICE_UUID in (u.lower() for u in adv.service_uuids)

        # Consecutive attempts that failed or dropped within seconds. The Pi 5
        # shares ONE radio and antenna between Wi-Fi and Bluetooth (Infineon
        # CYW43455), so a tight scan/connect retry loop starves Wi-Fi -- seen
        # on the bench as Wi-Fi glitching whenever Bluetooth was on. Backing off
        # keeps the radio mostly free while the ESP32 is absent or marginal.
        failures = 0

        async def backoff():
            delay = min(RETRY_MAX_S, 2 ** min(failures, 4))
            if failures > 1:
                log.info("ESP32 retry in %d s (%d failed attempts)", delay, failures)
            try:
                await asyncio.wait_for(self.stopping.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

        while not self.stopping.is_set():
            self.esp_state = "scanning"
            log.info("scanning for ESP32 (%s)", p.ESP32_SERVICE_UUID[:8])
            device = await BleakScanner.find_device_by_filter(is_wheel, timeout=10.0)
            if device is None:
                # An ESP32 still tied to a dead connection (e.g. after this
                # service crashed and systemd restarted it) never advertises.
                released = await release_orphaned(p.ESP32_SERVICE_UUID)
                if released:
                    # Remember it's the ESP32 before its Connected=false signal
                    # arrives, so _on_bus_signal doesn't mistake it for the laptop.
                    self.esp_addr = released[0]
                    continue          # released; rescan immediately
                log.info("ESP32 not found")
                failures += 1
                await backoff()
                continue

            # Recorded before connecting: BlueZ emits Device1.Connected for this
            # address during the handshake, and _on_bus_signal must already know
            # it is the ESP32 rather than the laptop.
            self.esp_addr = device.address
            self.esp_state = "connecting"
            gone = asyncio.Event()
            deframer = p.Deframer()   # fresh per connection: no half-frame carries over
            try:
                async with BleakClient(device, timeout=20.0,
                                       disconnected_callback=lambda _c: gone.set()) as client:
                    self.esp_connected_at = time.time()
                    self.esp_state = "connected"
                    log.info("ESP32 %s connected", device.address)
                    await client.start_notify(
                        p.ESP32_TX_UUID,
                        lambda c, d: self._on_esp_data(deframer, c, d))
                    # Wait on the disconnect event instead of polling every
                    # second, so a drop is noticed and retried immediately.
                    # BlueZ can report Connected=false for an attempt it
                    # retried during the handshake, and bleak 3 passes that to
                    # disconnected_callback even though the link is up. Acting
                    # on it made the relay hang up (HCI 0x13) ~3 s after every
                    # connect, which was the endless reconnect loop. The link
                    # counts as lost only when the client agrees.
                    while not self.stopping.is_set():
                        stop = asyncio.create_task(self.stopping.wait())
                        lost = asyncio.create_task(gone.wait())
                        await asyncio.wait({stop, lost}, return_when=asyncio.FIRST_COMPLETED)
                        stop.cancel()
                        lost.cancel()
                        if not gone.is_set():
                            break                 # stopping
                        await asyncio.sleep(0.5)  # let BlueZ settle the property
                        if not client.is_connected:
                            break
                        log.info("ignored stale disconnect event; ESP32 link is up")
                        gone.clear()
            except Exception as e:  # noqa: BLE001 -- any BLE failure means reconnect
                log.warning("ESP32 link error: %r", e)
                # Seen on the Pi after a service restart: the ESP32 advertised
                # (so the scan found it) while BlueZ still held a dead link to
                # it as "Connected: yes", and every connect timed out. This
                # process holds no client here, so any BlueZ link to the ESP32
                # is dead and safe to close.
                if await release_orphaned(p.ESP32_SERVICE_UUID):
                    failures = 0
            finally:
                lasted = time.time() - self.esp_connected_at if self.esp_connected_at else 0.0
                if self.esp_connected_at is not None:
                    log.info("ESP32 disconnected after %.0f s", lasted)
                self.esp_connected_at = None
                self.esp_state = "scanning"
            # A link that held for a while was a success: retry fast. One that
            # failed or dropped within seconds points at a marginal radio path,
            # where hammering only makes Wi-Fi coexistence worse.
            failures = 0 if lasted >= STABLE_LINK_S else failures + 1
            if not self.stopping.is_set():
                await backoff()

    # ----------------------------------------------------------- writer ----
    async def writer_loop(self):
        while True:
            ts, frame, avg_bpm, avg_spo2 = await self.queue.get()
            try:
                # File I/O off the event loop so a slow SD card can never delay
                # a BLE notification.
                await asyncio.to_thread(self.logger.write, ts, frame, avg_bpm, avg_spo2)
                self.rows_logged += 1
                self.publish_state()   # dashboard sees each frame immediately
            except Exception as e:  # noqa: BLE001
                log.error("log write failed: %r", e)
            if self.args.verbose or frame.seq % 10 == 0:
                log.info("#%d bpm=%s spo2=%s avg=%s/%s finger=%d",
                         frame.seq,
                         frame.heart_rate if frame.usable else "--",
                         frame.spo2 if frame.usable else "--",
                         f"{avg_bpm:.1f}" if avg_bpm else "--",
                         f"{avg_spo2:.1f}" if avg_spo2 else "--",
                         frame.finger)

    # ------------------------------------------------------ laptop side ----
    async def start_gatt(self):
        self.bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        om = self.bus.get_proxy_object(BLUEZ, "/", await self.bus.introspect(BLUEZ, "/"))
        objects = await om.get_interface("org.freedesktop.DBus.ObjectManager").call_get_managed_objects()
        want = f"/org/bluez/{self.args.adapter}"
        if want not in objects or "org.bluez.GattManager1" not in objects[want]:
            raise RuntimeError(f"adapter {self.args.adapter} has no GATT server support")
        self.adapter_path = want
        adapter = self.bus.get_proxy_object(BLUEZ, want, await self.bus.introspect(BLUEZ, want))

        props = adapter.get_interface("org.freedesktop.DBus.Properties")
        if not (await props.call_get("org.bluez.Adapter1", "Powered")).value:
            await props.call_set("org.bluez.Adapter1", "Powered", Variant("b", True))

        self.bus.export(AGENT_PATH, JustWorksAgent())
        am = self.bus.get_proxy_object(BLUEZ, "/org/bluez", await self.bus.introspect(BLUEZ, "/org/bluez"))
        agent_mgr = am.get_interface("org.bluez.AgentManager1")
        await agent_mgr.call_register_agent(AGENT_PATH, "NoInputNoOutput")
        try:
            await agent_mgr.call_request_default_agent(AGENT_PATH)
        except Exception as e:  # noqa: BLE001 -- a desktop agent may own the default
            log.info("not default agent (%s); pairing still answered", e)

        self.bus.export(SERVICE_PATH, GattService(p.RELAY_SERVICE_UUID))
        self.bus.export(FRAME_CHAR_PATH, self.frame_char)
        self.bus.export(STATUS_CHAR_PATH, self.status_char)
        self.status_char.set_value(self.status_bytes(), notify=False)
        await adapter.get_interface("org.bluez.GattManager1").call_register_application(APP_PATH, {})
        log.info("GATT relay service registered on %s", self.args.adapter)

        self.bus.export(ADV_PATH, self.advert)
        self._adv_mgr = adapter.get_interface("org.bluez.LEAdvertisingManager1")
        await self._adv_mgr.call_register_advertisement(ADV_PATH, {})
        log.info("advertising as %s", p.RELAY_NAME)

        # Watch for the laptop disconnecting so advertising can be restored:
        # BlueZ stops broadcasting once a central connects.
        await self.bus.call(Message(
            destination="org.freedesktop.DBus", path="/org/freedesktop/DBus",
            interface="org.freedesktop.DBus", member="AddMatch", signature="s",
            body=["type='signal',interface='org.freedesktop.DBus.Properties',"
                  "member='PropertiesChanged',arg0='org.bluez.Device1'"]))
        self.bus.add_message_handler(self._on_bus_signal)

    def _on_bus_signal(self, msg: Message):
        if msg.message_type != MessageType.SIGNAL or msg.member != "PropertiesChanged":
            return False
        iface, changed = msg.body[0], msg.body[1]
        if iface != "org.bluez.Device1" or "Connected" not in changed:
            return False
        addr = msg.path.rsplit("dev_", 1)[-1].replace("_", ":")
        if addr == (self.esp_addr or "").upper():
            return False                          # that's the ESP32 link, handled by bleak
        if changed["Connected"].value:
            self.clients[addr] = {"since": time.time(), "name": addr}
            log.info("phone/laptop connected: %s", addr)
            asyncio.get_running_loop().create_task(self._client_name(msg.path, addr))
        else:
            self.clients.pop(addr, None)
            log.info("phone/laptop disconnected: %s", addr)
            self.frame_char.notifying = False
            self.link_mtu = 23
            asyncio.get_running_loop().create_task(self._readvertise())
        return False

    async def _client_name(self, path: str, addr: str):
        """Looks up the connecting device's name (e.g. "Luis's iPhone") for the
        dashboard. Informational only."""
        try:
            dev = self.bus.get_proxy_object(BLUEZ, path, await self.bus.introspect(BLUEZ, path))
            alias = (await dev.get_interface("org.freedesktop.DBus.Properties")
                     .call_get("org.bluez.Device1", "Alias")).value
            if addr in self.clients:
                self.clients[addr]["name"] = alias
                log.info("client %s is %s", addr, alias)
        except Exception:  # noqa: BLE001
            pass

    async def _readvertise(self):
        try:
            await self._adv_mgr.call_unregister_advertisement(ADV_PATH)
        except Exception:  # noqa: BLE001 -- already gone is fine
            pass
        try:
            await self._adv_mgr.call_register_advertisement(ADV_PATH, {})
            log.info("advertising resumed")
        except Exception as e:  # noqa: BLE001
            log.error("could not resume advertising: %r", e)

    def publish_state(self):
        """Atomically replaces the dashboard state file (tmpfs, owner-only)."""
        state = {
            "v": 1, "now": time.time(), "started": self.started_at,
            "host": os.uname().nodename,
            "esp": {"state": self.esp_state, "addr": self.esp_addr, "since": self.esp_connected_at},
            "advertising": not self.args.no_relay,
            "clients": [{"addr": a, **c} for a, c in self.clients.items()],
            "subscribed": self.frame_char.notifying, "mtu": self.link_mtu,
            "counters": {"rx": self.frames_rx, "crc": self.crc_errors, "lost": self.seq.lost,
                         "resets": self.seq.resets, "forwarded": self.forwarded,
                         "logged": self.rows_logged},
            "last_frame_at": self.last_frame_at,
            "frame": self.last_frame_info, "bytes_rx": self.bytes_rx,
            "avg_bpm": self.avg_bpm.value, "avg_spo2": self.avg_spo2.value,
            "recent": list(self.recent), "bpm_trend": list(self.bpm_trend),
            "spo2_trend": list(self.spo2_trend), "events": list(self.events)[-20:],
            "log_dir": str(self.logger.folder), "raw_logging": bool(self.args.log_raw),
        }
        tmp = self.state_path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(state, separators=(",", ":")))
            os.replace(tmp, self.state_path)
        except OSError as e:
            log.debug("state publish failed: %r", e)

    async def status_loop(self):
        while True:
            self.status_char.set_value(self.status_bytes(), notify=False)
            self.publish_state()
            await asyncio.sleep(1)

    async def shutdown(self):
        if self.bus and self.adapter_path:
            adapter = self.bus.get_proxy_object(
                BLUEZ, self.adapter_path, await self.bus.introspect(BLUEZ, self.adapter_path))
            for iface, call, path in (("org.bluez.LEAdvertisingManager1", "call_unregister_advertisement", ADV_PATH),
                                      ("org.bluez.GattManager1", "call_unregister_application", APP_PATH)):
                try:
                    await getattr(adapter.get_interface(iface), call)(path)
                except Exception:  # noqa: BLE001
                    pass
        self.logger.close()

    async def gatt_loop(self):
        """Brings up the phone-side service, retrying until it works.

        Bluetooth can be off or still initialising at boot (seen on the bench:
        the adapter was switched off and registration failed with
        DBusError('Failed')). Previously the relay then ran as a logger only
        until someone restarted it; now it keeps trying. Closing the D-Bus
        connection between attempts makes BlueZ drop anything half-registered.
        """
        warned = False
        while not self.stopping.is_set():
            try:
                await self.start_gatt()
                if warned:
                    log.info("phone relay is up")
                return
            except Exception as e:  # noqa: BLE001 -- logging must keep working meanwhile
                if not warned:
                    log.error("phone relay unavailable (%r); is Bluetooth on? retrying every %d s",
                              e, GATT_RETRY_S)
                    warned = True
                if self.bus:
                    self.bus.disconnect()
                    self.bus = None
            try:
                await asyncio.wait_for(self.stopping.wait(), timeout=GATT_RETRY_S)
            except asyncio.TimeoutError:
                pass

    async def run(self):
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self.stopping.set)

        log.info("logging to %s (raw samples: %s)", self.logger.folder,
                 "ON - development only" if self.args.log_raw else "off")
        tasks = [asyncio.create_task(t) for t in (self.esp_loop(), self.writer_loop(), self.status_loop())]
        if not self.args.no_relay:
            tasks.append(asyncio.create_task(self.gatt_loop()))
        await self.stopping.wait()
        log.info("stopping")
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.shutdown()


def main():
    ap = argparse.ArgumentParser(description="ESP32 PPG -> Raspberry Pi -> laptop BLE relay")
    ap.add_argument("--log-dir", default="~/PPG_Logger/logs")
    ap.add_argument("--adapter", default="hci0")
    ap.add_argument("--no-relay", action="store_true", help="log only; do not serve the laptop")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every frame")
    ap.add_argument("--log-raw", action="store_true",
                    help="also store raw red/IR samples (development only; the proposal's "
                         "data policy keeps only processed values by default)")
    args = ap.parse_args()
    os.umask(0o077)  # every log file this process creates is owner-only
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    asyncio.run(Relay(args).run())


if __name__ == "__main__":
    main()
