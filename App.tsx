
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { SUPPORTED_LANGUAGES, TranscriptionEntry, Language } from './types';
import { decode, decodeAudioData, createBlob } from './utils/audioUtils';
import { LanguageSelector } from './components/LanguageSelector';
import { TranscriptionList } from './components/TranscriptionList';

const SAMPLE_RATE_IN = 16000;
const SAMPLE_RATE_OUT = 24000;
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
// Lower buffer size reduces input latency. 2048 is a good balance for most devices.
const INPUT_BUFFER_SIZE = 2048;

const App: React.FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);

  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');
  const sessionRef = useRef<any>(null);
  const animationFrameRef = useRef<number | null>(null);

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
    setDetectedLanguage(null);
  }, []);

  const startSession = async () => {
    try {
      setError(null);
      setDetectedLanguage('Detecting...');
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_IN });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_OUT });
      
      analyserRef.current = audioContextInRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            if (!audioContextInRef.current) return;
            const source = audioContextInRef.current.createMediaStreamSource(stream);
            source.connect(analyserRef.current!);
            
            // Reduced buffer size for lower latency
            const scriptProcessor = audioContextInRef.current.createScriptProcessor(INPUT_BUFFER_SIZE, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current.destination);
            setIsListening(true);
            updateVisuals();
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio Playback - Optimized for gapless streaming
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              // Synchronize with current time to minimize lag while preventing overlap
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, SAMPLE_RATE_OUT, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            // Transcription
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const inText = currentInputTranscription.current.trim();
              const outText = currentOutputTranscription.current.trim();

              const langMatch = inText.match(/^\[(.*?)\]/);
              if (langMatch) setDetectedLanguage(langMatch[1]);

              if (inText || outText) {
                setTranscriptions(prev => {
                  const items: TranscriptionEntry[] = [...prev];
                  if (inText) items.push({ id: `in-${Date.now()}-${Math.random()}`, speaker: 'user', text: inText, timestamp: Date.now() });
                  if (outText) items.push({ id: `out-${Date.now()}-${Math.random()}`, speaker: 'model', text: outText, timestamp: Date.now() });
                  return items;
                });
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
            setError('Connection error.');
            stopSession();
          },
          onclose: () => stopSession()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          thinkingConfig: { thinkingBudget: 0 },
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: `SYSTEM: ULTRA-LOW LATENCY SIMULTANEOUS INTERPRETER.
          CORE MISSION: TRANSLATE SPEECH AS IT HAPPENS.
          
          LATENCY RULES:
          1. DO NOT WAIT for the user to finish their sentence.
          2. START INTERPRETING as soon as the first 3-5 words provide a clear phrase.
          3. SPEAK CONTINUOUSLY. Stream audio output in real-time.
          4. AUDIO OUTPUT MUST ONLY CONTAIN THE TRANSLATION.
          5. NO PREAMBLE. NO FILLER. NO TALKING TO THE USER.
          6. Target Language: ${targetLang.name} (${targetLang.code}).
          
          Linguistic context:
          - Automatically detect the source language.
          - Prepend detected language only to the text transcript: "[Language]: Text".
          - Optimized for South African phonetics: Zulu, Xhosa, Afrikaans, Sotho, Tswana, Swahili.
          - Optimized for European languages: Italian, Dutch, Spanish, French, German.`
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      setError('Check microphone permissions.');
    }
  };

  const toggleListening = () => isListening ? stopSession() : startSession();

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto overflow-hidden bg-black text-white">
      <header className="pt-4 pb-2 px-6 flex flex-col items-center">
        <div className="flex items-center gap-2 mb-1">
          <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-600'}`} />
          <h1 className="text-xl font-black tracking-widest text-white uppercase">
            Linguist <span className="text-blue-500">Live</span>
          </h1>
        </div>
        {isListening && (
          <div className="bg-blue-500/20 text-blue-400 text-[9px] px-2 py-0.5 rounded-full font-bold animate-fade-in border border-blue-500/30 tracking-tighter uppercase">
            Aggressive Stream Active
          </div>
        )}
      </header>

      <main className="flex-1 flex flex-col items-center justify-between px-6 pb-8 gap-4 overflow-hidden">
        <div className="w-full bg-white/5 backdrop-blur-md p-4 rounded-3xl flex flex-col gap-3 border border-white/10 shadow-2xl">
          <LanguageSelector selectedLanguage={targetLang} onSelect={setTargetLang} disabled={isListening} />
          
          {isListening && (
            <div className="flex justify-between items-center pt-2 border-t border-white/5">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Live Context:</span>
              <span className="text-xs text-blue-400 font-semibold">{detectedLanguage || 'Detecting...'}</span>
            </div>
          )}
        </div>

        <div className="flex-[4] w-full bg-white/5 backdrop-blur-md rounded-3xl overflow-hidden flex flex-col shadow-inner border border-white/10">
          {error && <div className="p-3 m-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-[11px] font-bold">{error}</div>}
          <TranscriptionList entries={transcriptions} />
        </div>

        <div className="relative flex flex-col items-center justify-center pt-2">
          {isListening && (
            <div 
              className="absolute w-28 h-28 rounded-full border border-blue-500/30 transition-transform duration-75"
              style={{ transform: `scale(${1 + (volume / 80)})`, opacity: 0.5 - (volume / 160) }}
            />
          )}
          
          <button
            onClick={toggleListening}
            className={`z-10 relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 ${
              isListening 
                ? 'bg-red-600 shadow-[0_0_50px_rgba(220,38,38,0.5)]' 
                : 'bg-blue-600 hover:bg-blue-500 shadow-[0_0_40px_rgba(37,99,235,0.4)]'
            }`}
          >
            {isListening ? (
              <div className="flex gap-1 items-center h-6">
                {[1, 2, 3, 4, 5].map(i => (
                  <div 
                    key={i} 
                    className="w-1 bg-white rounded-full animate-bounce" 
                    style={{ 
                      height: `${25 + (volume * Math.random())}%`,
                      animationDelay: `${i * 0.08}s`,
                      animationDuration: '0.5s'
                    }} 
                  />
                ))}
              </div>
            ) : (
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
          </button>
          
          <p className="mt-3 text-[10px] font-black tracking-[0.4em] text-gray-500 uppercase">
            {isListening ? 'Interpreting' : 'Tap to Start'}
          </p>
        </div>
      </main>

      <footer className="p-2 text-center text-[9px] text-gray-700 font-bold uppercase tracking-[0.2em] bg-black/50">
        Low Latency Audio Path • {INPUT_BUFFER_SIZE} Samples
      </footer>
    </div>
  );
};

export default App;
