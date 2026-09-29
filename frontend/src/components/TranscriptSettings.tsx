'use client';

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Eye, EyeOff, Lock, Unlock, Check, Loader2, Cloud, ExternalLink } from 'lucide-react';
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
        <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm space-y-6">
            <div>
                <div className="flex items-center gap-2 mb-1">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-100">
                        <Cloud className="w-3 h-3" />
                        Cloud Speech-to-Text
                    </span>
                </div>
                <h3 className="text-lg font-semibold text-gray-900 mt-2 mb-1">Transcription Configuration</h3>
                <p className="text-sm text-gray-600">
                    High-speed, highly accurate real-time speech recognition powered by Deepgram Nova-2.
                </p>
            </div>

            <div className="space-y-4">
                {/* Provider Selection */}
                <div>
                    <Label className="block text-sm font-medium text-gray-700 mb-1.5">
                        Speech Recognition Provider
                    </Label>
                    <Select value="deepgram" disabled>
                        <SelectTrigger className="w-full bg-gray-50 border-gray-300 text-gray-800">
                            <SelectValue placeholder="Deepgram" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="deepgram">☁️ Deepgram (Cloud STT - Recommended)</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {/* Model Selection */}
                <div>
                    <Label className="block text-sm font-medium text-gray-700 mb-1.5">
                        Deepgram Model
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
                        <SelectTrigger className="w-full focus:ring-1 focus:ring-blue-500 focus:border-blue-500">
                            <SelectValue placeholder="Select Deepgram model" />
                        </SelectTrigger>
                        <SelectContent>
                            {DEEPGRAM_MODELS.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                    <div className="flex flex-col py-0.5">
                                        <span className="font-medium text-gray-900">{m.name}</span>
                                        <span className="text-xs text-gray-500">{m.desc}</span>
                                    </div>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* API Key Input */}
                <div className="space-y-2 pt-2">
                    <div className="flex items-center justify-between">
                        <Label className="text-sm font-semibold text-gray-800">
                            Deepgram API Key
                        </Label>
                        <button
                            type="button"
                            onClick={handleOpenDeepgramConsole}
                            className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 hover:underline"
                        >
                            <span>Get API Key</span>
                            <ExternalLink className="w-3 h-3" />
                        </button>
                    </div>

                    <div className="relative">
                        <Input
                            type={showApiKey ? 'text' : 'password'}
                            className={`pr-24 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 ${
                                isApiKeyLocked ? 'bg-gray-100 cursor-not-allowed' : ''
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
                                className="h-8 w-8 text-gray-500 hover:text-gray-700"
                                title={isApiKeyLocked ? 'Unlock to edit' : 'Lock to prevent editing'}
                            >
                                {isApiKeyLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => setShowApiKey(!showApiKey)}
                                className="h-8 w-8 text-gray-500 hover:text-gray-700"
                            >
                                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                        </div>
                    </div>
                    <p className="text-xs text-gray-500">
                        Free accounts include $200 in free transcription credits. Saved locally on this computer only.
                    </p>
                </div>

                {/* Save Button */}
                <div className="pt-3">
                    <Button
                        onClick={handleSaveConfig}
                        disabled={isSaving || !apiKey || apiKey.trim().length === 0}
                        className="bg-gray-900 hover:bg-gray-800 text-white flex items-center justify-center gap-2 px-5 py-2 rounded-lg shadow-sm"
                    >
                        {isSaving ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span>Saving...</span>
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
