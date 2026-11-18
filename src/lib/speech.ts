/**
 * Browser TTS for French: a fr-CA voice when the device has one, otherwise
 * fr-FR, otherwise any French voice. This is the device's own synthetic
 * voice -- no claim about pronunciation accuracy is made anywhere in the UI.
 */
export function speakFrench(text: string): void {
  if (typeof window === 'undefined' || !window.speechSynthesis || !text.trim()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find((v) => v.lang === 'fr-CA') ?? voices.find((v) => v.lang === 'fr-FR') ?? voices.find((v) => v.lang.startsWith('fr'));
  utterance.voice = voice ?? null;
  utterance.lang = voice?.lang ?? 'fr-CA';
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

/** YouGlish: real French speakers saying the word in YouTube videos (opens in a new tab). */
export function youglishUrl(word: string): string {
  return `https://youglish.com/pronounce/${encodeURIComponent(word.trim())}/french`;
}
