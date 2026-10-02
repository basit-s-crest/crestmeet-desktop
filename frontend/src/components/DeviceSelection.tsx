import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  RefreshCw,
  Mic,
  Speaker,
  Square,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import { AudioLevelMeter, CompactAudioLevelMeter } from './AudioLevelMeter';
import { AudioBackendSelector } from './AudioBackendSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import Analytics from '@/lib/analytics';

export interface AudioDevice {
  name: string;
  device_type: 'Input' | 'Output';
}

export interface SelectedDevices {
  micDevice: string | null;
  systemDevice: string | null;
}

export interface AudioLevelData {
  device_name: string;
  device_type: string;
  rms_level: number;
  peak_level: number;
  is_active: boolean;
}

export interface AudioLevelUpdate {
  timestamp: number;
  levels: AudioLevelData[];
}

interface DeviceSelectionProps {
  selectedDevices: SelectedDevices;
  onDeviceChange: (devices: SelectedDevices) => void;
  disabled?: boolean;
}

export function DeviceSelection({ selectedDevices, onDeviceChange, disabled = false }: DeviceSelectionProps) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [audioLevels, setAudioLevels] = useState<Map<string, AudioLevelData>>(new Map());
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [showLevels, setShowLevels] = useState(false);

  // Live mic testing state
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [micVolume, setMicVolume] = useState(0);
  const [hasVoiceDetected, setHasVoiceDetected] = useState(false);
  const [micSilenceSeconds, setMicSilenceSeconds] = useState(0);
  const [micTestError, setMicTestError] = useState<string | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const silenceIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Filter devices by type
  const inputDevices = devices.filter(device => device.device_type === 'Input');
  const outputDevices = devices.filter(device => device.device_type === 'Output');

  // Fetch available audio devices
  const fetchDevices = async () => {
    try {
      setError(null);
      const result = await invoke<AudioDevice[]>('get_audio_devices');
      setDevices(result);
      console.log('Fetched audio devices:', result);
    } catch (err) {
      console.error('Failed to fetch audio devices:', err);
      setError('Failed to load audio devices. Please check your system audio settings.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Load devices on component mount
  useEffect(() => {
    fetchDevices();
  }, []);

  // Handle device refresh
  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchDevices();
  };

  // Helper function to detect device category and Bluetooth status
  const getDeviceMetadata = (deviceName: string) => {
    const nameLower = deviceName.toLowerCase();

    // Detect if it's Bluetooth
    const isBluetooth = nameLower.includes('airpods')
      || nameLower.includes('bluetooth')
      || nameLower.includes('wireless')
      || nameLower.includes('wh-')  // Sony WH-* series
      || nameLower.includes('bt ');

    // Categorize device
    let category = 'wired';
    if (deviceName === 'default') {
      category = 'default';
    } else if (nameLower.includes('airpods')) {
      category = 'airpods';
    } else if (isBluetooth) {
      category = 'bluetooth';
    }

    return { isBluetooth, category };
  };

  // Handle microphone device selection
  const handleMicDeviceChange = (deviceName: string) => {
    const newDevices = {
      ...selectedDevices,
      micDevice: deviceName === 'default' ? null : deviceName
    };
    onDeviceChange(newDevices);

    // Track device selection analytics with enhanced metadata
    const metadata = getDeviceMetadata(deviceName);
    Analytics.track('microphone_selected', {
      device_category: metadata.category,
      is_bluetooth: metadata.isBluetooth.toString(),
      has_system_audio: (!!selectedDevices.systemDevice).toString()
    }).catch(err => console.error('Failed to track microphone selection:', err));
  };

  // Handle system audio device selection
  const handleSystemDeviceChange = (deviceName: string) => {
    const newDevices = {
      ...selectedDevices,
      systemDevice: deviceName === 'default' ? null : deviceName
    };
    onDeviceChange(newDevices);

    // Track device selection analytics with enhanced metadata
    const metadata = getDeviceMetadata(deviceName);
    Analytics.track('system_audio_selected', {
      device_category: metadata.category,
      is_bluetooth: metadata.isBluetooth.toString(),
      has_microphone: (!!selectedDevices.micDevice).toString()
    }).catch(err => console.error('Failed to track system audio selection:', err));
  };

  // --- Real Microphone Testing via Web Audio API ---
  const startMicTest = async () => {
    try {
      setMicTestError(null);
      setHasVoiceDetected(false);
      setMicSilenceSeconds(0);
      setIsTestingMic(true);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      mediaStreamRef.current = stream;

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioContextRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const checkAudio = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        // Normalize between 0 and 1 with scaling
        const normalized = Math.min(1, Math.max(0, avg / 110));
        setMicVolume(normalized);

        if (normalized > 0.05) {
          setHasVoiceDetected(true);
        }

        animationFrameRef.current = requestAnimationFrame(checkAudio);
      };

      checkAudio();

      silenceIntervalRef.current = setInterval(() => {
        setMicSilenceSeconds((prev) => prev + 1);
      }, 1000);

      Analytics.trackButtonClick('start_mic_test', 'device_selection');
    } catch (err: any) {
      console.error('Failed to start mic test:', err);
      setIsTestingMic(false);
      setMicTestError(err.message || 'Microphone access denied or not available');
    }
  };

  const stopMicTest = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (silenceIntervalRef.current) {
      clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setIsTestingMic(false);
    setMicVolume(0);
  };

  useEffect(() => {
    return () => {
      stopMicTest();
    };
  }, []);


  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/3 mb-4"></div>
          <div className="h-10 bg-gray-200 rounded mb-3"></div>
          <div className="h-10 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">Audio Devices</h4>
          <p className="text-xs text-gray-500">Configure input and output channels for meetings.</p>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={handleRefresh}
            disabled={refreshing || disabled}
            title="Refresh audio device list"
            className="h-8 w-8 p-0 inline-flex items-center justify-center rounded-lg text-sm font-medium transition-colors border border-gray-200 bg-white hover:bg-gray-100 disabled:pointer-events-none disabled:opacity-50 shadow-2xs"
          >
            <RefreshCw className={`h-4 w-4 text-gray-600 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      )}

      <div className="space-y-4">
        {/* Microphone Selection */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Mic className="h-4 w-4 text-gray-600" />
              <Label htmlFor="mic-selection" className="text-sm font-medium text-gray-700">
                Microphone
              </Label>
            </div>
            <Button
              type="button"
              onClick={isTestingMic ? stopMicTest : startMicTest}
              disabled={disabled || inputDevices.length === 0}
              size="sm"
              variant={isTestingMic ? "destructive" : "outline"}
              className={`h-7 px-3 text-xs font-medium flex items-center gap-1.5 shadow-2xs transition-all ${
                isTestingMic
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'border-emerald-300 bg-emerald-50/70 text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800'
              }`}
            >
              {isTestingMic ? (
                <>
                  <Square className="w-3 h-3 fill-current" />
                  <span>Stop Test</span>
                </>
              ) : (
                <>
                  <Mic className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Test Mic</span>
                </>
              )}
            </Button>
          </div>

          <Select
            value={selectedDevices.micDevice || 'default'}
            onValueChange={handleMicDeviceChange}
            disabled={disabled}
          >
            <SelectTrigger id="mic-selection" className="w-full bg-white">
              <SelectValue placeholder="Select Microphone" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default Microphone</SelectItem>
              {inputDevices.map((device) => (
                <SelectItem
                  key={device.name}
                  value={`${device.name} (${device.device_type.toLowerCase()})`}
                >
                  {device.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {inputDevices.length === 0 && (
            <p className="text-xs text-gray-500">No microphone devices found</p>
          )}

          {/* Live Mic Test Card */}
          {isTestingMic && (
            <div className="p-3.5 rounded-xl border border-emerald-200 bg-emerald-50/50 space-y-2.5 animate-in fade-in duration-200">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-gray-800 flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  Live Mic Audio Level
                </span>
                <span className="text-xs font-mono font-medium text-gray-700">
                  {Math.round(micVolume * 100)}%
                </span>
              </div>

              {/* Visual Volume Bar */}
              <div className="w-full h-2.5 bg-gray-200/80 rounded-full overflow-hidden relative">
                <div
                  className={`h-full rounded-full transition-all duration-75 ${
                    micVolume > 0.7 ? 'bg-red-500' : micVolume > 0.3 ? 'bg-amber-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${Math.round(micVolume * 100)}%` }}
                />
              </div>

              {/* Status indicator message */}
              <div>
                {hasVoiceDetected ? (
                  <div className="flex items-center gap-1.5 text-xs text-emerald-700 font-medium">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    <span>Voice detected! Your microphone is capturing audio clearly.</span>
                  </div>
                ) : micSilenceSeconds >= 4 ? (
                  <div className="flex items-start justify-between gap-2 p-2.5 rounded-lg bg-amber-100/80 border border-amber-300 text-amber-900 text-xs">
                    <div className="flex items-start gap-1.5">
                      <AlertCircle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
                      <span>No audio signal received yet. The microphone may be muted or blocked by Windows.</span>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await invoke('open_microphone_settings_command');
                        } catch (e) {
                          console.error(e);
                        }
                      }}
                      className="text-[11px] underline font-semibold hover:text-amber-950 shrink-0 flex items-center gap-1 ml-2"
                    >
                      Windows Settings <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-blue-700">
                    <Mic className="w-3.5 h-3.5 text-blue-600 animate-pulse shrink-0" />
                    <span>Speak into your microphone to test volume level...</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {micTestError && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
              <span>Error testing microphone: {micTestError}</span>
            </div>
          )}
        </div>

        {/* System Audio Selection */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Speaker className="h-4 w-4 text-gray-600" />
            <Label htmlFor="system-selection" className="text-sm font-medium text-gray-700">
              System Audio
            </Label>
          </div>

          <Select
            value={selectedDevices.systemDevice || 'default'}
            onValueChange={handleSystemDeviceChange}
            disabled={disabled}
          >
            <SelectTrigger id="system-selection" className="w-full bg-white">
              <SelectValue placeholder="Select System Audio" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Default System Audio</SelectItem>
              {outputDevices.map((device) => (
                <SelectItem
                  key={device.name}
                  value={`${device.name} (${device.device_type.toLowerCase()})`}
                >
                  {device.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {outputDevices.length === 0 && (
            <p className="text-xs text-gray-500">No system audio devices found</p>
          )}

          {/* Backend Selection - available on all platforms */}
          {!disabled && (
            <div className="pt-3 border-t border-gray-100">
              <AudioBackendSelector disabled={disabled} />
            </div>
          )}
        </div>
      </div>

      {/* Info text */}
      <div className="text-xs text-gray-500 space-y-1 pt-1 border-t border-gray-100">
        <p>• <strong>Microphone:</strong> Records your speech and voice during meetings.</p>
        <p>• <strong>System Audio:</strong> Records meeting attendees (Teams, Google Meet, Zoom, browser calls).</p>
        {!isTestingMic && (
          <p>• <strong>Tip:</strong> Click "Test Mic" above to check if your microphone is capturing audio before starting calls.</p>
        )}
      </div>
    </div>
  );
}
