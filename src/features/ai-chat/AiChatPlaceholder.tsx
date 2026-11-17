export default function AiChatPlaceholder() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-5 text-center">
      <p className="text-lg font-semibold">AI 상황 대화</p>
      <p className="text-sm text-slate-400">
        Phase 3에서 구현됩니다. 최근 저장한 표현을 활용한 3~5턴 대화 연습이 이 화면에 들어갈 예정입니다.
      </p>
    </div>
  );
}
