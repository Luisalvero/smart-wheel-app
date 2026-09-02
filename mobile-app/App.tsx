/**
 * LOCAL TEST BUILD -- renders the Smart Wheel BLE screen.
 *
 * The original Supabase test screen is preserved verbatim in
 * App.supabase.tsx.bak. The branch proposed to the team leaves this file
 * untouched; this change exists only so the BLE pipeline can be exercised on a
 * physical device.
 */
import SmartWheelScreen from './components/SmartWheelScreen';

export default function App() {
  return <SmartWheelScreen />;
}
