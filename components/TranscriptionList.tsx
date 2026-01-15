
import React, { useEffect, useRef } from 'react';
import { TranscriptionEntry } from '../types';

interface TranscriptionListProps {
  entries: TranscriptionEntry[];
}

export const TranscriptionList: React.FC<TranscriptionListProps> = ({ entries }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div 
      ref={scrollRef}
      className="flex-1 w-full overflow-y-auto px-6 space-y-6 py-8 scroll-smooth custom-scrollbar"
    >
      {entries.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-gray-500 space-y-4 opacity-50">
          <svg className="w-16 h-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
          <p className="text-sm font-medium tracking-wide">Waiting for audio context...</p>
        </div>
      )}
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`flex flex-col ${entry.speaker === 'user' ? 'items-end' : 'items-start'} animate-fade-in`}
        >
          <div
            className={`max-w-[90%] px-6 py-5 rounded-3xl text-base leading-relaxed shadow-lg ${
              entry.speaker === 'user'
                ? 'bg-blue-600 text-white rounded-tr-none'
                : 'bg-white/10 text-gray-100 border border-white/10 rounded-tl-none backdrop-blur-md'
            }`}
          >
            <span className={`block text-[11px] uppercase font-black tracking-widest opacity-60 mb-2 ${
              entry.speaker === 'user' ? 'text-blue-100' : 'text-blue-400'
            }`}>
              {entry.speaker === 'user' ? 'Input' : 'Interpretation'}
            </span>
            <div className="font-medium whitespace-pre-wrap">
              {entry.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
