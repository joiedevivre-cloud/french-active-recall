// Web Speech API wiring for the speaking-practice card. Every consumer
// must render a working text-input fallback unconditionally and only
// ADD the mic button when isSpeechInputSupported() -- so an unsupported
// browser still gets a fully functional text-only experience, never a
// broken or missing input. No pronunciation score is ever produced here
// (or anywhere in this app) -- recognized text is just text, like typing.

// Reads off globalThis (not `window` directly) -- in a real browser
// globalThis IS window, so production behavior is identical, but this
// makes the feature-detection branch testable in plain Node/Vitest
// without needing a jsdom dependency just for this one check.
function getSpeechRecognitionCtor(): any {
  return (globalThis as any).SpeechRecognition || (globalThis as any).webkitSpeechRecognition;
}

export function isSpeechInputSupported(): boolean {
  return Boolean(getSpeechRecognitionCtor());
}

export interface SpeechInputHandle {
  stop: () => void;
}

/**
 * Starts browser speech recognition (fr-FR). onResult fires with the
 * final transcript text once recognition ends; onError fires on any
 * failure (including "not supported", so callers don't need to call
 * isSpeechInputSupported() themselves before calling this -- though the
 * UI should still hide the mic button when unsupported, per the module
 * doc comment above). Returns a handle to stop early, or null if speech
 * recognition could not be started at all.
 */
export function startSpeechInput(onResult: (text: string) => void, onError: (message: string) => void): SpeechInputHandle | null {
  const SpeechRecognitionCtor = getSpeechRecognitionCtor();
  if (!SpeechRecognitionCtor) {
    onError('speech_recognition_not_supported');
    return null;
  }

  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'fr-FR';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event: any) => {
    const transcript = event.results?.[0]?.[0]?.transcript ?? '';
    onResult(transcript);
  };
  recognition.onerror = (event: any) => {
    onError(event?.error ?? 'speech_recognition_error');
  };

  try {
    recognition.start();
  } catch (err) {
    onError(err instanceof Error ? err.message : 'speech_recognition_start_failed');
    return null;
  }

  return { stop: () => recognition.stop() };
}
