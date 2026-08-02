'use client';

import * as React from 'react';
import type { ConciergeLocale } from './i18n';
import type { VoiceInputDevice, VoiceListenOnceResponse, VoiceStatusResponse } from './voice-types';

/**
 * CS-02 voice hook — owns the two-tier voice state for the conversation dock.
 *
 *   Tier 0 (browser-only, zero dependencies) — Web Speech API:
 *     SpeechRecognition (webkit fallback) for mic input and speechSynthesis
 *     for reading replies, ported from the legacy static concierge
 *     (static/index.html).
 *   Tier 1 (voice-hub integration) — when the voice-hub daemon answers the
 *     /api/voice/status probe, mic turns go through POST
 *     /api/voice/listen-once (native STT + server-side TTS) and the speaking
 *     indicator mirrors the server speech state.
 *
 * Tier detection happens on mount and again on demand (refreshStatus) — no
 * background interval. The only polling is the bounded speech-state poll
 * after a voice-hub turn, so the speaking indicator and stop button reflect
 * the server-side playback without a permanent heartbeat.
 */

const VOICE_OUTPUT_STORAGE_KEY = 'concierge.voice-output-enabled';
const SPEECH_POLL_INTERVAL_MS = 1500;
const SPEECH_POLL_MAX_MS = 120_000;

// lib.dom.d.ts does not ship SpeechRecognition types; declare the minimal
// surface the legacy implementation used.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function resolveSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (
    (w.SpeechRecognition as SpeechRecognitionCtor | undefined) ||
    (w.webkitSpeechRecognition as SpeechRecognitionCtor | undefined) ||
    null
  );
}

function speechLocale(locale: ConciergeLocale): string {
  return locale === 'en' ? 'en-US' : 'ja-JP';
}

export interface UseVoiceResult {
  /** True when a mic path exists (Tier 1 voice-hub or browser SpeechRecognition). */
  supported: boolean;
  /** True when browser speechSynthesis can read replies aloud. */
  outputSupported: boolean;
  tier: 0 | 1;
  listening: boolean;
  /** Browser TTS or server-side TTS currently speaking. */
  speaking: boolean;
  voiceOutputEnabled: boolean;
  setVoiceOutputEnabled: (value: boolean) => void;
  sttBackends: string[];
  inputDevices: VoiceInputDevice[];
  sttBackend: string;
  setSttBackend: (value: string) => void;
  inputDevice: string;
  setInputDevice: (value: string) => void;
  /** Tier 0: start browser recognition. Returns false when unsupported. */
  startListening: (onFinal: (text: string) => void, onInterim?: (text: string) => void) => boolean;
  stopListening: () => void;
  /** Tier 1: one server-side capture → STT → reply (already spoken server-side). */
  listenOnce: () => Promise<VoiceListenOnceResponse>;
  /** Tier 0 output: read a reply aloud (cancels any previous utterance). */
  speakText: (text: string) => void;
  /** Stops browser TTS and (Tier 1) server TTS. */
  stopSpeaking: () => Promise<void>;
  /** Call after a voice-hub turn to mirror the server speaking state. */
  notifyServerSpeech: () => void;
  refreshStatus: () => Promise<void>;
}

