import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Eye, EyeOff, Lock, Unlock, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';


export interface TranscriptModelProps {
    provider: 'localWhisper' | 'parakeet' | 'deepgram' | 'elevenLabs' | 'groq' | 'openai';
    model: string;
    apiKey?: string | null;
}

export interface TranscriptSettingsProps {
    transcriptModelConfig: TranscriptModelProps;
    setTranscriptModelConfig: (config: TranscriptModelProps) => void;
    onModelSelect?: () => void;
}

export function TranscriptSettings({ transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: TranscriptSettingsProps) {
    const [apiKey, setApiKey] = useState<string | null>(transcriptModelConfig.apiKey || null);
    const [showApiKey, setShowApiKey] = useState<boolean>(false);
    const [isApiKeyLocked, setIsApiKeyLocked] = useState<boolean>(Boolean(transcriptModelConfig.apiKey && transcriptModelConfig.apiKey.trim().length > 0));
    const [isLockButtonVibrating, setIsLockButtonVibrating] = useState<boolean>(false);
    const [isSaving, setIsSaving] = useState<boolean>(false);
    const [uiProvider, setUiProvider] = useState<TranscriptModelProps['provider']>(transcriptModelConfig.provider || 'deepgram');

    // Sync uiProvider when backend config changes
    useEffect(() => {
        if (transcriptModelConfig.provider) {
            setUiProvider(transcriptModelConfig.provider);
        }
    }, [transcriptModelConfig.provider]);

    const fetchApiKey = async (provider: string) => {
        try {
            const data = await invoke('api_get_transcript_api_key', { provider }) as string;
            setApiKey(data || '');
            setIsApiKeyLocked(Boolean(data && data.trim().length > 0));
        } catch (err) {
            console.error('Error fetching API key:', err);
            setApiKey(null);
            setIsApiKeyLocked(false);
        }
    };

    useEffect(() => {
        if (uiProvider === 'deepgram') {
            fetchApiKey('deepgram');
        }
    }, [uiProvider]);

    const modelOptions = {
        localWhisper: [],
        parakeet: [],
        deepgram: ['nova-2', 'nova-2-general', 'nova-2-meeting', 'nova-2-phonecall'],
        elevenLabs: ['eleven_multilingual_v2'],
        groq: ['llama-3.3-70b-versatile'],
        openai: ['gpt-4o'],
    };
    const requiresApiKey = true;

    const handleInputClick = () => {
        if (isApiKeyLocked) {
            setIsApiKeyLocked(false);
        }
    };

    const handleWhisperModelSelect = (modelName: string) => {
        // Always update config when model is selected, regardless of current provider
        // This ensures the model is set when user switches back
        setTranscriptModelConfig({
            ...transcriptModelConfig,
            provider: 'localWhisper', // Ensure provider is set correctly
            model: modelName
        });
        // Close modal after selection
        if (onModelSelect) {
            onModelSelect();
        }
    };

    const handleParakeetModelSelect = (modelName: string) => {
        // Always update config when model is selected, regardless of current provider
        // This ensures the model is set when user switches back
        setTranscriptModelConfig({
            ...transcriptModelConfig,
            provider: 'parakeet', // Ensure provider is set correctly
            model: modelName
        });
        // Close modal after selection
        if (onModelSelect) {
            onModelSelect();
        }
    };

    const handleSaveConfig = async () => {
        setIsSaving(true);
        try {
            const modelToSave = (uiProvider === 'deepgram' && (!transcriptModelConfig.model || !modelOptions.deepgram.includes(transcriptModelConfig.model)))
                ? 'nova-2'
                : (transcriptModelConfig.model || 'nova-2');

            await invoke('api_save_transcript_config', {
                provider: uiProvider,
                model: modelToSave,
                apiKey: apiKey,
                authToken: null,
            });

            setTranscriptModelConfig({
                ...transcriptModelConfig,
                provider: uiProvider,
                model: modelToSave,
                apiKey: apiKey,
            });

            setIsApiKeyLocked(true);
            toast.success(`${uiProvider === 'deepgram' ? 'Deepgram' : uiProvider} settings saved successfully!`);
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
        <div>
            <div>
                {/* <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold text-gray-900">Transcript Settings</h3>
                </div> */}
                <div className="space-y-4 pb-6">
                    <div>
                        <Label className="block text-sm font-medium text-gray-700 mb-1">
                            Transcript Model
                        </Label>
                        <div className="flex space-x-2 mx-1">
                            <Select
                                value={uiProvider}
                                onValueChange={(value) => {
                                    const provider = value as TranscriptModelProps['provider'];
                                    setUiProvider(provider);
                                    if (provider === 'deepgram') {
                                        const currentModel = transcriptModelConfig.model;
                                        const defaultModel = modelOptions.deepgram.includes(currentModel) ? currentModel : 'nova-2';
                                        setTranscriptModelConfig({
                                            ...transcriptModelConfig,
                                            provider: 'deepgram',
                                            model: defaultModel,
                                        });
                                    }
                                    if (provider !== 'localWhisper' && provider !== 'parakeet') {
                                        fetchApiKey(provider);
                                    }
                                }}
                            >
                                <SelectTrigger className='focus:ring-1 focus:ring-blue-500 focus:border-blue-500'>
                                    <SelectValue placeholder="Select provider" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="deepgram">☁️ Deepgram (Nova-2 Fast Cloud - Recommended)</SelectItem>
                                </SelectContent>
                            </Select>

                            {uiProvider !== 'localWhisper' && uiProvider !== 'parakeet' && (
                                <Select
                                    value={transcriptModelConfig.model || (uiProvider === 'deepgram' ? 'nova-2' : '')}
                                    onValueChange={(value) => {
                                        const model = value as TranscriptModelProps['model'];
                                        setTranscriptModelConfig({ ...transcriptModelConfig, provider: uiProvider, model });
                                    }}
                                >
                                    <SelectTrigger className='focus:ring-1 focus:ring-blue-500 focus:border-blue-500'>
                                        <SelectValue placeholder="Select model" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {modelOptions[uiProvider].map((model) => (
                                            <SelectItem key={model} value={model}>{model}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            )}

                        </div>
                    </div>

                    {uiProvider === 'localWhisper' && (
                        <div className="mt-6">
                            <ModelManager
                                selectedModel={transcriptModelConfig.provider === 'localWhisper' ? transcriptModelConfig.model : undefined}
                                onModelSelect={handleWhisperModelSelect}
                                autoSave={true}
                            />
                        </div>
                    )}

                    {uiProvider === 'parakeet' && (
                        <div className="mt-6">
                            <ParakeetModelManager
                                selectedModel={transcriptModelConfig.provider === 'parakeet' ? transcriptModelConfig.model : undefined}
                                onModelSelect={handleParakeetModelSelect}
                                autoSave={true}
                            />
                        </div>
                    )}


                    {requiresApiKey && (
                        <div className="space-y-3 pt-2">
                            <div>
                                <Label className="block text-sm font-medium text-gray-700 mb-1">
                                    {uiProvider === 'deepgram' ? 'Deepgram API Key' : 'API Key'}
                                </Label>
                                <div className="relative mx-1">
                                    <Input
                                        type={showApiKey ? "text" : "password"}
                                        className={`pr-24 focus:ring-1 focus:ring-blue-500 focus:border-blue-500 ${isApiKeyLocked ? 'bg-gray-100 cursor-not-allowed' : ''
                                            }`}
                                        value={apiKey || ''}
                                        onChange={(e) => setApiKey(e.target.value)}
                                        disabled={isApiKeyLocked}
                                        onClick={handleInputClick}
                                        placeholder={uiProvider === 'deepgram' ? "Enter your Deepgram API key" : "Enter your API key"}
                                    />
                                    {isApiKeyLocked && (
                                        <div
                                            onClick={handleInputClick}
                                            className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-50 rounded-md cursor-not-allowed"
                                        />
                                    )}
                                    <div className="absolute inset-y-0 right-0 pr-1 flex items-center">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setIsApiKeyLocked(!isApiKeyLocked)}
                                            className={`transition-colors duration-200 ${isLockButtonVibrating ? 'animate-vibrate text-red-500' : ''
                                                }`}
                                            title={isApiKeyLocked ? "Unlock to edit" : "Lock to prevent editing"}
                                        >
                                            {isApiKeyLocked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setShowApiKey(!showApiKey)}
                                        >
                                            {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                </div>
                                {uiProvider === 'deepgram' && (
                                    <p className="text-xs text-gray-500 mt-1 mx-1">
                                        Get a free API key with $200 in free credit at <a href="https://console.deepgram.com" target="_blank" rel="noreferrer" className="text-blue-600 underline">deepgram.com</a>.
                                    </p>
                                )}
                            </div>

                            <div className="mx-1 pt-1">
                                <Button
                                    onClick={handleSaveConfig}
                                    disabled={isSaving || !apiKey || apiKey.trim().length === 0}
                                    className="bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center gap-2"
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
                    )}
                </div>
            </div>
        </div>
    )
}








