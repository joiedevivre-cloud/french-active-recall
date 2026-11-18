import { useState } from 'react';
import type { WritingModeCardProps } from '@/features/review/cards/TransformCard';
import { WritingCardShell } from '@/features/review/cards/WritingCardShell';
import { isSpeechInputSupported, startSpeechInput, type SpeechInputHandle } from '@/lib/speechInput';

export function SpeakingCard({ expressionId, reviewStateId, reviewState, exercise, onComplete }: WritingModeCardProps) {
  const [listening, setListening] = useState(false);
  const [handle, setHandle] = useState<SpeechInputHandle | null>(null);

  return (
    <WritingCardShell
      expressionId={expressionId}
      reviewStateId={reviewStateId}
      reviewState={reviewState}
      mode="speaking"
      exerciseId={exercise.id}
      grammarTags={exercise.grammarTags}
      targetGrammar={exercise.promptFrPattern}
      onComplete={onComplete}
      promptHeader={
        <div className="rounded-3xl border border-slate-200 p-8 dark:border-slate-800">
          <p className="text-xs text-slate-400">말하기 연습 — 먼저 소리 내어 말해보세요</p>
          <p className="mt-2 text-lg">{exercise.promptKo}</p>
        </div>
      }
      renderInput={(value, setValue) => (
        <div className="flex flex-col gap-2">
          {isSpeechInputSupported() && (
            <button
              type="button"
              onClick={() => {
                if (listening) {
                  handle?.stop();
                  setListening(false);
                  return;
                }
                setListening(true);
                const h = startSpeechInput(
                  (text) => {
                    setValue(text);
                    setListening(false);
                  },
                  () => setListening(false)
                );
                setHandle(h);
              }}
              className={`rounded-full border py-2 text-sm ${listening ? 'border-red-500 text-red-500' : 'border-slate-300 dark:border-slate-700'}`}
            >
              {listening ? '🎙️ 듣는 중... (다시 눌러 멈춤)' : '🎙️ 마이크로 말하기'}
            </button>
          )}
          <textarea
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isSpeechInputSupported() ? '또는 직접 입력하세요' : '프랑스어로 입력하세요 (이 브라우저는 음성 인식 미지원)'}
            className="w-full rounded-xl border border-slate-300 p-3 text-base dark:border-slate-700 dark:bg-slate-900"
            rows={3}
          />
        </div>
      )}
    />
  );
}
