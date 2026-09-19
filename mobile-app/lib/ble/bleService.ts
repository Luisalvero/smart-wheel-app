/**
 * BLE transport: finds the Raspberry Pi relay (or, failing that, the ESP32
 * itself), subscribes to frames and reports link state. Assigns bytes no
 * meaning -- decoding lives in protocol.ts.
 *
 * Scan preference: the Pi relay if it is advertising, since that is the real
 * system path (ESP32 -> Pi -> phone). The ESP32 is accepted as a fallback so
 * the phone can still be tested without the Pi. Both send identical frames,
 * because the Pi forwards the ESP32's bytes unchanged.
 */
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State, type Device, type Subscription } from 'react-native-ble-plx';

import {
  ESP32_SERVICE_UUID,
  ESP32_TX_UUID,
  RELAY_FRAME_UUID,
  RELAY_SERVICE_UUID,
  RELAY_STATUS_UUID,
  base64ToBytes,
} from './protocol';

export type ConnectionState =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'discovering'
  | 'connected'
  | 'disconnected'
  | 'failed';

export type Source = 'relay' | 'esp32';

/** What the Pi reports about its own link to the ESP32. */
export type RelayStatus = {
  esp: boolean;
  espSince: number | null; // unix seconds
  rx: number;
  crc: number;
  lost: number;
};

export type BleCallbacks = {
  onStateChange: (state: ConnectionState, error?: string) => void;
  onConnected: (info: { source: Source; name: string; id: string; at: Date }) => void;
  onBytes: (bytes: Uint8Array) => void;
  onRelayStatus: (status: RelayStatus) => void;
};

let manager: BleManager | null = null;
export function getManager(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

async function requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS prompts from Info.plist
  const api = typeof Platform.Version === 'number' ? Platform.Version : 0;
  if (api < 31) {
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    return r === PermissionsAndroid.RESULTS.GRANTED;
  }
  const r = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ]);
  return Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

function utf8(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return s;
}

export class WheelConnection {
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly cb: BleCallbacks) {}

  async connect(scanMs = 12000): Promise<void> {
    await this.disconnect();
    if (!(await requestPermissions())) {
      this.cb.onStateChange('failed', 'Bluetooth permission denied.');
      return;
    }
    const ble = getManager();
    const state = await ble.state();
    if (state !== State.PoweredOn) {
      this.cb.onStateChange(
        'failed',
        state === State.Unauthorized
          ? 'Bluetooth permission was denied. Enable it in Settings.'
          : 'Bluetooth is off. Turn it on and try again.',
      );
      return;
    }

    this.cb.onStateChange('scanning');
    let found: { device: Device; source: Source };
    try {
      found = await this.scan(ble, scanMs);
    } catch (e) {
      this.cb.onStateChange('failed', e instanceof Error ? e.message : String(e));
      return;
    }

    try {
      this.cb.onStateChange('connecting');
      // requestMTU: iOS negotiates its own MTU and ignores this; Android uses it.
      const device = await found.device.connect({ timeout: 20000, requestMTU: 247 });
      this.device = device;
      this.subs.push(
        device.onDisconnected(() => {
          this.clearSession();
          this.cb.onStateChange('disconnected', 'Bluetooth disconnected.');
        }),
      );

      this.cb.onStateChange('discovering');
      await device.discoverAllServicesAndCharacteristics();

      const [svc, chr] =
        found.source === 'relay' ? [RELAY_SERVICE_UUID, RELAY_FRAME_UUID] : [ESP32_SERVICE_UUID, ESP32_TX_UUID];

      if (found.source === 'relay') {
        // Read status BEFORE subscribing: the read is how the Pi learns this
        // link's MTU, so it can send each 104-byte frame in one notification.
        await this.readStatus();
        this.statusTimer = setInterval(() => void this.readStatus(), 2000);
      }

      this.subs.push(
        device.monitorCharacteristicForService(svc, chr, (err, c) => {
          if (err || !c?.value) return; // a disconnect surfaces here too; handled above
          this.cb.onBytes(base64ToBytes(c.value));
        }),
      );

      this.cb.onConnected({
        source: found.source,
        name: device.name ?? device.localName ?? (found.source === 'relay' ? 'Raspberry Pi' : 'ESP32'),
        id: device.id,
        at: new Date(),
      });
      this.cb.onStateChange('connected');
    } catch (e) {
      this.cb.onStateChange('failed', `Connection failed: ${e instanceof Error ? e.message : String(e)}`);
      await this.disconnect();
    }
  }

  /** Prefers the Pi relay; takes the ESP32 only if no relay shows up within 3 s. */
  private scan(ble: BleManager, scanMs: number): Promise<{ device: Device; source: Source }> {
    return new Promise((resolve, reject) => {
      let esp32: Device | null = null;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        ble.stopDeviceScan();
        clearTimeout(timer);
        clearTimeout(fallback);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error('No Raspberry Pi relay or ESP32 found. Check both are powered on.'))),
        scanMs,
      );
      let fallback: ReturnType<typeof setTimeout> | undefined;

      ble.startDeviceScan([RELAY_SERVICE_UUID, ESP32_SERVICE_UUID], { allowDuplicates: false }, (err, d) => {
        if (err) return finish(() => reject(err));
        if (!d) return;
        const uuids = (d.serviceUUIDs ?? []).map((u) => u.toLowerCase());
        if (uuids.includes(RELAY_SERVICE_UUID)) {
          finish(() => resolve({ device: d, source: 'relay' }));
        } else if (uuids.includes(ESP32_SERVICE_UUID) && !esp32) {
          esp32 = d;
          fallback = setTimeout(() => finish(() => resolve({ device: esp32!, source: 'esp32' })), 3000);
        }
      });
    });
  }

  private async readStatus(): Promise<void> {
    const d = this.device;
    if (!d) return;
    try {
      const c = await d.readCharacteristicForService(RELAY_SERVICE_UUID, RELAY_STATUS_UUID);
      if (!c.value) return;
      const j = JSON.parse(utf8(base64ToBytes(c.value))) as Record<string, unknown>;
      this.cb.onRelayStatus({
        esp: Boolean(j.esp),
        espSince: typeof j.esp_since === 'number' ? j.esp_since : null,
        rx: Number(j.rx ?? 0),
        crc: Number(j.crc ?? 0),
        lost: Number(j.lost ?? 0),
      });
    } catch {
      // Status is informational; a failed read must not drop the link.
    }
  }

  private clearSession() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    for (const s of this.subs) s.remove();
    this.subs = [];
    this.device = null;
  }

  async disconnect(): Promise<void> {
    const d = this.device;
    this.clearSession();
    if (d) {
      try {
        await d.cancelConnection();
      } catch {
        // already gone
      }
    }
  }
}
