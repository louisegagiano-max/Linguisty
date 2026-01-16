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
      className="h-full w-full overflow-y-auto px-6 py-4 space-y-5 scroll-smooth custom-scrollbar"
    >
      {entries.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-white/20">
          <p className="text-[10px] font-black tracking-[0.2em] uppercase text-center">
            No translation history<br/>captured yet
          </p>
        </div>
      )}
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="animate-fade-in group flex flex-col border-l-2 border-blue-500/20 pl-4 py-1 hover:border-blue-500/60 transition-colors"
        >
          <div className="flex items-center justify-between mb-2">
             <div className="flex items-center gap-2">
               <span className="bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded text-[8px] font-black tracking-widest uppercase border border-blue-500/30">
                 {entry.detectedLanguage || 'Translation'}
               </span>
               <span className="text-[8px] text-white/20 font-mono">
                 {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
               </span>
             </div>
             {onReplay && entry.outputText && (
               <button 
                 onClick={() => onReplay(entry.outputText)}
                 className="w-10 h-10 flex items-center justify-center bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 rounded-full text-blue-400 transition-all active:scale-90 shadow-sm"
                 title="Replay translation"
               >
                 <i className="fa-solid fa-play text-sm ml-0.5" />
               </button>
             )}
          </div>
          
          {entry.inputText && (
            <div className="flex flex-col mb-2">
              <span className="text-[7px] uppercase font-black tracking-widest text-white/20 mb-0.5">Original</span>
              <p className="text-[10px] text-white/50 italic leading-tight">
                "{entry.inputText.trim()}"
              </p>
            </div>
          )}
          
          <div className="flex flex-col">
            <span className="text-[7px] uppercase font-black tracking-widest text-blue-400 mb-0.5">Translation</span>
            <p className="text-xs font-bold text-white leading-relaxed">
              {entry.outputText.trim()}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
};