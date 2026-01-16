
export interface Language {
  code: string;
  name: string;
  nativeName: string;
}

export interface DiscoveryEntry {
  id: string;
  languageName: string;
  snippet: string;
  timestamp: number;
  confidence: 'High' | 'Medium' | 'Low';
}

// Added TranscriptionEntry interface to fix the module export error in TranscriptionList.tsx
export interface TranscriptionEntry {
  id: string;
  timestamp: number;
  detectedLanguage?: string;
  inputText?: string;
  outputText: string;
}

export const SUPPORTED_LANGUAGES: Language[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'zu', name: 'Zulu', nativeName: 'isiZulu' },
  { code: 'xh', name: 'Xhosa', nativeName: 'isiXhosa' },
  { code: 'af', name: 'Afrikaans', nativeName: 'Afrikaans' },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
];
