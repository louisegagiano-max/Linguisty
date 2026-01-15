
import React from 'react';
import { Language, SUPPORTED_LANGUAGES } from '../types';

interface LanguageSelectorProps {
  selectedLanguage: Language;
  onSelect: (lang: Language) => void;
  disabled?: boolean;
}

export const LanguageSelector: React.FC<LanguageSelectorProps> = ({ selectedLanguage, onSelect, disabled }) => {
  return (
    <div className="flex flex-col gap-2 w-full max-w-xs mx-auto">
      <label className="text-xs uppercase tracking-widest text-gray-400 font-semibold text-center">
        Translate To
      </label>
      <select
        value={selectedLanguage.code}
        onChange={(e) => {
          const lang = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value);
          if (lang) onSelect(lang);
        }}
        disabled={disabled}
        className="w-full bg-white/10 border border-white/20 rounded-xl px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all cursor-pointer disabled:opacity-50"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code} className="bg-gray-900">
            {lang.name} ({lang.nativeName})
          </option>
        ))}
      </select>
    </div>
  );
};
