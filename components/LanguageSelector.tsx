import React from 'react';
import { Language, SUPPORTED_LANGUAGES } from '../types';

interface LanguageSelectorProps {
  selectedLanguage: Language;
  onSelect: (lang: Language) => void;
  disabled?: boolean;
}

export const LanguageSelector: React.FC<LanguageSelectorProps> = ({ selectedLanguage, onSelect, disabled }) => {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex flex-col">
        <label className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-black mb-1">
          Target Language
        </label>
        <div className="flex items-center gap-2">
           <span className="text-blue-400 text-xs"><i className="fa-solid fa-globe" /></span>
           <span className="text-sm font-bold text-blue-100">{selectedLanguage.name}</span>
        </div>
      </div>
      
      <select
        value={selectedLanguage.code}
        onChange={(e) => {
          const lang = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value);
          if (lang) onSelect(lang);
        }}
        disabled={disabled}
        className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-[11px] font-bold text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all cursor-pointer disabled:opacity-30 uppercase tracking-wider"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code} className="bg-[#0f172a] text-white">
            {lang.code.toUpperCase()} - {lang.name}
          </option>
        ))}
      </select>
    </div>
  );
};