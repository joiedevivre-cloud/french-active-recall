import { describe, expect, it, vi, afterEach } from 'vitest';
import { isSpeechInputSupported, startSpeechInput } from '@/lib/speechInput';

afterEach(() => {
  delete (globalThis as any).SpeechRecognition;
  delete (globalThis as any).webkitSpeechRecognition;
});

describe('isSpeechInputSupported', () => {
  it('is false when neither constructor exists on window', () => {
    expect(isSpeechInputSupported()).toBe(false);
  });

  it('is true when webkitSpeechRecognition exists (Safari/Chrome-style)', () => {
    (globalThis as any).webkitSpeechRecognition = function () {};
    expect(isSpeechInputSupported()).toBe(true);
  });

  it('is true when the standard SpeechRecognition exists', () => {
    (globalThis as any).SpeechRecognition = function () {};
    expect(isSpeechInputSupported()).toBe(true);
  });
});

describe('startSpeechInput (fallback behavior)', () => {
  it('calls onError with a recognizable code and returns null when unsupported, never throws', () => {
    const onResult = vi.fn();
    const onError = vi.fn();
    const handle = startSpeechInput(onResult, onError);
    expect(handle).toBeNull();
    expect(onError).toHaveBeenCalledWith('speech_recognition_not_supported');
    expect(onResult).not.toHaveBeenCalled();
  });

  it('starts recognition and returns a stop handle when supported', () => {
    const startMock = vi.fn();
    const stopMock = vi.fn();
    (globalThis as any).SpeechRecognition = function () {
      return { start: startMock, stop: stopMock, lang: '', interimResults: false, maxAlternatives: 1 };
    };
    const handle = startSpeechInput(vi.fn(), vi.fn());
    expect(startMock).toHaveBeenCalled();
    expect(handle).not.toBeNull();
    handle!.stop();
    expect(stopMock).toHaveBeenCalled();
  });
});
