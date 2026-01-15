
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
const TRANSLATION_MODEL = 'gemini-3-flash-preview';
const INPUT_BUFFER_SIZE = 2048;

const App: React.FC = () => {
  const [isListening, setIsListening] = useState(false);
  const [targetLang, setTargetLang] = useState<Language>(SUPPORTED_LANGUAGES[0]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);
  const [manualText, setManualText] = useState('');
  const [isProcessingTTS, setIsProcessingTTS] = useState(false);

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
    setDetectedLanguage(null);
  }, []);

  const playAudioBytes = async (base64Audio: string) => {
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
    source.onended = () => sourcesRef.current.delete(source);
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
    sourcesRef.current.add(source);
  };

  const handleManualTTS = async (textToSpeak: string) => {
    if (!textToSpeak.trim() || isProcessingTTS) return;
    setIsProcessingTTS(true);
    setError(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      // Step 1: Translate text using Gemini 3 Flash to ensure the TTS speaks the correct target language
      const translateResponse = await ai.models.generateContent({
        model: TRANSLATION_MODEL,
        contents: `Translate the following text to ${targetLang.name} (${targetLang.nativeName}). Return ONLY the translated text: "${textToSpeak}"`,
      });
      const translatedText = translateResponse.text?.trim() || textToSpeak;

      // Step 2: Speak the translated text using Gemini 2.5 TTS
      const ttsResponse = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text: translatedText }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
      });

      const audioData = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audioData) {
        await playAudioBytes(audioData);
        setTranscriptions(prev => [...prev, {
          id: `tts-${Date.now()}`,
          speaker: 'model',
          text: `"${textToSpeak}" \u2192 ${translatedText}`,
          timestamp: Date.now()
        }]);
      }
      setManualText('');
    } catch (err) {
      console.error(err);
      setError('Translation or Speech failed. Check your API key and connection.');
    } finally {
      setIsProcessingTTS(false);
    }
  };

  const startSession = async () => {
    try {
      setError(null);
      setDetectedLanguage('Detecting...');
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true, 
          autoGainControl: true,
          channelCount: 1,
          sampleRate: SAMPLE_RATE_IN
        } 
      });
      streamRef.current = stream;
      
      audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_IN });
      audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_OUT });
      
      analyserRef.current = audioContextInRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;

      const highPassFilter = audioContextInRef.current.createBiquadFilter();
      highPassFilter.type = 'highpass';
      highPassFilter.frequency.value = 100;

      const sessionPromise = ai.live.connect({
        model: LIVE_MODEL,
        callbacks: {
          onopen: () => {
            if (!audioContextInRef.current) return;
            const source = audioContextInRef.current.createMediaStreamSource(stream);
            source.connect(highPassFilter);
            highPassFilter.connect(analyserRef.current!);
            
            const scriptProcessor = audioContextInRef.current.createScriptProcessor(INPUT_BUFFER_SIZE, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            highPassFilter.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current.destination);
            setIsListening(true);
            updateVisuals();
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              await playAudioBytes(base64Audio);
            }

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
            setError('Connection lost.');
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
          systemInstruction: `SYSTEM: Simultaneous Translator.
          MISSION: Translate spoken audio into ${targetLang.name} (${targetLang.nativeName}) immediately.
          
          RULES:
          1. Provide ONLY the translation as audio output.
          2. Maintain high fidelity and phonetic accuracy.
          3. Detect the source language automatically.
          4. Output format: [Detected Language] Translation text.`
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      setError('Microphone access denied or connection failed.');
    }
  };

  const toggleListening = () => isListening ? stopSession() : startSession();

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto overflow-hidden bg-black text-white">
      <header className="pt-6 pb-2 px-6 flex flex-col items-center">
        <div className="flex items-center gap-2 mb-1">
          <div className={`w-2.5 h-2.5 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-600'}`} />
          <h1 className="text-2xl font-black tracking-widest text-white uppercase">
            Linguist <span className="text-blue-500">Live</span>
          </h1>
        </div>
        {isListening && (
          <div className="bg-blue-500/20 text-blue-400 text-[9px] px-3 py-1 rounded-full font-black animate-fade-in border border-blue-500/30 tracking-widest uppercase">
            Live High-Fidelity Path
          </div>
        )}
      </header>

      <main className="flex-1 flex flex-col items-center justify-between px-6 pb-4 gap-4 overflow-hidden">
        <div className="w-full bg-white/5 backdrop-blur-xl p-5 rounded-3xl flex flex-col gap-4 border border-white/10 shadow-2xl">
          <LanguageSelector selectedLanguage={targetLang} onSelect={setTargetLang} disabled={isListening} />
          
          {isListening && (
            <div className="flex justify-between items-center pt-3 border-t border-white/5">
              <span className="text-[10px] text-gray-500 uppercase tracking-widest font-black">Source:</span>
              <span className="text-xs text-blue-400 font-bold tracking-wide">{detectedLanguage || 'Listening...'}</span>
            </div>
          )}
        </div>

        <div className="flex-[5] w-full bg-white/5 backdrop-blur-md rounded-3xl overflow-hidden flex flex-col shadow-inner border border-white/10 relative">
          {error && (
            <div className="absolute top-4 left-4 right-4 z-10 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-[11px] font-bold text-center">
              {error}
            </div>
          )}
          <TranscriptionList entries={transcriptions} onReplay={handleManualTTS} />
        </div>

        {!isListening && (
          <div className="w-full bg-white/5 p-4 rounded-3xl border border-white/10 flex flex-col gap-2 transition-all duration-500">
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={`Translate into ${targetLang.name}...`}
                value={manualText}
                onChange={(e) => setManualText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleManualTTS(manualText)}
                className="flex-1 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-600 transition-all"
              />
              <button
                onClick={() => handleManualTTS(manualText)}
                disabled={!manualText.trim() || isProcessingTTS}
                className="bg-blue-600 hover:bg-blue-500 disabled:opacity-30 p-3 rounded-2xl transition-all shadow-lg flex items-center justify-center min-w-[3.5rem]"
              >
                {isProcessingTTS ? (
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <i className="fa-solid fa-paper-plane text-white"></i>
                )}
              </button>
            </div>
          </div>
        )}

        <div className="relative flex flex-col items-center justify-center pt-2">
          {isListening && (
            <div 
              className="absolute w-28 h-28 rounded-full border border-blue-500/30 transition-transform duration-75"
              style={{ transform: `scale(${1 + (volume / 60)})`, opacity: 0.5 - (volume / 120) }}
            />
          )}
          
          <button
            onClick={toggleListening}
            className={`z-10 relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 ${
              isListening 
                ? 'bg-red-600 shadow-[0_0_60px_rgba(220,38,38,0.5)]' 
                : 'bg-blue-600 hover:bg-blue-500 shadow-[0_0_50px_rgba(37,99,235,0.4)]'
            }`}
          >
            {isListening ? (
              <div className="flex gap-1 items-center h-6">
                {[1, 2, 3, 4, 5].map(i => (
                  <div 
                    key={i} 
                    className="w-1.5 bg-white rounded-full animate-bounce" 
                    style={{ 
                      height: `${30 + (volume * Math.random())}%`,
                      animationDelay: `${i * 0.08}s`,
                      animationDuration: '0.4s'
                    }} 
                  />
                ))}
              </div>
            ) : (
              <i className="fa-solid fa-microphone text-3xl text-white"></i>
            )}
          </button>
          
          <p className="mt-4 text-[11px] font-black tracking-[0.5em] text-gray-500 uppercase">
            {isListening ? 'Streaming' : 'Tap for Live'}
          </p>
        </div>
      </main>

      <footer className="p-3 text-center text-[10px] text-gray-700 font-black uppercase tracking-[0.3em] bg-black/80">
        Audio: HD Stream • Real-time Build System Active
      </footer>
    </div>
  );
};

export default App;
