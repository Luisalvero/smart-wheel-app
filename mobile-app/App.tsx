import { useState } from 'react';
import {
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from './lib/supabase';

export default function App() {
  const [reading, setReading] = useState('');
  const [status, setStatus] = useState('Waiting...');

  async function sendTestReading() {
    const numericReading = Number(reading);

    if (reading.trim() === '' || Number.isNaN(numericReading)) {
      setStatus('Please enter a valid number.');
      return;
    }

    setStatus('Sending...');

    const { error } = await supabase
      .from('test_readings')
      .insert({
        value: numericReading,
        device_name: 'test-iphone',
      });

    if (error) {
      console.error(error);
      setStatus(`Error: ${error.message}`);
      return;
    }

    setStatus(`Reading ${numericReading} sent successfully!`);
    setReading('');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sensor Test App</Text>

      <TextInput
        style={styles.input}
        placeholder="Enter test reading"
        keyboardType="decimal-pad"
        value={reading}
        onChangeText={setReading}
      />

      <Button
        title="SEND TEST READING"
        onPress={sendTestReading}
      />

      <Text style={styles.status}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  input: {
    width: '80%',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 18,
  },
  status: {
    fontSize: 16,
    textAlign: 'center',
  },
});