export function useVoice(locale: ConciergeLocale): UseVoiceResult {
  const [tier, setTier] = React.useState<0 | 1>(0);
  const [recognitionSupported, setRecognitionSupported] = React.useState(false);
  const [outputSupported, setOutputSupported] = React.useState(false);
  const [listening, setListening] = React.useState(false);
  const [browserSpeaking, setBrowserSpeaking] = React.useState(false);
  const [serverSpeaking, setServerSpeaking] = React.useState(false);
  const [voiceOutputEnabled, setVoiceOutputEnabledState] = React.useState(true);
  const [sttBackends, setSttBackends] = React.useState<string[]>([]);
  const [inputDevices, setInputDevices] = React.useState<VoiceInputDevice[]>([]);
  const [sttBackend, setSttBackend] = React.useState('');
  const [inputDevice, setInputDevice] = React.useState('');

  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null);
  const listenOnceInFlightRef = React.useRef(false);
  const speechPollRef = React.useRef<number | null>(null);
  const localeRef = React.useRef(locale);
  localeRef.current = locale;

  const clearSpeechPoll = React.useCallback(() => {
    if (speechPollRef.current !== null) {
      window.clearInterval(speechPollRef.current);
      speechPollRef.current = null;
    }
  }, []);

  const refreshStatus = React.useCallback(async () => {
    try {
      const response = await fetch('/api/voice/status');
      const payload = (await response.json()) as VoiceStatusResponse;
      setTier(payload.available ? 1 : 0);
      setSttBackends(Array.isArray(payload.sttBackends) ? payload.sttBackends : []);
      setInputDevices(Array.isArray(payload.inputDevices) ? payload.inputDevices : []);
      if (payload.speech?.status !== 'speaking') setServerSpeaking(false);
    } catch {
      // Probe failure = Tier 0. The dock stays fully usable without voice-hub.
      setTier(0);
      setSttBackends([]);
      setInputDevices([]);
    }
  }, []);

  React.useEffect(() => {
    setRecognitionSupported(resolveSpeechRecognitionCtor() !== null);
    setOutputSupported(typeof window !== 'undefined' && 'speechSynthesis' in window);
    try {
      const stored = window.localStorage.getItem(VOICE_OUTPUT_STORAGE_KEY);
      if (stored !== null) setVoiceOutputEnabledState(stored !== 'false');
    } catch {
      // Storage unavailable (private mode) — keep the default (enabled).
    }
    void refreshStatus();
    const recognitionAtMount = recognitionRef;
    return () => {
      clearSpeechPoll();
      try {
        recognitionAtMount.current?.stop();
      } catch {
        // Recognition may already be stopped — nothing to clean up.
      }
      try {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
      } catch {
        // speechSynthesis.cancel is best-effort on unmount.
      }
    };
  }, [refreshStatus, clearSpeechPoll]);

  const setVoiceOutputEnabled = React.useCallback((value: boolean) => {
    setVoiceOutputEnabledState(value);
    try {
      window.localStorage.setItem(VOICE_OUTPUT_STORAGE_KEY, value ? 'true' : 'false');
    } catch {
      // Storage unavailable — the toggle still applies for this session.
    }
    if (!value && typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      setBrowserSpeaking(false);
    }
  }, []);

  /**
   * Bounded poll of the server speech state after a voice-hub turn. Starts
   * optimistically (the server begins TTS almost immediately) and stops as
   * soon as the state reports idle or the max window elapses.
   */
  const notifyServerSpeech = React.useCallback(() => {
    setServerSpeaking(true);
    clearSpeechPoll();
    const startedAt = Date.now();
    speechPollRef.current = window.setInterval(() => {
      if (Date.now() - startedAt > SPEECH_POLL_MAX_MS) {
        clearSpeechPoll();
        setServerSpeaking(false);
        return;
      }
      void (async () => {
        try {
          const response = await fetch('/api/voice/status');
          const payload = (await response.json()) as VoiceStatusResponse;
          if (payload.speech?.status !== 'speaking') {
            clearSpeechPoll();
            setServerSpeaking(false);
          }
        } catch {
          // Transient probe failure — keep polling until the bounded window ends.
        }
      })();
    }, SPEECH_POLL_INTERVAL_MS);
  }, [clearSpeechPoll]);

  const startListening = React.useCallback(
    (onFinal: (text: string) => void, onInterim?: (text: string) => void): boolean => {
      const Ctor = resolveSpeechRecognitionCtor();
      if (!Ctor || recognitionRef.current) return false;
      const recognition = new Ctor();
      recognition.lang = speechLocale(localeRef.current);
      recognition.interimResults = true;
      recognition.continuous = false;
      let finalText = '';
      recognition.onstart = () => setListening(true);
      recognition.onresult = (event) => {
        finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          finalText += event.results[i][0].transcript;
        }
        onInterim?.(finalText);
      };
      recognition.onerror = () => {
        try {
          recognition.stop();
        } catch {
          // Recognition already stopped after the error.
        }
      };
      recognition.onend = () => {
        recognitionRef.current = null;
        setListening(false);
        if (finalText.trim()) onFinal(finalText.trim());
      };
      recognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        // start() throws when a session is already active — reset our handle.
        recognitionRef.current = null;
        return false;
      }
      return true;
    },
    []
  );

  const stopListening = React.useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // Recognition already stopped — onend still fires and clears state.
    }
  }, []);

  const listenOnce = React.useCallback(async (): Promise<VoiceListenOnceResponse> => {
    if (listenOnceInFlightRef.current) return { ok: false, error: 'listen_in_flight' };
    listenOnceInFlightRef.current = true;
    setListening(true);
    try {
      const response = await fetch('/api/voice/listen-once', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backend: sttBackend || undefined,
          device: inputDevice || undefined,
          locale: speechLocale(localeRef.current),
        }),
      });
      const payload = (await response.json().catch(() => null)) as VoiceListenOnceResponse | null;
      if (!payload) return { ok: false, error: `listen_failed_${response.status}` };
      // spoken=true means the server-side TTS is reading the reply right now;
      // mirror it in the speaking indicator (with the stop button).
      if (payload.ok && payload.spoken) notifyServerSpeech();
      return payload;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      listenOnceInFlightRef.current = false;
      setListening(false);
    }
  }, [sttBackend, inputDevice, notifyServerSpeech]);

  const speakText = React.useCallback(
    (text: string) => {
      if (!voiceOutputEnabled || !text) return;
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = speechLocale(localeRef.current);
        utterance.rate = 1.02;
        utterance.onstart = () => setBrowserSpeaking(true);
        utterance.onend = () => setBrowserSpeaking(false);
        utterance.onerror = () => setBrowserSpeaking(false);
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } catch {
        // Browser TTS failure is cosmetic — the reply text is already visible.
        setBrowserSpeaking(false);
      }
    },
    [voiceOutputEnabled]
  );

  const stopSpeaking = React.useCallback(async () => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setBrowserSpeaking(false);
    if (tier === 1 || serverSpeaking) {
      clearSpeechPoll();
      setServerSpeaking(false);
      try {
        await fetch('/api/voice/stop', { method: 'POST' });
      } catch {
        // Daemon unreachable — nothing is speaking server-side then.
      }
    }
  }, [tier, serverSpeaking, clearSpeechPoll]);

  return {
    supported: tier === 1 || recognitionSupported,
    outputSupported,
    tier,
    listening,
    speaking: browserSpeaking || serverSpeaking,
    voiceOutputEnabled,
    setVoiceOutputEnabled,
    sttBackends,
    inputDevices,
    sttBackend,
    setSttBackend,
    inputDevice,
    setInputDevice,
    startListening,
    stopListening,
    listenOnce,
    speakText,
    stopSpeaking,
    notifyServerSpeech,
    refreshStatus,
  };
}
