
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { DiscoveryEntry, Language, SUPPORTED_LANGUAGES } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import { LanguageSelector } from './components/LanguageSelector';

const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const CHAT_MODEL = 'gemini-3-flash-preview';

interface ExtendedDiscoveryEntry extends DiscoveryEntry {
  translation?: string;
  targetLangName: string;
  type?: 'voice' | 'text';
}

const App: React.FC = () => {
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [playingText, setPlayingText] = useState<string | null>(null);
  const [autoPlay, setAutoPlay] = useState(true);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [lastResult, setLastResult] = useState<ExtendedDiscoveryEntry | null>(null);
  const [history, setHistory] = useState<ExtendedDiscoveryEntry[]>([]);
  const [volume, setVolume] = useState(0);
  const [freqData, setFreqData] = useState<number[]>(new Array(12).fill(0));
  const [error, setError] = useState<string | null>(null);
  const [isFetchingTts, setIsFetchingTts] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);

  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const currentSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const transcriptionBufferRef = useRef<string>('');

  const unlockAudio = useCallback(async () => {
    if (!audioContextOutRef.current) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioContextOutRef.current = new AudioCtx({ sampleRate: SAMPLE_RATE_OUT });
    }
    if (audioContextOutRef.current.state === 'suspended') {
      await audioContextOutRef.current.resume();
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem('linguisty_history_unified_v2');
    if (saved) setHistory(JSON.parse(saved).slice(0, 10));
    
    const warmUp = () => {
      unlockAudio();
      window.removeEventListener('touchstart', warmUp);
      window.removeEventListener('mousedown', warmUp);
    };
    window.addEventListener('touchstart', warmUp);
    window.addEventListener('mousedown', warmUp);
    return () => {
      window.removeEventListener('touchstart', warmUp);
      window.removeEventListener('mousedown', warmUp);
    };
  }, [unlockAudio]);

  const saveToHistory = (entry: ExtendedDiscoveryEntry) => {
    setHistory(prev => {
      const updated = [entry, ...prev].slice(0, 10);
      localStorage.setItem('linguisty_history_unified_v2', JSON.stringify(updated));
      return updated;
    });
  };

  const stopAudio = () => {
    if (currentSourceRef.current) {
      try { currentSourceRef.current.stop(); } catch (e) {}
      currentSourceRef.current = null;
    }
    setPlayingId(null);
    setPlayingText(null);
  };

  const playAudio = async (text: string, id: string, langName: string) => {
    if (playingId === id) {
      stopAudio();
      return;
    }
    stopAudio();
    await unlockAudio();
    setPlayingId(id);
    setPlayingText(`${langName}: ${text}`);
    setIsFetchingTts(true);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          thinkingConfig: { thinkingBudget: 0 },
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio && audioContextOutRef.current) {
        const bytes = decode(base64Audio);
        const buffer = await decodeAudioData(bytes, audioContextOutRef.current, SAMPLE_RATE_OUT, 1);
        const source = audioContextOutRef.current.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContextOutRef.current.destination);
        source.onended = () => {
          if (currentSourceRef.current === source) {
            setPlayingId(null);
            setPlayingText(null);
          }
        };
        currentSourceRef.current = source;
        source.start(0);
      } else {
        setPlayingId(null);
        setPlayingText(null);
      }
    } catch (err) {
      setPlayingId(null);
      setPlayingText(null);
    } finally {
      setIsFetchingTts(false);
    }
  };

  const handleManualTranslate = async () => {
    if (!inputText.trim() || isTranslating) return;
    setIsTranslating(true);
    setError(null);
    // Don't clear lastResult immediately to allow comparison
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: CHAT_MODEL,
        contents: [{ parts: [{ text: `Translate to ${targetLang.name}: "${inputText}"` }] }],
        config: { thinkingConfig: { thinkingBudget: 0 } }
      });

      const translation = response.text?.trim() || "Translation unavailable";
      const entry: ExtendedDiscoveryEntry = {
        id: Date.now().toString(),
        languageName: "Manual Entry",
        snippet: inputText,
        translation,
        targetLangName: targetLang.name,
        timestamp: Date.now(),
        confidence: 'High',
        type: 'text'
      };

      setLastResult(entry);
      saveToHistory(entry);
      setInputText('');
      
      if (autoPlay) {
        playAudio(translation, entry.id, targetLang.name);
      }
    } catch (err) {
      setError("Translation error. Please try again.");
    } finally {
      setIsTranslating(false);
    }
  };

  const updateVisuals = () => {
    if (analyserRef.current && isListening) {
      const bufferLength = analyserRef.current.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyserRef.current.getByteFrequencyData(dataArray);
      setVolume(dataArray.reduce((a, b) => a + b, 0) / dataArray.length);
      const barsCount = 12;
      const step = Math.floor(bufferLength / barsCount);
      const newFreqData = [];
      for(let i=0; i<barsCount; i++) newFreqData.push(dataArray[i * step] || 0);
      setFreqData(newFreqData);
      animationFrameRef.current = requestAnimationFrame(updateVisuals);
    }
  };

  const stopListening = useCallback(() => {
    if (sessionRef.current) { try { sessionRef.current.close(); } catch (e) {} sessionRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    if (audioContextInRef.current) { audioContextInRef.current.close().catch(() => {}); audioContextInRef.current = null; }
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    setIsListening(false);
    setIsAnalyzing(false);
    setVolume(0);
    setFreqData(new Array(12).fill(0));
    transcriptionBufferRef.current = '';
  }, []);

  const processTranscription = (text: string) => {
    if (text.includes("DETECTED:")) {
      const rawContent = text.split("DETECTED:")[1];
      const parts = rawContent.split("|");
      if (parts.length >= 3) {
        const translation = parts[2]?.trim().replace(/['"]+/g, '') || "";
        const entry: ExtendedDiscoveryEntry = {
          id: Date.now().toString(),
          languageName: parts[0]?.trim() || "Unknown",
          snippet: parts[1]?.trim() || "...",
          translation,
          targetLangName: targetLang.name,
          timestamp: Date.now(),
          confidence: 'High',
          type: 'voice'
        };
        setLastResult(entry);
        saveToHistory(entry);
        stopListening();
        if (autoPlay && translation) playAudio(translation, entry.id, targetLang.name);
      }
    }
  };

  const startListening = async () => {
    setError(null);
    stopAudio();
    await unlockAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioContextInRef.current = new AudioCtx({ sampleRate: SAMPLE_RATE_IN });
      analyserRef.current = audioContextInRef.current.createAnalyser();
      analyserRef.current.fftSize = 64;
      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL,
        callbacks: {
          onopen: () => {
            if (!audioContextInRef.current) return;
            const source = audioContextInRef.current.createMediaStreamSource(stream);
            source.connect(analyserRef.current!);
            const scriptProcessor = audioContextInRef.current.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob })).catch(() => {});
            };
            analyserRef.current!.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current.destination);
            setIsListening(true);
            setIsAnalyzing(true);
            updateVisuals();
          },
          onmessage: async (m: LiveServerMessage) => {
            if (m.serverContent?.outputTranscription) {
              transcriptionBufferRef.current += m.serverContent.outputTranscription.text;
              processTranscription(transcriptionBufferRef.current);
            }
          },
          onerror: () => stopListening(),
          onclose: () => stopListening()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          thinkingConfig: { thinkingBudget: 0 },
          systemInstruction: `ID language. Reply: 'DETECTED: [Lang] | [Snippet] | [Translation to ${targetLang.name}]'. Fast only.`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setError("Mic access denied.");
      setIsListening(false);
    }
  };

  return (
    <div className={`flex flex-col h-full overflow-hidden transition-all duration-1000 ${isListening ? 'listening bg-cyan-950/20' : ''}`}>
      {isListening && (
        <>
          <div className="shazam-pulse" style={{ opacity: Math.min(0.6, volume / 40) }} />
          <div className="shazam-pulse pulse-delayed" style={{ opacity: Math.min(0.4, volume / 50) }} />
        </>
      )}

      {/* Header */}
      <header className="pt-10 px-6 z-20 flex flex-col items-center gap-4 shrink-0">
        <div className="flex w-full items-center justify-between">
          <button 
            onClick={() => setAutoPlay(!autoPlay)}
            className={`w-10 h-10 rounded-full glass flex items-center justify-center border transition-all ${autoPlay ? 'text-cyan-400 border-cyan-500/30' : 'text-white/20 border-white/5'}`}
          >
            <i className={`fa-solid ${autoPlay ? 'fa-volume-high' : 'fa-volume-xmark'} text-xs`} />
          </button>
          <div className="flex flex-col items-center">
             <h1 className="text-[10px] font-black tracking-[0.4em] uppercase text-white/40 mb-1">Linguisty</h1>
             <div className="w-8 h-1 bg-cyan-500 rounded-full opacity-50" />
          </div>
          <div className="w-10" />
        </div>
        <LanguageSelector selectedLanguage={targetLang} onSelect={setTargetLang} disabled={isListening || isTranslating} />
      </header>

      {/* Unified Dashboard */}
      <main className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4 flex flex-col gap-6 z-10">
        
        {/* Voice Section */}
        <section className="flex flex-col items-center py-4">
          <button
            onClick={isListening ? stopListening : startListening}
            className={`group relative w-44 h-44 rounded-full flex items-center justify-center transition-all duration-700 active:scale-95 ${isListening ? 'active-mic' : ''}`}
          >
            <div className={`absolute inset-0 rounded-full border-2 border-cyan-500/20 transition-transform duration-1000 ${isListening ? 'scale-125 opacity-0' : 'scale-100 opacity-100'}`} />
            <div className={`w-36 h-36 rounded-full flex flex-col items-center justify-center border-4 transition-all duration-500 shadow-2xl relative overflow-hidden ${
              isListening ? 'bg-cyan-500 border-cyan-300 scale-110' : 'bg-gradient-to-br from-slate-800 to-slate-900 border-white/10'
            }`}>
              {isListening && (
                <div className="absolute inset-0 flex items-center justify-center gap-1 opacity-60 px-6">
                  {freqData.map((val, idx) => (
                    <div key={idx} className="w-1 bg-white rounded-full transition-all duration-75" style={{ height: `${Math.max(4, (val / 255) * 60)}px`, opacity: 0.4 + (val / 255) }} />
                  ))}
                </div>
              )}
              <i className={`fa-solid ${isListening ? 'fa-stop text-2xl' : 'fa-microphone text-3xl'} text-white drop-shadow-lg z-10`} />
            </div>
          </button>
          <p className="mt-4 text-[8px] font-black tracking-[0.3em] uppercase text-white/20">
            {isListening ? (isAnalyzing ? 'Analyzing Audio...' : 'Listening...') : 'Tap to Detect Language'}
          </p>
        </section>

        {/* Text Input Bar */}
        <section className="w-full max-w-sm mx-auto">
           <div className="glass rounded-2xl p-1.5 border border-white/10 flex items-center gap-2 group transition-all focus-within:border-cyan-500/50 shadow-xl">
              <div className="pl-4 text-white/20"><i className="fa-solid fa-keyboard text-xs" /></div>
              <input 
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleManualTranslate()}
                placeholder="Or type to translate..."
                className="flex-1 bg-transparent py-3 px-2 text-sm font-bold text-white placeholder:text-white/20 focus:outline-none"
              />
              <button 
                disabled={!inputText.trim() || isTranslating}
                onClick={handleManualTranslate}
                className={`h-11 px-5 rounded-xl flex items-center gap-2 transition-all ${inputText.trim() ? 'bg-cyan-500 text-white shadow-lg' : 'bg-white/5 text-white/20'}`}
              >
                {isTranslating ? <i className="fa-solid fa-spinner fa-spin" /> : <i className="fa-solid fa-arrow-right" />}
              </button>
           </div>
        </section>

        {/* Live Result Card (Unified on same page) */}
        {lastResult && (
          <section className="w-full max-w-sm mx-auto animate-pop">
            <div className="glass rounded-3xl p-6 border-2 border-cyan-500/20 shadow-2xl relative overflow-hidden">
              <div className="absolute top-0 right-0 p-3">
                <button onClick={() => setLastResult(null)} className="text-white/20 hover:text-white/40"><i className="fa-solid fa-xmark text-xs" /></button>
              </div>
              <div className="flex items-start gap-4 mb-4">
                <button 
                  disabled={isFetchingTts}
                  onClick={() => lastResult.translation && playAudio(lastResult.translation, lastResult.id, lastResult.targetLangName)}
                  className={`w-12 h-12 rounded-full flex items-center justify-center border transition-all shrink-0 ${playingId === lastResult.id ? 'bg-cyan-500 border-cyan-400' : 'bg-cyan-500/20 border-cyan-500/30 text-cyan-400'}`}
                >
                  {isFetchingTts ? <i className="fa-solid fa-spinner fa-spin text-xs" /> : <i className={`fa-solid ${playingId === lastResult.id ? 'fa-stop' : 'fa-play ml-0.5'} text-sm`} />}
                </button>
                <div className="overflow-hidden">
                  <span className="text-[7px] font-black uppercase tracking-widest text-cyan-400/60 block mb-0.5">{lastResult.type === 'text' ? 'Translation' : 'Detected'}</span>
                  <h2 className="text-xl font-black tracking-tight truncate">{lastResult.type === 'text' ? lastResult.targetLangName : lastResult.languageName}</h2>
                </div>
              </div>
              <div className="space-y-3">
                <div className="bg-black/20 rounded-xl p-3 border border-white/5">
                  <p className="text-[11px] text-white/50 italic leading-snug line-clamp-2">"{lastResult.snippet}"</p>
                </div>
                <div className="bg-cyan-500/5 rounded-xl p-3 border border-cyan-500/10">
                  <p className="text-[12px] font-bold text-white leading-snug">{lastResult.translation}</p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* History Tray */}
        <section className="w-full max-w-sm mx-auto flex flex-col gap-3 pb-4">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-[8px] font-black uppercase tracking-[0.3em] text-white/20">Recent Activity</h3>
            {history.length > 0 && <button onClick={() => setHistory([])} className="text-[7px] font-black uppercase tracking-widest text-red-400/50">Clear</button>}
          </div>
          <div className="flex flex-col gap-2">
            {history.length === 0 ? (
              <div className="glass rounded-2xl p-8 border border-dashed border-white/5 flex flex-col items-center justify-center opacity-20">
                <i className="fa-solid fa-clock-rotate-left mb-2 text-sm" />
                <p className="text-[8px] font-black uppercase tracking-widest">History is empty</p>
              </div>
            ) : (
              history.map(item => (
                <div key={item.id} className="glass flex items-center justify-between p-3 rounded-2xl border border-white/5 group transition-all">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${item.type === 'text' ? 'bg-purple-500/20 text-purple-400' : 'bg-cyan-500/20 text-cyan-400'}`}>
                      <i className={`fa-solid ${item.type === 'text' ? 'fa-keyboard' : 'fa-microphone'} text-[8px]`} />
                    </div>
                    <div className="flex flex-col gap-0.5 overflow-hidden">
                      <span className="text-[10px] font-black truncate">{item.type === 'text' ? `To ${item.targetLangName}` : item.languageName}</span>
                      <span className="text-[8px] text-white/30 truncate block max-w-[160px]">"{item.snippet}"</span>
                    </div>
                  </div>
                  <button 
                    onClick={() => item.translation && playAudio(item.translation, item.id, item.targetLangName)}
                    className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 active:scale-90 transition-all ${playingId === item.id ? 'bg-cyan-500 text-white' : 'bg-cyan-500/10 text-cyan-400'}`}
                  >
                    <i className={`fa-solid ${playingId === item.id ? 'fa-stop' : 'fa-play ml-0.5'} text-[8px]`} />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {/* Persistent Audio Feedback */}
      {(playingId || isFetchingTts) && (
        <div className="fixed bottom-6 left-6 right-6 z-50 animate-pop">
          <div className="glass rounded-full px-5 py-3 border border-cyan-500/40 shadow-2xl flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 overflow-hidden">
               <div className="flex items-center gap-1">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="w-0.5 bg-cyan-400 rounded-full animate-pulse" style={{ height: isFetchingTts ? '4px' : `${Math.random() * 12 + 4}px`, animationDuration: `${0.3 + i * 0.1}s` }} />
                ))}
              </div>
              <p className="text-[9px] font-bold text-white truncate max-w-[180px]">
                {isFetchingTts ? "Generating translation..." : playingText}
              </p>
            </div>
            <button onClick={stopAudio} className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white"><i className="fa-solid fa-stop text-[8px]" /></button>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-x-6 top-8 z-50 p-3 backdrop-blur-xl bg-red-500/20 border border-red-500/30 rounded-xl flex items-center justify-between shadow-2xl animate-pop">
          <p className="text-[8px] font-black uppercase tracking-widest text-red-200">{error}</p>
          <button onClick={() => setError(null)}><i className="fa-solid fa-xmark text-red-200/50" /></button>
        </div>
      )}
    </div>
  );
};

export default App;
