/**
 * BLE *transport*. Moves bytes and reports link state; assigns them no meaning.
 *
 * Decoding belongs to protocol.ts and persistence to the repositories, so
 * swapping the Python laptop simulator for ESP32 firmware changes nothing here.
 */
import { Platform, PermissionsAndroid } from 'react-native';
import {
  BleManager,
  State,
  type Device,
  type Subscription,
} from 'react-native-ble-plx';

import {
  SMART_WHEEL_SERVICE_UUID,
  SIMULATOR_ADVERTISED_NAME,
  TELEMETRY_CHAR_UUID,
} from './protocol';

export type ConnectionState =
  | 'idle'
  | 'scanning'
  | 'connecting'
  | 'discovering'
  | 'connected'
  | 'disconnected'
  | 'failed';

export type BleCallbacks = {
  onStateChange: (state: ConnectionState, error?: string) => void;
  /** Raw base64 notification value. The hook decodes and stores it. */
  onPayload: (base64Value: string) => void;
};

/** A single manager for the app's lifetime; creating several fights over the radio. */
let manager: BleManager | null = null;
export function getManager(): BleManager {
  if (!manager) {
    manager = new BleManager();
  }
  return manager;
}

/**
 * Android 12+ needs runtime Bluetooth grants. iOS needs none at runtime -- it
 * prompts automatically from the Info.plist usage string.
 */
export async function requestPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  const api = typeof Platform.Version === 'number' ? Platform.Version : 0;
  if (api < 31) {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  }
  const result = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ]);
  return Object.values(result).every(
    (v) => v === PermissionsAndroid.RESULTS.GRANTED,
  );
}

export class WheelConnection {
  private device: Device | null = null;
  private notifySub: Subscription | null = null;
  private disconnectSub: Subscription | null = null;

  constructor(private readonly callbacks: BleCallbacks) {}

  get connectedDevice(): Device | null {
    return this.device;
  }

  /**
   * Scans for the wheel, connects, and subscribes to telemetry.
   *
   * Filtering is by service UUID rather than name: the name lives in the scan
   * response and is cosmetic, whereas the 128-bit service UUID is what actually
   * identifies a Smart Wheel peripheral -- simulator or ESP32 alike.
   */
  async connect(timeoutMs = 15000): Promise<void> {
    await this.disconnect();

    const ok = await requestPermissions();
    if (!ok) {
      this.callbacks.onStateChange('failed', 'Bluetooth permission denied.');
      return;
    }

    const bleManager = getManager();
    const state = await bleManager.state();
    if (state !== State.PoweredOn) {
      this.callbacks.onStateChange(
        'failed',
        state === State.Unauthorized
          ? 'Bluetooth permission was denied. Enable it in Settings.'
          : 'Bluetooth is off. Turn it on and try again.',
      );
      return;
    }

    this.callbacks.onStateChange('scanning');

    let found: Device;
    try {
      found = await this.scan(bleManager, timeoutMs);
    } catch (err) {
      this.callbacks.onStateChange(
        'failed',
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    try {
      this.callbacks.onStateChange('connecting');
      const device = await found.connect({ timeout: 20000 });
      this.device = device;

      // A dropped link must not clear session data; the hook keeps the session
      // and its stored events untouched.
      this.disconnectSub = device.onDisconnected(() => {
        this.notifySub?.remove();
        this.notifySub = null;
        this.device = null;
        this.callbacks.onStateChange('disconnected', 'Bluetooth disconnected.');
      });

      this.callbacks.onStateChange('discovering');
      await device.discoverAllServicesAndCharacteristics();

      this.notifySub = device.monitorCharacteristicForService(
        SMART_WHEEL_SERVICE_UUID,
        TELEMETRY_CHAR_UUID,
        (error, characteristic) => {
          if (error) {
            // A disconnect surfaces here too; onDisconnected already handled it.
            return;
          }
          const value = characteristic?.value;
          if (value) {
            this.callbacks.onPayload(value);
          }
        },
      );

      this.callbacks.onStateChange('connected');
    } catch (err) {
      this.callbacks.onStateChange(
        'failed',
        `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.disconnect();
    }
  }

  private scan(bleManager: BleManager, timeoutMs: number): Promise<Device> {
    return new Promise<Device>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        bleManager.stopDeviceScan();
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `${SIMULATOR_ADVERTISED_NAME} not found. Check the simulator is ` +
                'running and advertising.',
            ),
          ),
        );
      }, timeoutMs);

      bleManager.startDeviceScan(
        [SMART_WHEEL_SERVICE_UUID],
        { allowDuplicates: false },
        (error, device) => {
          if (error) {
            finish(() => reject(error));
            return;
          }
          if (device) {
            finish(() => resolve(device));
          }
        },
      );
    });
  }

  async disconnect(): Promise<void> {
    this.notifySub?.remove();
    this.notifySub = null;
    this.disconnectSub?.remove();
    this.disconnectSub = null;

    const device = this.device;
    this.device = null;
    if (device) {
      try {
        await device.cancelConnection();
      } catch {
        // Already gone; nothing to clean up.
      }
    }
  }
}
