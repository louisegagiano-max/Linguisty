import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SUPPORTED_LANGUAGES, TranscriptionEntry, Language } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import { LanguageSelector } from './components/LanguageSelector';
import { TranscriptionList } from './components/TranscriptionList';

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
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
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

  useEffect(() => {
    const saved = localStorage.getItem('lingo-history-v2');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  }, []);

  const saveToHistory = useCallback((entry: TranscriptionEntry) => {
    setHistory(prev => {
      const updated = [entry, ...prev].slice(0, 15);
      localStorage.setItem('lingo-history-v2', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const updateVisuals = () => {
    if (analyserRef.current && isListening) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
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
      audioContextInRef.current.close();
      audioContextInRef.current = null;
    }
    if (audioContextOutRef.current) {
      audioContextOutRef.current.close();
      audioContextOutRef.current = null;
    }
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    
    sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
    sourcesRef.current.clear();
    setIsListening(false);
    setVolume(0);
  }, []);

  const playAudioBytes = async (base64Audio: string, isManualReplay = false) => {
    if (!audioContextOutRef.current) {
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_OUT });
    }
    const ctx = audioContextOutRef.current;
    if (ctx.state === 'suspended') await ctx.resume();
    
    nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
    const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, SAMPLE_RATE_OUT, 1);
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
  };

  const handleManualTranslate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!manualText.trim() || isTranslating) return;

    const originalText = manualText;
    setManualText('');
    setIsTranslating(true);
    setError(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Step 1: Use gemini-3-flash-preview for the translation logic
      const translationResponse = await ai.models.generateContent({
        model: TRANSLATE_MODEL,
        contents: `Translate the following to ${targetLang.name}. Only return the translation, no explanation: "${originalText}"`,
      });
      const translatedText = translationResponse.text?.trim() || "";
      
      if (!translatedText) throw new Error("Translation failed.");

      // Step 2: Use gemini-2.5-flash-preview-tts for speech synthesis only
      const ttsResponse = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ 
          parts: [{ 
            text: `Say: ${translatedText}` 
          }] 
        }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

      if (base64Audio) {
        await playAudioBytes(base64Audio, true);
      }

      const entry: TranscriptionEntry = {
        id: `manual-${Date.now()}`,
        speaker: 'model',
        inputText: originalText,
        outputText: translatedText,
        timestamp: Date.now(),
        detectedLanguage: 'Manual'
      };
      setTranscriptions(prev => [...prev, entry]);
      saveToHistory(entry);
    } catch (err) {
      console.error("Manual translation failed", err);
      setError("Failed to translate text. Please try again.");
      setManualText(originalText); 
    } finally {
      setIsTranslating(false);
    }
  };

  const handleReplay = async (text: string) => {
    if (isReplaying) return;
    try {
      setIsReplaying(true);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      // Use direct "Say: " prompt to satisfy the AudioOut model constraint
      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: `Say: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });
      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        await playAudioBytes(base64Audio, true);
      } else {
        setIsReplaying(false);
      }
    } catch (err) {
      console.error("Replay failed", err);
      setIsReplaying(false);
    }
  };

  const startSession = async () => {
    try {
      setError(null);
      setDetectedLanguage(null);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
      });
      streamRef.current = stream;
      
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_IN });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_OUT });
      
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
              });
            };

            analyserRef.current!.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current.destination);
            setIsListening(true);
            updateVisuals();
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && voiceEnabled) {
              await playAudioBytes(base64Audio);
            }

            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const outText = currentOutputTranscription.current.trim();
              const langMatch = outText.match(/^\[(.*?)\]/);
              let detected = langMatch ? langMatch[1] : undefined;
              
              if (detected) setDetectedLanguage(detected);

              if (currentInputTranscription.current.trim() || outText) {
                const entry: TranscriptionEntry = {
                   id: `entry-${Date.now()}-${Math.random()}`,
                   speaker: 'model',
                   inputText: currentInputTranscription.current.trim(),
                   outputText: outText,
                   timestamp: Date.now(),
                   detectedLanguage: detected
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
          onerror: () => {
            setError('Connection lost.');
            stopSession();
          },
          onclose: () => stopSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: `LingoShazam Mode: Identify source language, translate to ${targetLang.name}. Format transcription: "[Language] Translation". SPEAK translation immediately.`
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      setError('Microphone access denied or connection failed.');
    }
  };

  const toggleListening = () => isListening ? stopSession() : startSession();

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto overflow-hidden bg-transparent text-white relative">
      <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-blue-500/10 blur-[100px] rounded-full transition-all duration-1000 ${isListening ? 'scale-150 opacity-50' : 'scale-100 opacity-20'}`} />
      
      <header className="pt-8 pb-4 px-6 z-10 flex items-center justify-between">
        <h1 className="text-sm font-black tracking-[0.4em] uppercase opacity-60">LingoLive</h1>
        <button 
          onClick={() => setVoiceEnabled(!voiceEnabled)}
          className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border transition-all ${voiceEnabled ? 'bg-blue-500/20 border-blue-500/40 text-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.3)]' : 'bg-white/5 border-white/10 text-white/40'}`}
        >
          <i className={`fa-solid ${voiceEnabled ? 'fa-volume-high' : 'fa-volume-xmark'} mr-2`} />
          {voiceEnabled ? 'Audio Out' : 'Muted'}
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-between px-6 pb-6 z-10 overflow-hidden">
        <div className="h-10 flex items-center justify-center">
          {isListening && !detectedLanguage && (
            <p className="text-xs font-bold tracking-widest text-blue-400 animate-pulse uppercase">Identifying...</p>
          )}
          {detectedLanguage && (
            <div className="flex flex-col items-center animate-fade-in">
              <span className="text-[10px] uppercase tracking-widest opacity-50 font-black mb-1">Live Match</span>
              <p className="text-xl font-black text-blue-100 tracking-tight flex items-center gap-2">
                <i className="fa-solid fa-bolt text-blue-400 text-sm" />
                {detectedLanguage}
              </p>
            </div>
          )}
        </div>

        <div className="w-full px-2 z-30">
          <form onSubmit={handleManualTranslate} className="relative group">
            <input 
              type="text"
              value={manualText}
              onChange={(e) => setManualText(e.target.value)}
              placeholder={isTranslating ? "Translating..." : "Type phrase to translate..."}
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

        <div className="relative flex-1 w-full flex flex-col items-center justify-center py-2">
          {isListening && (
            <>
              <div className="shazam-pulse" style={{ animationDuration: '3s' }} />
              <div className="shazam-pulse" style={{ animationDuration: '2s', width: '220px', height: '220px' }} />
              <div className="shazam-pulse" style={{ 
                animationDuration: '1s', 
                width: '160px', 
                height: '160px', 
                background: `rgba(59, 130, 246, ${Math.min(0.8, volume / 100)})` 
              }} />
            </>
          )}
          
          <button
            onClick={toggleListening}
            className={`relative z-20 w-36 h-36 rounded-full flex items-center justify-center transition-all duration-500 glass group ${
              isListening ? 'scale-110 border-blue-400/50' : 'hover:scale-105 border-white/10'
            }`}
            style={{ 
              boxShadow: isListening 
                ? `0 0 ${20 + volume}px rgba(59, 130, 246, 0.6)` 
                : '0 0 40px rgba(0,0,0,0.5)',
              borderWidth: '4px'
            }}
          >
            <div className={`absolute inset-0 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 opacity-0 group-hover:opacity-10 transition-opacity duration-500`} />
            <div className="flex flex-col items-center">
              <i className={`fa-solid ${isListening ? 'fa-stop text-2xl' : 'fa-microphone text-3xl'} text-white transition-all`} />
            </div>
          </button>
          
          <div className="mt-4 text-center h-6">
            <p className="text-[9px] font-black tracking-[0.5em] text-white/30 uppercase">
              {isListening ? 'Streaming Audio' : 'Ready to Translate'}
            </p>
          </div>
        </div>

        <div className="w-full space-y-4">
          <div className="glass rounded-[2rem] p-5 border border-white/10">
            <LanguageSelector selectedLanguage={targetLang} onSelect={setTargetLang} disabled={isListening} />
          </div>

          <div className="h-64 glass rounded-[2rem] overflow-hidden border border-white/10 relative">
             <div className="absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-black/20 to-transparent pointer-events-none z-10" />
             <TranscriptionList 
               entries={transcriptions.length > 0 ? transcriptions : history} 
               onReplay={handleReplay}
             />
             {isReplaying && (
               <div className="absolute bottom-2 right-4 flex items-center gap-1.5 animate-pulse text-[8px] font-black text-blue-400 uppercase bg-blue-500/10 px-2 py-1 rounded-full border border-blue-500/20 shadow-xl">
                 <div className="w-1 h-1 bg-blue-400 rounded-full animate-ping" />
                 Synthesizing
               </div>
             )}
          </div>
        </div>
      </main>

      {error && (
        <div className="absolute top-4 left-4 right-4 z-50 p-4 bg-red-500 text-white rounded-2xl text-xs font-bold text-center shadow-2xl animate-fade-in flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}><i className="fa-solid fa-times" /></button>
        </div>
      )}

      <footer className="p-4 text-center text-[8px] text-white/10 font-black uppercase tracking-[0.4em] z-10">
        LingoShazam V2.7 • {isListening ? 'Low Latency Mode' : 'Ready'}
      </footer>
    </div>
  );
};

export default App;