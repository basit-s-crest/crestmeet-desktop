'use client';

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Eye, EyeOff, Lock, Unlock, Check, Loader2, Cloud, ExternalLink, FileAudio } from 'lucide-react';
import { toast } from 'sonner';

export interface TranscriptModelProps {
    provider: 'deepgram' | 'localWhisper' | 'parakeet' | 'elevenLabs' | 'groq' | 'openai';
    model: string;
    apiKey?: string | null;
}

export interface TranscriptSettingsProps {
    transcriptModelConfig: TranscriptModelProps;
    setTranscriptModelConfig: (config: TranscriptModelProps) => void;
    onModelSelect?: () => void;
}

interface DeepgramModelOption {
    id: string;
    name: string;
    desc: string;
}

const DEEPGRAM_MODELS: DeepgramModelOption[] = [
    {
        id: 'nova-2',
        name: 'Nova-2 General (Recommended)',
        desc: 'Fastest and most accurate cloud model for all-around speech'
    },
    {
        id: 'nova-2-meeting',
        name: 'Nova-2 Meeting',
        desc: 'Optimized for conference rooms and multi-speaker discussions'
    },
    {
        id: 'nova-2-phonecall',
        name: 'Nova-2 Phonecall',
        desc: 'Optimized for telephony and lower-bandwidth audio streams'
    },
];

