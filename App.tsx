
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
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [lastResult, setLastResult] = useState<ExtendedDiscoveryEntry | null>(null);
  const [history, setHistory] = useState<ExtendedDiscoveryEntry[]>([]);
  const [volume, setVolume] = useState(0);
  const [freqData, setFreqData] = useState<number[]>(new Array(12).fill(0));
  const [error, setError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);

  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentOutputTranscriptionRef = useRef<string>('');

  // Check for API key on mount
  useEffect(() => {
    const checkKey = async () => {
      // If process.env.API_KEY is already set, we might be good, 
      // but let's check the studio selection state too
      if (typeof (window as any).aistudio !== 'undefined') {
        const selected = await (window as any).aistudio.hasSelectedApiKey();
        setHasKey(selected || !!process.env.API_KEY);
      } else {
        setHasKey(!!process.env.API_KEY);
      }
    };
    checkKey();
  }, []);

  const handleOpenKeyDialog = async () => {
    if (typeof (window as any).aistudio !== 'undefined') {
      await (window as any).aistudio.openSelectKey();
      // Assume success as per instructions to avoid race conditions
      setHasKey(true);
    }
  };

  const unlockAudio = useCallback(async () => {
    try {
      if (!audioContextOutRef.current) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        audioContextOutRef.current = new AudioCtx({ sampleRate: SAMPLE_RATE_OUT });
      }
      if (audioContextOutRef.current.state === 'suspended') {
        await audioContextOutRef.current.resume();
      }
    } catch (e) {
      console.warn("Could not unlock audio context:", e);
    }
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem('linguisty_v9_history');
    if (saved) setHistory(JSON.parse(saved).slice(0, 10));
    
    const warmUp = () => unlockAudio();
    window.addEventListener('mousedown', warmUp, { once: false });
    window.addEventListener('touchstart', warmUp, { once: false });
    return () => {
      window.removeEventListener('mousedown', warmUp);
      window.removeEventListener('touchstart', warmUp);
    };
  }, [unlockAudio]);

  const stopAllAudio = () => {
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
  };

  const playPcmData = async (base64Data: string) => {
    await unlockAudio();
    if (!audioContextOutRef.current) return;
    const ctx = audioContextOutRef.current;
    setIsSpeaking(true);
    try {
      const bytes = decode(base64Data);
      const audioBuffer = await decodeAudioData(bytes, ctx, SAMPLE_RATE_OUT, 1);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        audioSourcesRef.current.delete(source);
        if (audioSourcesRef.current.size === 0) setIsSpeaking(false);
      };
      nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += audioBuffer.duration;
      audioSourcesRef.current.add(source);
    } catch (err) {
      setIsSpeaking(false);
    }
  };

  const speakText = async (text: string) => {
    stopAllAudio();
    setIsSpeaking(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
      });
      const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (data) {
        await playPcmData(data);
      } else {
        setIsSpeaking(false);
      }
    } catch (e) {
      setIsSpeaking(false);
    }
  };

  const handleManualTranslate = async () => {
    if (!inputText.trim() || isTranslating) return;
    setIsTranslating(true);
    setError(null);
    stopAllAudio();
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: CHAT_MODEL,
        contents: [{ parts: [{ text: `Translate this into ${targetLang.name}: "${inputText}"` }] }],
      });
      const translation = response.text?.trim() || "";
      if (translation) {
        const entry: ExtendedDiscoveryEntry = {
          id: Date.now().toString(),
          languageName: "Text Input",
          snippet: inputText,
          translation,
          targetLangName: targetLang.name,
          timestamp: Date.now(),
          confidence: 'High',
          type: 'text'
        };
        setLastResult(entry);
        setHistory(prev => {
          const updated = [entry, ...prev].slice(0, 10);
          localStorage.setItem('linguisty_v9_history', JSON.stringify(updated));
          return updated;
        });
        setInputText('');
        await speakText(translation);
      }
    } catch (err: any) {
      if (err.message?.includes("API Key")) {
        setHasKey(false);
      }
      setError("Translation failed.");
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
    setVolume(0);
    setFreqData(new Array(12).fill(0));
  }, []);

  const handleLiveMessage = async (message: LiveServerMessage) => {
    const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
    if (base64Audio) { await playPcmData(base64Audio); }
    if (message.serverContent?.outputTranscription) { currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text; }
    if (message.serverContent?.turnComplete) {
      const fullText = currentOutputTranscriptionRef.current;
      const match = fullText.match(/([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)/i);
      if (match) {
        const entry: ExtendedDiscoveryEntry = {
          id: Date.now().toString(),
          languageName: match[1].trim(),
          snippet: match[2].trim(),
          translation: match[3].trim(),
          targetLangName: targetLang.name,
          timestamp: Date.now(),
          confidence: 'High',
          type: 'voice'
        };
        setLastResult(entry);
        setHistory(prev => {
          const updated = [entry, ...prev].slice(0, 10);
          localStorage.setItem('linguisty_v9_history', JSON.stringify(updated));
          return updated;
        });
      }
      currentOutputTranscriptionRef.current = '';
    }
    if (message.serverContent?.interrupted) { stopAllAudio(); }
  };

  const startListening = async () => {
    setError(null);
    stopAllAudio();
    setLastResult(null);
    await unlockAudio();
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Microphone API not supported.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioCtx({ sampleRate: SAMPLE_RATE_IN });
      audioContextInRef.current = inputCtx;
      analyserRef.current = inputCtx.createAnalyser();
      analyserRef.current.fftSize = 64;
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL,
        callbacks: {
          onopen: () => {
            if (!audioContextInRef.current || !streamRef.current) return;
            const source = audioContextInRef.current.createMediaStreamSource(streamRef.current);
            const scriptProcessor = audioContextInRef.current.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob })).catch(() => {});
            };
            source.connect(analyserRef.current!);
            analyserRef.current!.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current.destination);
            setIsListening(true);
            updateVisuals();
          },
          onmessage: handleLiveMessage,
          onerror: (e) => {
            if (e.message?.includes("API Key") || e.message?.includes("not found")) {
               setHasKey(false);
            }
            setError("Connection error.");
            stopListening();
          },
          onclose: () => stopListening()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: `Identify language. Speak translation in ${targetLang.name}. Transcription format: [Detected Language] | [Snippet] | [Full Translation].`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      if (err.message?.includes("API Key")) {
        setHasKey(false);
      }
      const msg = err.name === 'NotAllowedError' ? "Permission denied." : 
                  err.message.includes("API Key") ? "API Key required." : 
                  `Error: ${err.message}`;
      setError(msg);
      setIsListening(false);
    }
  };

  if (hasKey === false) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center bg-slate-950">
        <div className="w-20 h-20 rounded-3xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 mb-8 border border-cyan-500/20">
          <i className="fa-solid fa-key text-3xl" />
        </div>
        <h2 className="text-2xl font-black text-white mb-4 uppercase tracking-widest">Setup Required</h2>
        <p className="text-white/50 text-sm max-w-xs mb-8 leading-relaxed">
          Linguisty requires a paid API key to perform real-time voice translation. Please select a key from a paid GCP project.
        </p>
        <button 
          onClick={handleOpenKeyDialog}
          className="w-full max-w-xs bg-cyan-500 hover:bg-cyan-400 text-white font-black py-4 rounded-2xl transition-all shadow-[0_0_30px_rgba(6,182,212,0.3)] mb-4 uppercase tracking-widest text-xs"
        >
          Connect API Key
        </button>
        <a 
          href="https://ai.google.dev/gemini-api/docs/billing" 
          target="_blank" 
          className="text-[10px] text-white/30 hover:text-cyan-400 transition-colors uppercase font-bold tracking-widest"
        >
          View Billing Documentation
        </a>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full overflow-hidden transition-all duration-1000 ${isListening ? 'listening bg-cyan-950/20' : ''}`}>
      {isListening && <div className="shazam-pulse" style={{ opacity: Math.min(0.6, volume / 40) }} />}

      <header className="pt-10 px-6 z-20 flex flex-col items-center gap-4 shrink-0">
        <div className="flex w-full items-center justify-center">
          <div className="flex flex-col items-center">
             <h1 className="text-[10px] font-black tracking-[0.4em] uppercase text-white/40 mb-1 text-center">Linguisty</h1>
             <div className="w-8 h-1 bg-cyan-500 rounded-full opacity-50" />
          </div>
        </div>
        <LanguageSelector selectedLanguage={targetLang} onSelect={setTargetLang} disabled={isListening} />
      </header>

      <main className="flex-1 overflow-y-auto custom-scrollbar px-6 py-4 flex flex-col gap-6 z-10">
        <section className="flex flex-col items-center py-4">
          <button
            onClick={isListening ? stopListening : startListening}
            className={`group relative w-44 h-44 rounded-full flex items-center justify-center transition-all duration-700 active:scale-95 ${isListening ? 'active-mic' : ''}`}
          >
            <div className={`absolute inset-0 rounded-full border-2 border-cyan-500/20 transition-transform duration-1000 ${isListening ? 'scale-125 opacity-0' : 'scale-100 opacity-100'}`} />
            <div className={`w-36 h-36 rounded-full flex flex-col items-center justify-center border-4 transition-all duration-500 shadow-2xl relative overflow-hidden ${
              isListening ? 'bg-cyan-500 border-cyan-300 scale-105' : 'bg-gradient-to-br from-slate-800 to-slate-900 border-white/10 hover:border-cyan-500/50'
            }`}>
              {isListening && (
                <div className="absolute inset-0 flex items-center justify-center gap-1 opacity-60 px-8">
                  {freqData.map((val, idx) => (
                    <div key={idx} className="w-1 bg-white rounded-full transition-all duration-75" style={{ height: `${Math.max(4, (val / 255) * 60)}px`, opacity: 0.4 + (val / 255) }} />
                  ))}
                </div>
              )}
              <i className={`fa-solid ${isListening ? 'fa-stop text-2xl' : 'fa-microphone text-4xl'} text-white drop-shadow-lg z-10`} />
            </div>
          </button>
          <p className="mt-4 text-[9px] font-black uppercase tracking-[0.4em] text-cyan-400/60 text-center">
            {isListening ? 'Listening...' : 'Tap to Detect & Speak'}
          </p>
        </section>

        <section className="w-full max-w-sm mx-auto">
           <div className="glass rounded-2xl p-1.5 border border-white/10 flex items-center gap-2 focus-within:border-cyan-500/50 transition-all shadow-xl">
              <div className="pl-4 text-white/20"><i className="fa-solid fa-keyboard text-xs" /></div>
              <input 
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleManualTranslate()}
                placeholder="Type to translate..."
                className="flex-1 bg-transparent py-3 px-2 text-sm font-bold text-white placeholder:text-white/20 focus:outline-none"
              />
              <button 
                disabled={!inputText.trim() || isTranslating}
                onClick={handleManualTranslate}
                className={`h-11 px-5 rounded-xl transition-all ${inputText.trim() ? 'bg-cyan-500 text-white shadow-lg' : 'bg-white/5 text-white/20'}`}
              >
                {isTranslating ? <i className="fa-solid fa-spinner fa-spin" /> : <i className="fa-solid fa-arrow-right" />}
              </button>
           </div>
        </section>

        {lastResult && (
          <section className="w-full max-w-sm mx-auto animate-pop">
            <div className="glass rounded-[32px] p-6 border border-cyan-500/30 shadow-2xl relative">
              <div className="mb-4">
                <span className="text-[8px] font-black uppercase tracking-[0.3em] text-cyan-400/80 mb-2 block">Latest Result</span>
                <h2 className="text-2xl font-black text-white leading-tight mb-2">
                  {lastResult.translation}
                </h2>
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-bold text-white/30 uppercase tracking-widest">
                    {lastResult.languageName}
                  </span>
                  <i className="fa-solid fa-chevron-right text-[7px] text-white/10" />
                  <span className="text-[9px] font-black text-cyan-400 uppercase tracking-widest">
                    {lastResult.targetLangName}
                  </span>
                </div>
              </div>
              <div className="pt-4 border-t border-white/5 text-[11px] text-white/50 italic">
                "{lastResult.snippet}"
              </div>
            </div>
          </section>
        )}

        <section className="w-full max-w-sm mx-auto flex flex-col gap-3 pb-12">
          <div className="flex items-center justify-between px-2">
            <h3 className="text-[9px] font-black uppercase tracking-[0.3em] text-white/20">History</h3>
            {history.length > 0 && <button onClick={() => setHistory([])} className="text-[8px] font-bold text-red-400/40">Clear</button>}
          </div>
          <div className="flex flex-col gap-2">
            {history.map(item => (
              <div 
                key={item.id} 
                onClick={() => speakText(item.translation || "")}
                className="glass flex items-center justify-between p-4 rounded-2xl border border-white/5 hover:border-white/10 transition-all cursor-pointer group"
              >
                <div className="flex-1 min-w-0 pr-4">
                  <span className="text-[11px] font-black block text-white/90 truncate">{item.translation}</span>
                  <span className="text-[9px] font-medium text-white/20 uppercase tracking-tighter">
                    {item.type === 'text' ? 'Keyboard' : item.languageName}
                  </span>
                </div>
                <div className="text-white/10 group-hover:text-cyan-400 transition-colors">
                  <i className="fa-solid fa-play text-[9px]" />
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {isSpeaking && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 animate-pop">
          <div className="bg-cyan-500 rounded-full px-5 py-2.5 shadow-2xl flex items-center gap-3">
             <div className="flex gap-1 items-end h-3">
                <div className="w-1 bg-white rounded-full animate-bounce h-2" style={{animationDelay: '0s'}} />
                <div className="w-1 bg-white rounded-full animate-bounce h-3" style={{animationDelay: '0.1s'}} />
                <div className="w-1 bg-white rounded-full animate-bounce h-2" style={{animationDelay: '0.2s'}} />
             </div>
             <span className="text-[9px] font-black uppercase tracking-[0.2em] text-white">Speaking</span>
          </div>
        </div>
      )}

      {error && (
        <div className="fixed bottom-6 left-6 right-6 z-50 p-4 backdrop-blur-2xl bg-red-500/90 rounded-2xl flex items-center justify-between shadow-2xl animate-pop">
          <p className="text-[10px] font-bold uppercase tracking-widest text-white leading-tight">{error}</p>
          <button onClick={() => setError(null)} className="text-white/80 shrink-0 ml-4"><i className="fa-solid fa-xmark" /></button>
        </div>
      )}
    </div>
  );
};

export default App;
