
import React, { useEffect, useRef } from 'react';
import { TranscriptionEntry } from '../types';

interface TranscriptionListProps {
  entries: TranscriptionEntry[];
  onReplay?: (text: string) => void;
}

export const TranscriptionList: React.FC<TranscriptionListProps> = ({ entries, onReplay }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div 
      ref={scrollRef}
      className="flex-1 w-full overflow-y-auto px-6 space-y-6 py-10 scroll-smooth custom-scrollbar"
    >
      {entries.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-gray-600 space-y-6 opacity-40">
          <div className="relative">
             <div className="absolute -inset-4 bg-blue-500/10 rounded-full blur-xl animate-pulse" />
             <svg className="w-16 h-16 relative" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
             </svg>
          </div>
          <p className="text-[10px] font-black tracking-[0.3em] uppercase">Listening for conversation...</p>
        </div>
      )}
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`flex flex-col ${entry.speaker === 'user' ? 'items-end' : 'items-start'} animate-fade-in group`}
        >
          <div
            className={`max-w-[85%] px-6 py-4 rounded-[2rem] text-sm leading-relaxed shadow-xl relative transition-all duration-300 ${
              entry.speaker === 'user'
                ? 'bg-blue-600 text-white rounded-tr-none'
                : 'bg-white/5 text-gray-100 border border-white/10 rounded-tl-none backdrop-blur-xl hover:bg-white/10'
            }`}
          >
            <div className="flex justify-between items-center mb-2">
              <span className={`block text-[9px] uppercase font-black tracking-widest opacity-60 ${
                entry.speaker === 'user' ? 'text-blue-100' : 'text-blue-400'
              }`}>
                {entry.speaker === 'user' ? 'Input' : 'Interpretation'}
              </span>
              {entry.speaker === 'model' && onReplay && (
                <button 
                  onClick={() => onReplay(entry.text.replace('[TTS Output]: ', ''))}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:text-blue-400"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                </button>
              )}
            </div>
            <div className="font-semibold whitespace-pre-wrap tracking-tight">
              {entry.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
