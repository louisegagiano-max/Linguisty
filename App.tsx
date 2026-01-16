
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SUPPORTED_LANGUAGES, TranscriptionEntry, Language } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import { LanguageSelector } from './components/LanguageSelector';
import { TranscriptionList } from './components/TranscriptionList';

// Environment variable handling fixed: replaced import.meta.env with process.env.API_KEY as per guidelines.

const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const TRANSLATE_MODEL = 'gemini-3-flash-preview';
const INPUT_BUFFER_SIZE = 2048;

const App: React.FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);
  const [history, setHistory] = useState<TranscriptionEntry[]>([]);
  const [isReplaying, setIsReplaying] = useState(false);
  const [manualText, setManualText] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);

  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');
  const sessionRef = useRef<any>(null);
  const animationFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const getAudioContext = useCallback((sampleRate: number) => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    return new AudioCtx({ sampleRate });
  }, []);

  // Updated useEffect: Removed API key initialization check as process.env.API_KEY is assumed to be present.
  useEffect(() => {
    const saved = localStorage.getItem('linguisty-history-v4');
    if (saved) {
      try { setHistory(JSON.parse(saved)); } catch (e) { console.error("History load error", e); }
    }
  }, []);

  const unlockAudio = async () => {
    try {
      if (!audioContextOutRef.current) {
        audioContextOutRef.current = getAudioContext(SAMPLE_RATE_OUT);
      }
      const ctx = audioContextOutRef.current;
      if (ctx.state === 'suspended' || (ctx.state as string) === 'interrupted') {
        await ctx.resume();
      }
      
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (e) {
      console.error("Audio unlock failed", e);
    }
  };

  const saveToHistory = useCallback((entry: TranscriptionEntry) => {
    setHistory(prev => {
      const updated = [entry, ...prev].slice(0, 30);
      localStorage.setItem('linguisty-history-v4', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const updateVisuals = () => {
    if (analyserRef.current && isListening) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      setVolume(average);
      animationFrameRef.current = requestAnimationFrame(updateVisuals);
    }
  };

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (audioContextInRef.current) {
      audioContextInRef.current.close().catch(() => {});
      audioContextInRef.current = null;
    }
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    
    sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
    sourcesRef.current.clear();
    setIsListening(false);
    setVolume(0);
  }, []);

  const playAudioBytes = async (base64Audio: string, isManualReplay = false) => {
    try {
      if (!audioContextOutRef.current) {
        audioContextOutRef.current = getAudioContext(SAMPLE_RATE_OUT);
      }
      const ctx = audioContextOutRef.current;
      if (ctx.state === 'suspended') await ctx.resume();
      
      nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
      const decodedData = decode(base64Audio);
      const audioBuffer = await decodeAudioData(decodedData, ctx, SAMPLE_RATE_OUT, 1);
      
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      source.onended = () => {
        sourcesRef.current.delete(source);
        if (isManualReplay && sourcesRef.current.size === 0) setIsReplaying(false);
      };
      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += audioBuffer.duration;
      sourcesRef.current.add(source);
    } catch (e) {
      console.error("Playback error:", e);
      if (isManualReplay) setIsReplaying(false);
    }
  };

  const startSession = async () => {
    await unlockAudio();
    
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
      });
      
      streamRef.current = stream;
      // Fixed: Initializing GoogleGenAI with process.env.API_KEY directly inside the call.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      audioContextInRef.current = getAudioContext(SAMPLE_RATE_IN);
      if (audioContextInRef.current.state === 'suspended') await audioContextInRef.current.resume();

      analyserRef.current = audioContextInRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;

      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL,
        callbacks: {
          onopen: () => {
            if (!audioContextInRef.current) return;
            const source = audioContextInRef.current.createMediaStreamSource(stream);
            source.connect(analyserRef.current!);
            
            const scriptProcessor = audioContextInRef.current.createScriptProcessor(INPUT_BUFFER_SIZE, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
            };

            analyserRef.current!.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current.destination);
            setIsListening(true);
            updateVisuals();
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && voiceEnabled) await playAudioBytes(base64Audio);

            if (message.serverContent?.inputTranscription) currentInputTranscription.current += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) currentOutputTranscription.current += message.serverContent.outputTranscription.text;

            if (message.serverContent?.turnComplete) {
              const outText = currentOutputTranscription.current.trim();
              if (currentInputTranscription.current.trim() || outText) {
                const entry: TranscriptionEntry = {
                   id: `live-${Date.now()}`,
                   speaker: 'model',
                   inputText: currentInputTranscription.current.trim(),
                   outputText: outText,
                   timestamp: Date.now(),
                   detectedLanguage: 'Live Mode'
                };
                setTranscriptions(prev => [...prev, entry]);
                saveToHistory(entry);
              }
              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: any) => {
            console.error("Live Error:", e);
            setError('Connection failed. Please ensure your project is billing-enabled.');
            stopSession();
          },
          onclose: () => stopSession()
        },
        config: {
          responseModalalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: `You are Linguisty, a real-time translator. Detect the spoken language and translate it instantly to ${targetLang.name}. Focus on natural flow. Supporting South African languages is a priority.`
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error("Start Error:", err);
      setError('Mic or Key error: ' + (err.message || 'Check project permissions.'));
      stopSession();
    }
  };

  const handleManualTranslate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!manualText.trim() || isTranslating) return;

    await unlockAudio();
    const originalText = manualText;
    setManualText('');
    setIsTranslating(true);
    setError(null);

    try {
      // Fixed: Initializing GoogleGenAI with process.env.API_KEY directly as per guidelines.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const translationResponse = await ai.models.generateContent({
        model: TRANSLATE_MODEL,
        contents: `Translate to ${targetLang.name}. Return ONLY the translation. Text: "${originalText}"`,
      });
      
      const translatedText = translationResponse.text?.trim() || "";
      if (!translatedText) throw new Error("Translation failed.");

      const ttsResponse = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: translatedText }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
      });

      const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;
      if (base64Audio) await playAudioBytes(base64Audio, true);

      const entry: TranscriptionEntry = {
        id: `man-${Date.now()}`,
        speaker: 'model',
        inputText: originalText,
        outputText: translatedText,
        timestamp: Date.now(),
        detectedLanguage: 'Manual Input'
      };
      setTranscriptions(prev => [...prev, entry]);
      saveToHistory(entry);
    } catch (err: any) {
      console.error("Manual Translate Error:", err);
      setError("Translation failed. Please try again.");
      setManualText(originalText); 
    } finally {
      setIsTranslating(false);
    }
  };

  const handleReplay = async (text: string) => {
    if (isReplaying) return;
    await unlockAudio();
    
    try {
      setIsReplaying(true);
      // Fixed: Initializing GoogleGenAI with process.env.API_KEY directly inside the call.
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) await playAudioBytes(base64Audio, true);
      else setIsReplaying(false);
    } catch (err) { 
      console.error("Replay error:", err);
      setIsReplaying(false); 
    }
  };

  // Fixed: Removed the conditional "API Key Required" UI as per guidelines.

  return (
    <div className="flex flex-col h-full max-w-md mx-auto overflow-hidden bg-transparent text-white relative">
      <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-blue-500/10 blur-[100px] rounded-full transition-all duration-1000 ${isListening ? 'scale-150 opacity-50' : 'scale-100 opacity-20'}`} />
      
      <header className="pt-8 pb-2 px-6 z-10 flex items-center justify-between shrink-0">
        <h1 className="text-sm font-black tracking-[0.4em] uppercase opacity-60">Linguisty</h1>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => setVoiceEnabled(!voiceEnabled)}
            className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all ${voiceEnabled ? 'bg-blue-500/20 border-blue-500/40 text-blue-400' : 'bg-white/5 border-white/10 text-white/40'}`}
          >
            <i className={`fa-solid ${voiceEnabled ? 'fa-volume-high' : 'fa-volume-xmark'} mr-2`} />
            {voiceEnabled ? 'Voice On' : 'Muted'}
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center px-6 pb-4 z-10 overflow-hidden">
        <div className="h-8 flex items-center justify-center shrink-0">
          {isListening && (
            <div className="flex items-center gap-2">
               <div className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-ping" />
               <p className="text-[10px] font-bold tracking-widest text-blue-400 uppercase">Live Translation</p>
            </div>
          )}
        </div>

        <div className="w-full px-2 z-30 mb-4 shrink-0">
          <form onSubmit={handleManualTranslate} className="relative group">
            <input 
              type="text"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              onFocus={unlockAudio}
              placeholder={isTranslating ? "Processing..." : "Type text to translate..."}
              disabled={isTranslating}
              className="w-full bg-white/5 border border-white/10 rounded-2xl py-3 px-5 pr-12 text-sm text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all glass"
            />
            <button 
              type="submit"
              disabled={!manualText.trim() || isTranslating}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-blue-400 hover:text-blue-300 disabled:opacity-30 transition-colors"
            >
              <i className={`fa-solid ${isTranslating ? 'fa-circle-notch fa-spin' : 'fa-paper-plane'}`} />
            </button>
          </form>
        </div>

        <div className="relative shrink-0 w-full flex-1 flex flex-col items-center justify-center py-4">
          {isListening && (
            <>
              <div className="shazam-pulse" style={{ animationDuration: '3s' }} />
              <div className="shazam-pulse" style={{ animationDuration: '2s', width: '180px', height: '180px' }} />
              <div className="shazam-pulse" style={{ 
                animationDuration: '1s', 
                width: '130px', 
                height: '130px', 
                background: `rgba(59, 130, 246, ${Math.min(0.8, volume / 100)})` 
              }} />
            </>
          )}
          
          <button
            onClick={isListening ? stopSession : startSession}
            className={`relative z-20 w-32 h-32 rounded-full flex items-center justify-center transition-all duration-500 glass group ${
              isListening ? 'scale-110 border-blue-400/50 shadow-[0_0_50px_rgba(59,130,246,0.4)]' : 'hover:scale-105 border-white/10'
            }`}
            style={{ 
              boxShadow: isListening 
                ? `0 0 ${20 + volume}px rgba(59, 130, 246, 0.6)` 
                : '0 0 30px rgba(0,0,0,0.5)',
              borderWidth: '4px'
            }}
          >
            <div className={`absolute inset-0 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 opacity-0 group-hover:opacity-10 transition-opacity duration-500`} />
            <div className="flex flex-col items-center">
              <i className={`fa-solid ${isListening ? 'fa-stop text-xl' : 'fa-microphone text-2xl'} text-white transition-all`} />
            </div>
          </button>
          
          <div className="mt-4 text-center h-4">
            <p className="text-[9px] font-black tracking-[0.5em] text-white/40 uppercase">
              {isListening ? 'Active Listening' : 'Tap to Start Listening'}
            </p>
          </div>
        </div>

        <div className="w-full flex-[1.8] flex flex-col min-h-0 space-y-3 mt-2">
          <div className="glass rounded-[2rem] p-4 border border-white/10 shrink-0">
            <LanguageSelector selectedLanguage={targetLang} onSelect={setTargetLang} disabled={isListening} />
          </div>

          <div className="flex-1 glass rounded-[2rem] overflow-hidden border border-white/10 relative min-h-0">
             <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-black/20 to-transparent pointer-events-none z-10" />
             <TranscriptionList 
               entries={transcriptions.length > 0 ? transcriptions : history} 
               onReplay={handleReplay}
             />
             {isReplaying && (
               <div className="absolute bottom-4 right-6 flex items-center gap-1.5 animate-pulse text-[9px] font-black text-blue-400 uppercase bg-[#0f172a] px-3 py-1.5 rounded-full border border-blue-500/20 shadow-2xl z-20">
                 <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-ping" />
                 Playing Audio
               </div>
             )}
          </div>
        </div>
      </main>

      {error && (
        <div className="absolute top-6 left-6 right-6 z-50 p-4 bg-red-500/90 backdrop-blur-md text-white rounded-2xl text-[11px] font-bold text-center shadow-2xl animate-fade-in flex items-center justify-between border border-red-400/20">
          <span className="flex-1 px-2">{error}</span>
          <button onClick={() => setError(null)} className="p-2 hover:bg-white/10 rounded-lg">
            <i className="fa-solid fa-times" />
          </button>
        </div>
      )}

      <footer className="p-4 text-center text-[7px] text-white/10 font-black uppercase tracking-[0.4em] z-10 shrink-0">
        Linguisty V4.3 • Netlify Optimized
      </footer>
    </div>
  );
};

export default App;
