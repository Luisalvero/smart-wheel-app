/**
 * BLE transport: finds the Raspberry Pi relay, subscribes to frames, reports
 * link state, and keeps reconnecting on its own. Assigns bytes no meaning --
 * decoding lives in protocol.ts.
 *
 * Auto-reconnect: in the car the phone must recover without the driver
 * touching it -- the Pi takes 20-30 s to boot after ignition, and any dropout
 * mid-drive must heal by itself. start() keeps trying (with backoff) until
 * stop(); returning the app to the foreground retries immediately.
 *
 * Direct-to-ESP32 is OFF by default. The ESP32 accepts one connection, and it
 * is ready within a second of ignition while the Pi is still booting; a phone
 * allowed to fall back would take the ESP32 first and lock the Pi out, so the
 * drive would never be logged. It remains available for bench testing
 * without a Pi via setAllowDirect(true).
 */
import { AppState, PermissionsAndroid, Platform, type NativeEventSubscription } from 'react-native';
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
  | 'waiting'   // between automatic retries
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

  // Auto-reconnect state.
  private wanted = false;
  private busy = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: NativeEventSubscription | null = null;
  private allowDirect = false;
  private cancelScan: (() => void) | null = null;

  constructor(private readonly cb: BleCallbacks) {}

  /** Bench testing only: also accept the ESP32 when no Pi relay is found. */
  setAllowDirect(allow: boolean) {
    this.allowDirect = allow;
  }

  /** Keeps a link to the relay up until stop() -- connects, and reconnects
   *  after any failure or drop without user action. */
  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.attempt = 0;
    // Back in the foreground (e.g. screen unlocked): retry now, not after backoff.
    this.appStateSub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && this.wanted && !this.device) this.retryNow();
    });
    void this.cycle();
  }

  async stop(): Promise<void> {
    this.wanted = false;
    this.appStateSub?.remove();
    this.appStateSub = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.cancelScan?.(); // an in-flight scan would otherwise report "not found" after pausing
    await this.disconnect();
    this.cb.onStateChange('idle');
  }

  get isAutoConnecting() {
    return this.wanted;
  }

  private retryNow() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    void this.cycle();
  }

  private async cycle() {
    if (!this.wanted || this.busy || this.device) return;
    this.busy = true;
    const ok = await this.connect();
    this.busy = false;
    if (ok) this.attempt = 0;
    else this.scheduleRetry();
  }

  private scheduleRetry() {
    if (!this.wanted || this.retryTimer) return;
    // 1 s, 2 s, 4 s, then every 8 s: quick after a blip, gentle while the Pi boots.
    const delay = Math.min(8000, 1000 * 2 ** this.attempt);
    this.attempt += 1;
    this.cb.onStateChange('waiting', `Searching again in ${Math.round(delay / 1000)} s…`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.cycle();
    }, delay);
  }

  /** One attempt. Returns true when connected and subscribed. */
  private async connect(scanMs = 12000): Promise<boolean> {
    await this.disconnect();
    if (!(await requestPermissions())) {
      this.cb.onStateChange('failed', 'Bluetooth permission denied.');
      return false;
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
      return false;
    }

    this.cb.onStateChange('scanning');
    let found: { device: Device; source: Source };
    try {
      found = await this.scan(ble, scanMs);
    } catch (e) {
      // Stopped while scanning: stay quiet, the UI already shows "paused".
      if (this.wanted) this.cb.onStateChange('failed', e instanceof Error ? e.message : String(e));
      return false;
    }

    try {
      this.cb.onStateChange('connecting');
      // requestMTU: iOS negotiates its own MTU and ignores this; Android uses it.
      const device = await found.device.connect({ timeout: 20000, requestMTU: 247 });
      if (!this.wanted) {
        // Paused while the connection was being made.
        await device.cancelConnection().catch(() => undefined);
        return false;
      }
      this.device = device;
      this.subs.push(
        device.onDisconnected(() => {
          this.clearSession();
          this.cb.onStateChange('disconnected', 'Link lost — reconnecting…');
          // A drop mid-drive should heal fast: start from the shortest backoff.
          this.attempt = 0;
          this.scheduleRetry();
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
      return true;
    } catch (e) {
      if (this.wanted) {
        this.cb.onStateChange('failed', `Connection failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await this.disconnect();
      return false;
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
        this.cancelScan = null;
        ble.stopDeviceScan();
        clearTimeout(timer);
        clearTimeout(fallback);
        fn();
      };
      this.cancelScan = () => finish(() => reject(new Error('cancelled')));
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(
                this.allowDirect
                  ? 'No Raspberry Pi relay or ESP32 found.'
                  : 'Raspberry Pi not found yet (it takes ~30 s to boot).',
              ),
            ),
          ),
        scanMs,
      );
      let fallback: ReturnType<typeof setTimeout> | undefined;

      const services = this.allowDirect ? [RELAY_SERVICE_UUID, ESP32_SERVICE_UUID] : [RELAY_SERVICE_UUID];
      ble.startDeviceScan(services, { allowDuplicates: false }, (err, d) => {
        if (err) return finish(() => reject(err));
        if (!d) return;
        const uuids = (d.serviceUUIDs ?? []).map((u) => u.toLowerCase());
        if (uuids.includes(RELAY_SERVICE_UUID)) {
          finish(() => resolve({ device: d, source: 'relay' }));
        } else if (this.allowDirect && uuids.includes(ESP32_SERVICE_UUID) && !esp32) {
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