export function TranscriptSettings({
    transcriptModelConfig,
    setTranscriptModelConfig,
    onModelSelect
}: TranscriptSettingsProps) {
    const [apiKey, setApiKey] = useState<string>(transcriptModelConfig.apiKey || '');
    const [showApiKey, setShowApiKey] = useState<boolean>(false);
    const [isApiKeyLocked, setIsApiKeyLocked] = useState<boolean>(
        Boolean(transcriptModelConfig.apiKey && transcriptModelConfig.apiKey.trim().length > 0)
    );
    const [isSaving, setIsSaving] = useState<boolean>(false);
    const [selectedModel, setSelectedModel] = useState<string>(
        transcriptModelConfig.model && DEEPGRAM_MODELS.some(m => m.id === transcriptModelConfig.model)
            ? transcriptModelConfig.model
            : 'nova-2'
    );

    // Sync state when props change
    useEffect(() => {
        if (transcriptModelConfig.model && DEEPGRAM_MODELS.some(m => m.id === transcriptModelConfig.model)) {
            setSelectedModel(transcriptModelConfig.model);
        }
        if (transcriptModelConfig.apiKey) {
            setApiKey(transcriptModelConfig.apiKey);
            setIsApiKeyLocked(true);
        }
    }, [transcriptModelConfig]);

    // Fetch existing API key from backend on mount
    useEffect(() => {
        const fetchApiKey = async () => {
            try {
                const key = await invoke<string>('api_get_transcript_api_key', { provider: 'deepgram' });
                if (key && key.trim().length > 0) {
                    setApiKey(key);
                    setIsApiKeyLocked(true);
                }
            } catch (err) {
                console.warn('Could not fetch existing Deepgram API key:', err);
            }
        };
        fetchApiKey();
    }, []);

    const handleInputClick = () => {
        if (isApiKeyLocked) {
            setIsApiKeyLocked(false);
        }
    };

    const handleOpenDeepgramConsole = async () => {
        try {
            await invoke('open_external_url', { url: 'https://console.deepgram.com' });
        } catch (e) {
            console.error('Failed to open Deepgram console:', e);
            window.open('https://console.deepgram.com', '_blank');
        }
    };

    const handleSaveConfig = async () => {
        setIsSaving(true);
        try {
            await invoke('api_save_transcript_config', {
                provider: 'deepgram',
                model: selectedModel,
                apiKey: apiKey.trim(),
                authToken: null,
            });

            setTranscriptModelConfig({
                provider: 'deepgram',
                model: selectedModel,
                apiKey: apiKey.trim(),
            });

            setIsApiKeyLocked(true);
            toast.success('Transcription settings saved locally!');
            if (onModelSelect) {
                onModelSelect();
            }
        } catch (error) {
            console.error('Failed to save transcript config:', error);
            toast.error('Failed to save transcription settings');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="bg-white rounded-xl border border-gray-200/80 p-6 shadow-xs transition-all hover:border-gray-300 space-y-6">
            <div className="flex items-start gap-4">
                <div className="w-10 h-10 rounded-xl bg-sky-50 border border-sky-100 flex items-center justify-center text-sky-600 shrink-0">
                    <FileAudio className="w-5 h-5" />
                </div>
                <div>
                    <div className="flex items-center gap-2">
                        <h3 className="text-base font-semibold text-gray-900">Transcription Engine</h3>
                        <span className="text-[11px] font-medium bg-sky-50 text-sky-700 px-2 py-0.5 rounded-full border border-sky-100">
                            Deepgram Cloud STT
                        </span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1 leading-relaxed">
                        High-speed, highly accurate real-time speech recognition powered by Deepgram Nova-2 with speaker diarization.
                    </p>
                </div>
            </div>

            <div className="space-y-5">
                {/* Provider Selection */}
                <div className="space-y-1.5">
                    <Label className="block text-xs font-semibold uppercase tracking-wider text-gray-500">
                        Speech Recognition Provider
                    </Label>
                    <Select value="deepgram" disabled>
                        <SelectTrigger className="w-full bg-slate-50 border-gray-200 text-gray-800 h-10 text-sm shadow-2xs">
                            <SelectValue placeholder="Deepgram" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="deepgram">☁️ Deepgram (Cloud STT - Recommended)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {/* Model Selection */}
                <div className="space-y-1.5">
                    <Label className="block text-xs font-semibold uppercase tracking-wider text-gray-500">
                        Acoustic & Language Model
                    </Label>
                    <Select
                        value={selectedModel}
                        onValueChange={(val) => {
                            setSelectedModel(val);
                            setTranscriptModelConfig({
                                ...transcriptModelConfig,
                                provider: 'deepgram',
                                model: val,
                            });
                        }}
                    >
                        <SelectTrigger className="w-full h-10 border-gray-200 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 bg-white text-sm shadow-2xs">
                            <SelectValue placeholder="Select Deepgram model" />
                        </SelectTrigger>
                        <SelectContent>
                            {DEEPGRAM_MODELS.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                    <div className="flex flex-col py-0.5 text-left">
                                        <span className="font-medium text-gray-900 text-sm">{m.name}</span>
                                        <span className="text-xs text-gray-500">{m.desc}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* API Key Input */}
                <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-gray-500">
                            Deepgram API Key
                        </Label>
                        <button
                            type="button"
                            onClick={handleOpenDeepgramConsole}
                            className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 hover:underline cursor-pointer"
                        >
                            <span>Open Deepgram Console</span>
                            <ExternalLink className="w-3 h-3" />
                        </button>
                    </div>

                    <div className="relative">
                        <Input
                            type={showApiKey ? 'text' : 'password'}
                            className={`h-10 pr-24 text-xs font-mono border-gray-200 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 ${
                                isApiKeyLocked ? 'bg-slate-50 text-gray-500 cursor-not-allowed' : 'bg-white'
                            }`}
                            value={apiKey}
                            onChange={(e) => setApiKey(e.target.value)}
                            disabled={isApiKeyLocked}
                            onClick={handleInputClick}
                            placeholder="Enter your Deepgram API key (token...)"
                        />
                        {isApiKeyLocked && (
                            <div
                                onClick={handleInputClick}
                                className="absolute inset-0 bg-transparent cursor-not-allowed"
                            />
                        )}
                        <div className="absolute inset-y-0 right-0 pr-1 flex items-center gap-0.5">
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setIsApiKeyLocked(!isApiKeyLocked)}
                                className="h-8 w-8 text-gray-400 hover:text-gray-700"
                                title={isApiKeyLocked ? 'Unlock to edit' : 'Lock to prevent editing'}
                            >
                                {isApiKeyLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setShowApiKey(!showApiKey)}
                                className="h-8 w-8 text-gray-400 hover:text-gray-700"
                            >
                                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed">
                        Free Deepgram accounts include $200 in free transcription credits. API keys are stored securely on your local device.
                    </p>
                </div>

                {/* Save Button */}
                <div className="pt-2">
                    <Button
                        onClick={handleSaveConfig}
                        disabled={isSaving || !apiKey || apiKey.trim().length === 0}
                        className="bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg shadow-xs transition-all active:scale-95 text-sm font-medium cursor-pointer"
                    >
                        {isSaving ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>Saving Configuration...</span>
                            </>
                        ) : (
                            <>
                                <Check className="w-4 h-4" />
                                <span>Save Transcription Settings</span>
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </div>
    );
}
