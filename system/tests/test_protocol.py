"""Protocol tests. Run: python3 -m unittest discover -s tests -v

The cross-language test compiles the ESP32's ppg_frame.h with the host g++ and
decodes its output with the Python decoder, so the firmware and both Python
programs cannot drift apart unnoticed.
"""

import filecmp
import random
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "common"))

import ppg_protocol as p  # noqa: E402


def good_frame(seq=1, n=8):
    return p.encode(seq, 1000, 2000, 72, 98,
                    p.FLAG_HR_VALID | p.FLAG_SPO2_VALID | p.FLAG_FINGER | p.FLAG_IN_RANGE,
                    [p.Sample(i * 125, 100000 + i, 200000 + i) for i in range(n)])


class TestCrc(unittest.TestCase):
    def test_check_value(self):
        # Published check value for CRC-16/CCITT-FALSE.
        self.assertEqual(p.crc16(b"123456789"), 0x29B1)


class TestCodec(unittest.TestCase):
    def test_size(self):
        self.assertEqual(p.FRAME_SIZE, 104)
        self.assertEqual(len(good_frame()), 104)

    def test_roundtrip(self):
        f = p.decode(good_frame(seq=7))
        self.assertEqual((f.seq, f.heart_rate, f.spo2, len(f.samples)), (7, 72, 98, 8))
        self.assertTrue(f.usable)
        self.assertEqual(f.samples[3], p.Sample(375, 100003, 200003))

    def test_invalid_reading_is_signed(self):
        raw = p.encode(1, 0, 1000, -999, -999, 0, [])
        f = p.decode(raw)
        self.assertEqual((f.heart_rate, f.spo2, f.usable), (-999, -999, False))

    def test_every_single_bit_flip_is_detected(self):
        raw = bytearray(good_frame())
        for byte in range(len(raw)):
            for bit in range(8):
                raw[byte] ^= 1 << bit
                with self.assertRaises(p.FrameError, msg=f"byte {byte} bit {bit}"):
                    p.decode(raw)
                raw[byte] ^= 1 << bit

    def test_truncated_rejected(self):
        with self.assertRaises(p.FrameError):
            p.decode(good_frame()[:-1])


class TestDeframer(unittest.TestCase):
    def test_any_chunk_size(self):
        stream = b"".join(good_frame(s) for s in range(10))
        for chunk in (1, 7, 20, 104, 244, 1000):  # 20 = default-MTU payload, 244 = MTU 247
            d = p.Deframer()
            got = []
            for i in range(0, len(stream), chunk):
                got += d.feed(stream[i:i + chunk])
            self.assertEqual([f.seq for f in got], list(range(10)), f"chunk={chunk}")
            self.assertEqual(d.crc_errors, 0)

    def test_resyncs_after_corruption_and_garbage(self):
        frames = [bytearray(good_frame(s)) for s in range(5)]
        frames[2][50] ^= 0xFF                      # corrupt frame 2
        stream = b"\x00\x5a\x13" + b"".join(frames) + b"\xa5\x5a"  # garbage around it
        got = p.Deframer().feed(stream)
        self.assertEqual([f.seq for f in got], [0, 1, 3, 4])

    def test_random_noise_never_crashes(self):
        rng = random.Random(1)
        d = p.Deframer()
        for _ in range(2000):
            d.feed(bytes(rng.randrange(256) for _ in range(rng.randrange(1, 60))))
        self.assertLessEqual(len(d._buf), d.MAX_BUFFER)


class TestSeqAndAverage(unittest.TestCase):
    def test_gap_detection(self):
        t = p.SeqTracker()
        for s in (5, 6, 9, 10):
            t.update(s)
        self.assertEqual(t.lost, 2)

    def test_wraparound_is_not_a_gap(self):
        t = p.SeqTracker()
        t.update(0xFFFFFFFF)
        self.assertEqual(t.update(0), 0)

    def test_reboot_counts_as_reset_not_loss(self):
        t = p.SeqTracker()
        t.update(500)
        t.update(0)
        self.assertEqual((t.lost, t.resets), (0, 1))

    def test_moving_average_window(self):
        m = p.MovingAverage(5)
        for v in (70, 72, 74, 76, 78, 80):
            m.add(v)
        self.assertEqual(m.value, 76.0)  # oldest (70) evicted


class TestCrossLanguage(unittest.TestCase):
    @unittest.skipUnless(shutil.which("g++"), "g++ not installed")
    def test_decodes_frames_from_the_firmware_encoder(self):
        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp) / "frame_host"
            subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-O2",
                            str(ROOT / "tests/test_frame_host.cpp"), "-o", str(exe)],
                           check=True)
            lines = subprocess.run([str(exe)], check=True, capture_output=True,
                                   text=True).stdout.split()
        self.assertEqual(lines[:2], ["CRC", "29b1"])
        a = p.decode(bytes.fromhex(lines[2]))
        self.assertEqual((a.seq, a.start_ms, a.end_ms, a.heart_rate, a.spo2), (42, 123456, 124456, 72, 98))
        self.assertTrue(a.usable)
        self.assertEqual(a.samples[7], p.Sample(875, 100007, 200049))
        b = p.decode(bytes.fromhex(lines[3]))
        self.assertEqual((b.seq, b.heart_rate, b.spo2, len(b.samples)), (0xFFFFFFFF, -999, -999, 3))
        self.assertEqual(b.samples[0].red, 0x3FFFF)   # full 18-bit ADC value survives


class TestVitalsEstimator(unittest.TestCase):
    @unittest.skipUnless(shutil.which("g++"), "g++ not installed")
    def test_heart_rate_and_spo2_on_synthetic_ppg(self):
        """ppg_vitals.h must recover known heart rates within 2 bpm from pulses
        carrying a dicrotic notch (what made Maxim's algorithm double-count),
        recover a known red/IR ratio, and reject pure noise."""
        with tempfile.TemporaryDirectory() as tmp:
            exe = Path(tmp) / "vitals_host"
            subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-O2",
                            str(ROOT / "tests/test_vitals_host.cpp"), "-o", str(exe), "-lm"],
                           check=True)
            out = subprocess.run([str(exe)], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertIn("ALL PASSED", out.stdout)


class TestCopiesInSync(unittest.TestCase):
    def test_pi_and_laptop_ship_the_same_shared_modules(self):
        for name in ("ppg_protocol.py", "bluez_links.py"):
            master = ROOT / "common" / name
            for copy in (ROOT / "pi" / name, ROOT / "laptop" / name):
                self.assertTrue(copy.exists(), f"{copy} missing")
                self.assertTrue(filecmp.cmp(master, copy, shallow=False), f"{copy} is stale")


if __name__ == "__main__":
    unittest.main(verbosity=2)
