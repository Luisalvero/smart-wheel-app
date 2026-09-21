"""Recovery for BLE links orphaned in BlueZ.

If a process holding a BLE connection dies (crash, kill, core dump), BlueZ can
keep the link open with no owner. Measured on this project: the ESP32 stayed
"Connected: yes" in BlueZ minutes after the owning process was gone. A
peripheral that believes it has a client stops advertising, so every later
scan comes up empty and the system is stuck until the link is closed by hand.

On the Pi this would be a silent, permanent outage: systemd restarts a crashed
relay, but the relay can never find the ESP32 again. release_orphaned() closes
such links. Callers use it only after a scan fails to find the device, so a
connection that is actually working is never touched.

Shared by the Pi relay and the laptop viewer; keep the copies identical
(tests/test_protocol.py checks this).
"""

import logging

from dbus_fast import BusType
from dbus_fast.aio import MessageBus

log = logging.getLogger("bluez")


async def release_orphaned(service_uuid: str) -> list[str]:
    """Disconnects BlueZ devices that are connected and expose `service_uuid`.

    Returns the addresses released. Never raises: this is a recovery path, and a
    failure here must not stop the caller from simply scanning again.
    """
    released: list[str] = []
    bus = None
    try:
        bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        root = bus.get_proxy_object("org.bluez", "/", await bus.introspect("org.bluez", "/"))
        objects = await root.get_interface("org.freedesktop.DBus.ObjectManager").call_get_managed_objects()
        want = service_uuid.lower()
        for path, ifaces in objects.items():
            dev = ifaces.get("org.bluez.Device1")
            if not dev or not dev.get("Connected") or not dev["Connected"].value:
                continue
            uuids = [u.lower() for u in dev["UUIDs"].value] if "UUIDs" in dev else []
            if want not in uuids:
                continue
            proxy = bus.get_proxy_object("org.bluez", path, await bus.introspect("org.bluez", path))
            await proxy.get_interface("org.bluez.Device1").call_disconnect()
            released.append(dev["Address"].value)
            log.warning("closed orphaned BLE link to %s", dev["Address"].value)
    except Exception as e:  # noqa: BLE001 -- recovery must never take the caller down
        log.debug("orphan check failed: %r", e)
    finally:
        if bus:
            bus.disconnect()
    return released
