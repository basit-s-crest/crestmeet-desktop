"use client";

import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Eye, EyeOff, Lock, Unlock, Check, Loader2, Sparkles, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { ModelConfig } from "./ModelSettingsModal";
import { useConfig } from "@/contexts/ConfigContext";

export interface GroqSummarySettingsProps {
  modelConfig?: ModelConfig;
  setModelConfig?: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;
  onSaveSuccess?: () => void;
}

interface GroqModelOption {
  id: string;
  name: string;
  desc: string;
}

const DEFAULT_GROQ_MODELS: GroqModelOption[] = [
  { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B (Recommended)", desc: "Latest flagship model on Groq, exceptional summary quality" },
  { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", desc: "High-speed inference, balanced efficiency" },
  { id: "qwen/qwen3.6-27b", name: "Qwen 3.6 27B", desc: "Strong multilingual and reasoning capabilities" },
  { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", desc: "Ultra-fast response time" },
];

export function GroqSummarySettings({
  modelConfig,
  setModelConfig,
  onSaveSuccess,
}: GroqSummarySettingsProps) {
  const { updateProviderApiKey } = useConfig();
  const [apiKey, setApiKey] = useState<string>(modelConfig?.apiKey || "");
  const [availableModels, setAvailableModels] = useState<GroqModelOption[]>(DEFAULT_GROQ_MODELS);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    const current = modelConfig?.model;
    if (current && !current.includes("llama-3.3") && !current.includes("llama3.2") && !current.includes("gemma")) {
      return current;
    }
    return "openai/gpt-oss-120b";
  });
  const [isCustomModel, setIsCustomModel] = useState<boolean>(false);
  const [customModelInput, setCustomModelInput] = useState<string>("");
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [isApiKeyLocked, setIsApiKeyLocked] = useState<boolean>(false);
  const [isLoadingModels, setIsLoadingModels] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Fetch live Groq models if API key exists
  const fetchLiveModels = async (key: string) => {
    if (!key || !key.trim()) return;
    setIsLoadingModels(true);
    try {
      const data = (await invoke("get_groq_models", { apiKey: key.trim() })) as Array<{ id: string }>;
      if (data && data.length > 0) {
        const liveModels: GroqModelOption[] = data.map((m) => {
          const known = DEFAULT_GROQ_MODELS.find((d) => d.id === m.id);
          return (
            known || {
              id: m.id,
              name: m.id,
              desc: "Available on your Groq account",
            }
          );
        });
        setAvailableModels(liveModels);
      }
    } catch (err) {
      console.warn("Could not fetch dynamic Groq models list:", err);
    } finally {
      setIsLoadingModels(false);
    }
  };

  // Load existing Groq API key on mount
  useEffect(() => {
    const initGroq = async () => {
      try {
        const key = (await invoke("api_get_api_key", { provider: "groq" })) as string;
        if (key && key.trim().length > 0) {
          setApiKey(key);
          setIsApiKeyLocked(true);
          await fetchLiveModels(key);
        }
      } catch (err) {
        console.warn("No existing Groq API key found:", err);
      }
    };
    initGroq();
  }, []);

  const handleOpenGroqConsole = async () => {
    try {
      await invoke("open_external_url", { url: "https://console.groq.com/keys" });
    } catch (err) {
      console.error("Failed to open external url:", err);
    }
  };

  const handleSave = async () => {
    const finalKey = apiKey.trim();
    if (!finalKey) {
      toast.error("Please enter a valid Groq API key");
      return;
    }

    const finalModel = isCustomModel ? customModelInput.trim() : selectedModel;
    if (!finalModel) {
      toast.error("Please select or enter a valid model ID");
      return;
    }

    setIsSaving(true);
    try {
      // 1. Save model config (persists model and api_key into settings)
      await invoke("api_save_model_config", {
        provider: "groq",
        model: finalModel,
        whisperModel: "large-v3",
        apiKey: finalKey,
        api_key: finalKey,
        ollamaEndpoint: null,
      });

      // 2. Save API key directly
      try {
        await invoke("api_save_api_key", {
          provider: "groq",
          apiKey: finalKey,
          api_key: finalKey,
        });
      } catch (e) {
        console.warn("api_save_api_key fallback notice:", e);
      }

      const updated: ModelConfig = {
        provider: "groq",
        model: finalModel,
        whisperModel: "large-v3",
        apiKey: finalKey,
        ollamaEndpoint: null,
      };

      if (setModelConfig) {
        setModelConfig(updated);
      }

      updateProviderApiKey("groq", finalKey);
      await emit("model-config-updated", updated);

      setIsApiKeyLocked(true);
      toast.success("Groq summary configuration saved!");

      if (onSaveSuccess) {
        onSaveSuccess();
      }
    } catch (err: any) {
      console.error("Failed to save Groq config:", err);
      toast.error("Failed to save Groq configuration: " + (err.message || String(err)));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header explanation */}
      <div className="bg-gradient-to-r from-blue-50 via-indigo-50 to-purple-50 p-4 rounded-xl border border-blue-100 flex items-start gap-3">
        <div className="p-2 bg-blue-600 rounded-lg text-white shadow-sm mt-0.5">
          <Sparkles className="w-5 h-5" />
        </div>
        <div>
          <h4 className="font-semibold text-gray-900 text-sm">Groq Cloud AI Summarization</h4>
          <p className="text-xs text-gray-600 mt-1 leading-relaxed">
            Ultra-fast cloud inference on Groq's high-speed LPU processors.
            Summarizes entire meetings in seconds.
          </p>
        </div>
      </div>

      {/* Model Selection */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold text-gray-800">Summary Model</Label>
          <div className="flex items-center gap-2">
            {apiKey && (
              <button
                type="button"
                onClick={() => fetchLiveModels(apiKey)}
                disabled={isLoadingModels}
                className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1"
                title="Refresh live models from Groq"
              >
                <RefreshCw className={`w-3 h-3 ${isLoadingModels ? "animate-spin" : ""}`} />
                <span>Sync Models</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsCustomModel(!isCustomModel)}
              className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
            >
              {isCustomModel ? "Pick from list" : "Enter custom model"}
            </button>
          </div>
        </div>

        {isCustomModel ? (
          <Input
            value={customModelInput}
            onChange={(e) => setCustomModelInput(e.target.value)}
            placeholder="e.g. openai/gpt-oss-120b"
            className="h-11 font-mono text-xs bg-white"
          />
        ) : (
          <Select value={selectedModel} onValueChange={setSelectedModel}>
            <SelectTrigger className="w-full h-11 bg-white border-gray-200">
              <SelectValue placeholder="Select Groq model" />
            </SelectTrigger>
            <SelectContent>
              {availableModels.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <div className="py-0.5 text-left">
                    <span className="font-medium text-gray-900">{m.name}</span>
                    <span className="text-xs text-gray-500 block">{m.desc}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* API Key Input */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold text-gray-800">Groq API Key</Label>
          <button
            type="button"
            onClick={handleOpenGroqConsole}
            className="text-xs text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1 hover:underline"
          >
            <span>Get API Key</span>
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>

        <div className="relative">
          <Input
            type={showApiKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={isApiKeyLocked}
            placeholder="gsk_..."
            className={`h-11 pr-20 font-mono text-xs ${
              isApiKeyLocked ? "bg-gray-50 text-gray-500 cursor-not-allowed" : "bg-white"
            }`}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-gray-500 hover:text-gray-700"
              onClick={() => setShowApiKey(!showApiKey)}
              title={showApiKey ? "Hide API key" : "Show API key"}
            >
              {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </Button>
            {apiKey && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-gray-500 hover:text-gray-700"
                onClick={() => {
                  if (isApiKeyLocked) {
                    setIsApiKeyLocked(false);
                  } else {
                    setIsApiKeyLocked(true);
                  }
                }}
                title={isApiKeyLocked ? "Unlock to edit" : "Lock key"}
              >
                {isApiKeyLocked ? <Lock className="w-4 h-4 text-green-600" /> : <Unlock className="w-4 h-4" />}
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-gray-500">
          Your API key is saved locally on this computer only.
        </p>
      </div>

      {/* Save Button */}
      <div className="pt-2">
        <Button
          onClick={handleSave}
          disabled={isSaving || !apiKey.trim()}
          className="w-full h-11 bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-sm transition-all"
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Saving Configuration...
            </>
          ) : (
            <>
              <Check className="w-4 h-4 mr-2" />
              Save Groq Settings
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
