import type { TtsVoiceConfig } from './interfaces.js';
import type { Lang } from './types.js';

export interface VoiceSettings {
  provider: string;
  /** Any provider voice id per language. Missing languages use `defaultVoiceId`. */
  voices: Partial<Record<Lang, string>>;
  defaultVoiceId: string;
  model: string;
  outputFormat: string;
  stability?: number;
  similarityBoost?: number;
}

/** Pick the voice for a language and build the per-utterance TTS config. */
export function selectVoice(settings: VoiceSettings, lang: Lang): TtsVoiceConfig {
  return {
    provider: settings.provider,
    voiceId: settings.voices[lang] ?? settings.defaultVoiceId,
    model: settings.model,
    outputFormat: settings.outputFormat,
    stability: settings.stability,
    similarityBoost: settings.similarityBoost,
    languageCode: lang,
  };
}
