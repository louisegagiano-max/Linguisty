
import React from 'react';
import { Language, SUPPORTED_LANGUAGES } from '../types';

interface LanguageSelectorProps {
  selectedLanguage: Language;
  onSelect: (lang: Language) => void;
  disabled?: boolean;
}

export const LanguageSelector: React.FC<LanguageSelectorProps> = ({ selectedLanguage, onSelect, disabled }) => {
  return (
    <div className="flex flex-col items-center gap-1 w-full max-w-[200px]">
      <label className="text-[9px] uppercase tracking-[0.3em] text-white/30 font-black">
        Translate To
      </label>
      <div className="relative w-full group">
        <select
          value={selectedLanguage.code}
          onChange={(e) => {
            const lang = SUPPORTED_LANGUAGES.find(l => l.code === e.target.value);
            if (lang) onSelect(lang);
          }}
          disabled={disabled}
          className="w-full bg-white/5 backdrop-blur-md border border-white/10 rounded-full py-2 px-4 pr-8 text-[11px] font-bold text-cyan-400 focus:outline-none focus:border-cyan-500/50 transition-all cursor-pointer disabled:opacity-30 appearance-none text-center tracking-widest uppercase"
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code} className="bg-[#0f172a] text-white">
              {lang.name}
            </option>
          ))}
        </select>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[8px] text-cyan-400/50">
          <i className="fa-solid fa-chevron-down" />
        </div>
      </div>
    </div>
  );
};
