# French Active Recall

프랑스어 수업 중 들은 표현을 10초 안에 저장하고, FSRS 기반으로 자동 복습하며,
AI 분석과 상황 대화로 실제 사용까지 이어주는 모바일 우선 PWA.

- 배포 URL: https://joiedevivre-cloud.github.io/french-active-recall/
- 지시서 원본: [`docs/`](./docs)

## 기술 스택

React + TypeScript + Vite, Tailwind CSS, Supabase (Postgres + Auth + Edge
Functions), `ts-fsrs`, Dexie(IndexedDB), `vite-plugin-pwa`.

## 로컬 실행

```bash
npm install
cp .env.example .env.local   # 값 채우기 (아래 "환경 변수" 참고)
npm run dev
```

## 환경 변수 (`.env.local`)

| 변수 | 설명 | 어디서 구하나 |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase 프로젝트 URL | Supabase 대시보드 → Project Settings → API |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable(anon) key | 위와 동일. **service role key는 절대 여기에 넣지 않습니다.** |

AI(OpenAI) API 키는 프런트엔드 환경변수가 아니라 Supabase Edge Function
Secrets에만 둡니다 (아래 "Edge Function 배포" 참고).

## 아키텍처 결정 사항

### 라우팅: BrowserRouter + `dist/404.html`

GitHub Pages는 서버 사이드 라우팅이 없어서, `/library`처럼 루트가 아닌 경로를
직접 열거나 새로고침하면 정적 파일이 없어 404가 발생한다. `npm run build`가
끝나면 `scripts/copy-spa-fallback.mjs`가 `dist/index.html`을 `dist/404.html`로
복사한다. GitHub Pages는 404 상황에서 이 파일을 서빙하므로, 결국 같은 SPA
셸이 로드되고 react-router가 실제 URL을 읽어 올바른 화면을 그린다.

HashRouter 대신 이 방식을 선택한 이유: Supabase Google OAuth는 PKCE
플로우라 콜백이 `?code=...` 쿼리 파라미터로 오는데, HashRouter는 URL의
`#` 부분을 자체 라우팅에 쓰기 때문에 과거 implicit 플로우(`#access_token=`)와
충돌할 수 있었다. PKCE + BrowserRouter 조합은 이 충돌이 없고 URL도 깨끗하다.

### PWA 업데이트 정책

`vite-plugin-pwa`를 `registerType: 'prompt'`로 설정했다. 새 버전이 감지되면
조용히 자동 새로고침하지 않고 하단에 "새 버전이 있습니다 / 새로고침" 배너를
띄운다 — 복습 세션 중간에 강제로 리로드되어 입력 중인 답을 잃는 상황을
막기 위함이다. `index.html`은 network-first, 해시가 붙은 JS/CSS 에셋은
캐시를 우선 사용한다(빌드마다 파일명이 바뀌므로 오래된 캐시가 새 코드를
가리는 일이 없다).

### 오프라인 동기화

- `expressions.client_id` + `(user_id, client_id)` 유니크 인덱스로 멱등
  upsert를 보장한다. 오프라인에서 저장한 표현은 Dexie(IndexedDB)의
  `pendingExpressions` 테이블에 쌓이고, `online` 이벤트가 발생하면
  `syncPendingExpressions()`가 순서대로 서버에 upsert한다.
- 충돌 정책: 클라이언트는 항상 "먼저 저장된 원문이 진실"이라는 전제로
  동작한다 — 같은 `client_id`로 두 번 동기화돼도 서버는 덮어쓰기만 하고
  새 행을 만들지 않는다. 필드 단위 충돌 해소(예: 오프라인 중 서버에서도
  수정됨)는 Phase 1 범위 밖이며, 현재는 "마지막 쓰기가 승리"한다.
- 삭제 동기화: 표현 삭제는 소프트 삭제(`deleted_at`)이므로 오프라인
  삭제 자체는 아직 지원하지 않는다(온라인일 때만 삭제 가능). 오프라인
  이면서 AI 분석도 당연히 불가능하므로, 원문 저장을 우선하고 재연결 후
  Edge Function이 분석을 수행한다.

### 삭제 정책 (표현장)

표현 삭제는 `expressions.deleted_at`을 채우는 소프트 삭제다. 삭제된
표현은 조회/복습 대상에서 즉시 제외되지만, `review_attempts` 등 학습
이력은 그대로 보존된다(통계 왜곡을 막기 위해 이력까지 지우지 않음).
영구 삭제(하드 delete) UI와 "이력도 함께 삭제" 옵션은 아직 구현하지
않았다 — Phase 3에서 다룰 예정.

### AI 대화 데이터 보존

`conversation_turns`(원문 대화 내용)는 영구 보관하지 않는다는 보안
지시서 요구사항에 따라, 요약(`conversation_sessions.summary`)이 생성된
후 N일(기본 7일) 지난 턴을 삭제하는 정리 작업이 필요하다. **이 정리
작업(pg_cron 또는 예약된 Edge Function)은 아직 구현하지 않았다** — AI
대화 기능 자체가 Phase 3 범위이기 때문. 구현 시 반드시 함께 추가할 것.

## 붙여넣기 저장 ("Paste and save" quick import)

홈 화면의 **[붙여넣기 저장]** → `/paste-save`. ChatGPT가 자유 형식(글머리
기호, `—`/`–`/`|`/`→`/`=`/`:`/탭 구분자, 마크다운 표 등)으로 정리해 준
표현을 그대로 붙여넣고 **[저장]** 한 번으로 바로 Supabase에 들어간다 —
미리보기/확인 단계 없음. 파싱은 전부 `src/lib/pasteParser.ts`에서 AI 없이
코드로 처리한다(테스트: `src/lib/pasteParser.test.ts`, 39개 모두 통과).

- 중복은 `src/lib/csvImport.ts`의 `normalizeForDedup`(소문자, 악센트는
  **유지**, 커리/스트레이트 아포스트로피만 통일, NFC)로 판단하고, 이미
  있는 표현과 같은 배치 안의 반복 모두 걸러낸다.
- 해석 못한 줄은 저장하지 않고 "확인 필요" 목록에 원문 그대로 남는다.
- 붙여넣은 원문 전체는 `raw_notes`에 먼저 보존되고, 오프라인이면
  `pendingPasteBatches`(IndexedDB)에 배치 전체를 저장했다가 온라인 복귀
  시 통째로 동기화한다(원문 → 표현 순서 보장, `client_id` 기반 멱등).
- 저장되는 `meaning_ko`/`expression_fr`은 사용자가 붙여넣은 그대로이며
  AI가 생성한 값이 아니다.
- **저장 직후 `meaning_ko`가 빈 표현만 자동으로 AI 분석된다**
  (`src/features/ai-batch/autoAnalyze.ts`가 `analyze-batch`를 호출, 여러
  개를 저장해도 15개씩 묶어서 한 번에 호출 — 이미 뜻이 있는 표현이나
  중복으로 걸러진 표현은 다시 호출하지 않는다). 성공하면 `meaning_ko`/
  `grammar_note`/`cefr_level`/`corrected_fr`/`key_phrase`/예문이 채워지고
  `ai_analysis_status`가 `completed`로, 실패하면 `failed`로 바뀐다
  (`pending`으로 영원히 남지 않음). 표현장에서 실패 항목은 "분석 실패 —
  재시도" 버튼으로 다시 시도할 수 있다.

**아직 구현하지 않은 보조 기능**:
- "확인 필요" 줄을 Edge Function으로 AI 정리하는 `[AI로 정리]` 버튼

**별개로 주의할 점:** `src/content/chatgpt-prompt.md`에 넣은 ChatGPT
프롬프트는 **CSV 표 형식**(````csv` 블록, `프랑스어,한국어 뜻,분류,출처`
헤더)을 출력하도록 되어 있는데, 이는 `src/lib/csvImport.ts` 기반의 "CSV
미리보기 가져오기" 플로우(요청상 더 먼저 설계됐지만 이번엔 화면까지는
만들지 않음)용이다. 지금 만든 `/paste-save` 화면은 그 CSV를 파싱하지
않는다 — 자유 형식 글머리 목록을 붙여넣는 용도다. 두 플로우를 다 쓰려면
나중에 "프롬프트 복사" 버튼과 CSV 미리보기 화면을 별도로 이어서 만들어야
한다.

## AI 일괄 분석 ("AI 일괄 분석으로 여러 문장 추가")

홈 → [+ 표현 추가] → **"AI 일괄 분석으로 여러 문장 추가"** → `/ai-batch`. 프랑스어
문장을 최대 100개까지 한 줄에 하나씩 붙여넣으면:

1. `src/lib/pasteParser.ts`(붙여넣기 저장과 동일한 파서)로 줄 단위 분리, 번호/글머리
   제거, 한글만 있는 줄은 "확인 필요"로 분류
2. 기존 표현과 비교해 중복 표시(`markPasteDuplicates`, 악센트는 다른 표현으로 취급)
3. 입력을 멈추고 1초 뒤 **자동으로** `analyze-batch` Edge Function 호출 (15개씩
   순차 청크 분할, 진행률 표시, 분석 중이면 겹쳐서 다시 호출하지 않음)
4. 결과를 문장별 카드로 보여주고 번역/문법설명/예문/태그를 저장 전에 수정 가능,
   문법 오류가 있으면 교정문을 보여주고 적용 여부를 사용자가 토글로 선택
5. [전체 저장]/[선택 저장] → `src/features/paste-save/pasteSave.ts`의 기존
   배치 저장 경로(오프라인 큐·raw_notes 보존·review_states 등록 포함)를 그대로 재사용
6. [실패 항목 재분석] → 실패한 문장만 다시 호출

Edge Function(`supabase/functions/analyze-batch`)은 `analyze-expression`과
동일한 보안 체크(JWT 검증, Kill Switch, 동시요청 1개, 일일 한도/예산, OpenAI
키는 서버 Secret에만)를 그대로 적용하고, 청크당 OpenAI 호출 1번으로 문장
개수만큼 사용량을 차감한다. 응답 개수가 입력 개수와 다르면 그 청크 전체를
실패로 처리한다(부분 매칭 추측 안 함). 청크 크기는 6개(`CHUNK_SIZE`), 응답이
`finish_reason:'length'`(토큰 한도로 중간에 끊김)면 `output_truncated`로
명확히 실패 처리하고 **그 경우에만** 청크를 반으로 쪼개 최대 2단계까지
재시도한다 (401/403/429 등은 재시도하지 않음).

## 표현장 상세 화면 + AI 재분석

표현장에서 표현을 **클릭**하면 `/expression/:id` 상세화면이 열린다 (즐겨찾기/
수정/삭제 버튼은 별도 영역이라 클릭과 안 겹침):

- 기본정보(원문/뜻/CEFR(AI 추정 명시)/🔊 발음(`speechSynthesis`, `fr-CA` 우선
  → 없으면 `fr-FR`)/즐겨찾기/출처/마지막 분석 시간)
- **[상세 분석 만들기]/[AI 다시 분석]** 버튼 → `analyze-batch`를 `detailed:
  true`로 호출(문장 1개 한정, 서버가 강제). 성공하면 문장구조/핵심문법/
  단어별 설명/흔한 실수/헷갈리는 표현/응용예문 2개가 `expressions.
  detailed_analysis`(jsonb)에 저장되고, **다음부터는 저장된 값만 읽는다**
  (화면 열 때마다 재호출 안 함)
- 사용자가 직접 고친 `meaning_ko`는 `meaning_ko_user_edited` 플래그로
  보호되어 재분석이 덮어쓰지 않음(다른 필드는 정상 갱신)

**분석 상태 머신** (`src/features/ai-batch/staleAnalysis.ts`): `pending`(요청
없음) / `analyzing`(진행중, `analysis_requested_at` 기록) / 90초 넘으면
**`stalled`로 자동 전환**("응답 없음 — 다시 시도", 추측성 무한 로딩 표시 안 함) /
`completed` / `failed`(실제 에러 메시지 표시, 재시도 가능). 표현장 상단
[선택] 모드로 여러 표현 체크 후 [선택한 표현 AI 분석] / [미완료 전체 다시
분석] / "실패한 표현만"·"뜻 없는 표현만" 빠른 선택 가능.

## 데이터베이스 마이그레이션

`supabase/migrations/`에 번호 순서로 들어있다. **검토 후 Supabase SQL
Editor(또는 `supabase db push`)에서 직접 실행한다 — 자동으로 적용되지
않는다.**

1. `0001_core_schema.sql` — expressions, review_states(FSRS), review_attempts, conversation_*, user_settings, user_streaks
2. `0002_ai_usage_and_budget.sql` — Kill Switch, 요청 제한, 과금 카운터
3. `0003_rls_policies.sql` — 모든 테이블 RLS
4. `0004_new_user_provisioning.sql` — 신규 유저(Google 로그인 첫 성공 포함) 기본 행 자동 생성 트리거
5. `0005_ai_usage_functions.sql` — 과금 카운터 원자적 증가 함수 (Edge Function 전용, 클라이언트 호출 불가)
6. `0006_source_type_and_tags.sql` — `expressions.tags`/`source_label` 추가, `source_type` 값 정리(school/tv5monde/daily/news/video/import 등)
7. `0007_chatgpt_prompt_override.sql` — `user_settings.chatgpt_prompt_override` (설정에서 ChatGPT 프롬프트 수정용, 아직 설정 UI는 미구현)
8. `0008_raw_notes.sql` — `raw_notes`(붙여넣은 원문 보존) + `expressions.raw_note_id`
9. `0009_fix_client_id_conflict_targets.sql` — **중요 버그 수정**: `expressions`/`raw_notes`의 `client_id` 유니크 인덱스가 부분 인덱스(`WHERE client_id IS NOT NULL`)였는데, 앱의 모든 upsert는 조건 없는 `ON CONFLICT (user_id, client_id)`를 써서 Postgres가 매칭을 못 해 **모든 저장이 실패**하고 있었음. `client_id`를 NOT NULL로 만들고 일반 UNIQUE 제약으로 교체. 이 마이그레이션 전까지는 앱에서 저장한 어떤 표현도 실제로 Supabase에 반영되지 않았을 가능성이 높음
10. `0010_ai_batch_fields.sql` — `expressions.corrected_fr`/`key_phrase` 추가, `ai_rate_limits.daily_expression_analyses` 기본값 30→150 (일괄 분석 최대 100개를 감당하기 위함, 기존 행도 갱신)
11. `0011_cleanup_trailing_backslash.sql` — `/paste-save`로 저장된 기존 행 중 마크다운 줄바꿈 잔재(`\`)가 끝에 남은 `expression_fr`/`meaning_ko`를 정리 (해당 안 되는 행은 건드리지 않음, 삭제 없음)
12. `0012_fix_max_output_tokens.sql` — **중요 버그 수정**: `ai_rate_limits.max_output_tokens` 기본값이 1024라서 15~20문장 배치 분석 시 OpenAI 응답이 중간에 끊겨 "Unterminated string in JSON" 오류가 났음. 기본값을 4000으로 올림(기존 행도 갱신) — `analyze-batch` 코드가 이 값을 상한으로 쓰는 동적 토큰 계산을 하므로, 이 마이그레이션 없이는 코드 수정도 무력화됨
13. `0013_detailed_analysis.sql` — 표현 상세 화면용 구조화 분석 저장: `expressions.detailed_analysis`(jsonb)/`analyzed_at`/`analysis_version`/`analysis_requested_at`/`meaning_ko_user_edited` 추가, `ai_analysis_status`에 `'analyzing'` 상태 추가(요청없음=pending과 실제진행중=analyzing을 구분, 전부 추가적 변경이라 기존 데이터 영향 없음)

## Edge Function 배포

```bash
supabase link --project-ref xwbcpanispdyrchddnzi
supabase functions deploy analyze-expression
supabase functions deploy analyze-batch
supabase secrets set OPENAI_API_KEY=sk-...   # 터미널에만 직접 입력. 채팅/코드에 쓰지 않기.
```

보안 지시서 원칙: **보안 테스트(인증 차단, RLS, 동시 요청 제한, Kill
Switch)를 통과하기 전에는 실제 OpenAI 키를 연결하지 않는다.** (지금까지
이 원칙을 지켜 실제 키는 아직 연결하지 않았다 — `analyze-batch`도 동일.)

모델을 바꾸려면 `ai_rate_limits.allowed_models` 배열을 SQL로 직접
수정하면 된다(예: `update ai_rate_limits set allowed_models = array['gpt-4o'] where user_id = '...'`) — 별도 UI는 만들지 않았다.

## 사용자가 직접 해야 하는 설정 (Claude Code가 대신 할 수 없는 작업)

1. **Supabase 마이그레이션 적용**: 위 13개 SQL을 순서대로 SQL Editor에서 실행 (0012, 0013이 새로 추가됨, 아직 미실행이면 검토 후 적용)
2. **Google OAuth**:
   - Google Cloud Console에서 OAuth 클라이언트 생성, 승인된 리디렉션 URI에
     `https://xwbcpanispdyrchddnzi.supabase.co/auth/v1/callback` 등록
   - Supabase 대시보드 → Authentication → Providers → Google에 Client ID/Secret 입력
3. **Supabase Auth URL 설정**: Authentication → URL Configuration
   - Site URL: `https://joiedevivre-cloud.github.io/french-active-recall/`
   - Redirect URLs: 위 URL + `http://localhost:5173/french-active-recall/` (로컬 개발용)
4. **GitHub 저장소 설정**:
   - Settings → Pages → Source: "GitHub Actions"
   - Settings → Secrets and variables → Actions → Variables에
     `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` 등록
5. **로컬 `.env.local`**: 위 환경 변수 표 참고
6. **OpenAI API 키**: 보안 테스트 통과 후 `supabase secrets set OPENAI_API_KEY=...`
7. **Edge Function 배포**: 위 "Edge Function 배포" 절 참고 (`analyze-expression`, `analyze-batch` 둘 다)
8. **최초 push**: `git push -u origin main` (원격 저장소가 비어있는 것을 확인했으므로 안전)

## 테스트 결과

### 자동화 (이번 세션에서 실행, 통과 확인)

- `npm run typecheck` — 통과
- `npm run build` — 통과 (더미 env로 로컬 빌드, 번들에 비밀키 누출 없음 확인)
- `npm test` (`vitest`) — **88개 테스트 통과** (전부 모킹 기반, 실제 OpenAI/Supabase 네트워크 호출 없음)
  - `normalizeFr.test.ts` (3개)
  - `pasteParser.test.ts` (39개): 유저 예시 3줄 분리, 글머리 기호 9종,
    원형 숫자, 마크다운 굵게/코드/표, 구분자 8종, `peut-être`/`Qu'est-ce
    que`/`Est-ce que` 보존, 프랑스어만 있는 줄, 제목→tags, 한글만 있는
    줄→확인 필요, 설명 문장 무시, 빈 줄 무시, **줄 끝 마크다운 역슬래시
    제거(3개, 분리 전/후 모두 포함, 하이픈·아포스트로피 안 건드리는지
    확인)**, 중복(정확 일치/악센트 다름/아포스트로피 통일/배치 내 반복/
    재붙여넣기) 전부 포함
  - `addExpression.test.ts` (5개): [+ 표현 추가] 입력이 fr/ko로 분리되는지, 출처 키워드→school 매핑
  - `aiBatchClient.test.ts` (13개, `supabase.functions.invoke` 모킹): 청크 분할 경계값,
    성공/서버 에러/개수 불일치/네트워크 예외 각각의 실패 처리, 청크 하나가
    실패해도 나머지 청크는 계속 진행, 실패 청크만 모아내는 로직
  - `applyAnalysisResult.test.ts` (15개, `supabase.from`/`functions.invoke` 모킹):
    새 표현 분석 성공 시 DB 반영, 실패 시 `ai_analysis_status='failed'`만
    변경(원본 보존), 예문 신규삽입 vs 기존예문 업데이트(재분석 멱등성),
    실패 후 재시도가 정상 결과로 덮어쓰는지, 배치 일부 실패, Edge Function
    네트워크 예외, **사용자가 수정한 `meaning_ko` 보호(다른 필드는 정상
    갱신)**, **상세 분석(`detailed_analysis`/`analyzed_at`/
    `analysis_version`) 저장**, `markAnalyzing` 상태 스탬프
  - `staleAnalysis.test.ts` (7개): pending(요청없음)/analyzing(진행중)/
    stalled(90초 넘게 응답없음)/completed/failed 상태 판정 경계값
  - `aiBatchClient.test.ts` (19개, `supabase.functions.invoke` 모킹): 청크 분할 경계값,
    성공/서버 에러/개수 불일치/네트워크 예외 각각의 실패 처리, 청크 하나가
    실패해도 나머지 청크는 계속 진행, 실패 청크만 모아내는 로직,
    **`output_truncated`만 반으로 쪼개 재시도(401/403/429는 재시도 안 함,
    최대 깊이에서 포기)**, 실제 HTTP 상태/본문 추출 및 API 키 마스킹
- `src/lib/csvImport.ts`용 자동 테스트는 **아직 작성 안 함** (CSV 미리보기 플로우는
  화면까지 만들지 않아 보류 — AI 일괄 분석은 별도의 `pasteParser` 기반 경로로 구현)
- "표현 클릭 → 상세화면", "모바일 UI" 등 화면 동작은 **자동화 불가** (이
  프로젝트에 컴포넌트 렌더링 테스트 도구가 없음) — 수동 확인 대상
- `analyze-batch`/`analyze-expression` Edge Function의 실제 OpenAI 응답 처리는
  **부분 검증됨** — 토큰 절단 수정(Phase 0)은 실제 로그로 성공 확인했으나,
  이번에 추가한 **상세 분석(`detailed: true`) 경로는 아직 실제 호출로
  검증 못함**. 아래 "실제 Supabase/OpenAI 연동 검증" 참고

### 수동 (사용자 환경에서만 가능 — 미검증)

다음은 실제 Supabase 연결·배포 후에만 확인 가능해 **이번 세션에서는
미검증**으로 남긴다:

- 휴대폰에서 유저 예시(`Je pense à lui. — ...` 3줄)를 `/paste-save`에
  붙여넣고 저장 → Supabase `expressions`/`review_states`/`raw_notes`에
  3행 반영 → 표현장과 오늘 복습에 표시
- 오프라인 저장 → 온라인 복귀 시 `pendingPasteBatches` 자동 동기화
- 모바일에서 표현 저장 → Supabase 반영 → 새로고침 후 유지
- Google 로그인 후 원래 화면으로 복귀
- RLS: 다른 사용자 데이터 접근 차단
- Edge Function: 비로그인/위조 JWT 차단, 동시 요청 제한, Kill Switch 동작
- GitHub Actions 빌드 성공 및 자동 재배포
- PWA 설치, 오프라인 저장 → 재연결 시 동기화
- `/ai-batch`: 실제 문장 여러 개 붙여넣기 → 1초 디바운스 자동 분석 → 결과
  카드 표시 → 저장 → 표현장/오늘복습 반영 (OpenAI 키 연결 후에만 가능)

## 향후 개선 목록 (Phase 2 / 3, 지시서 §18 기준)

- 음성 입력, 사진 OCR, 프랑스어 TTS
- 음성 인출 훈련, 상황 기반 인출
- B2 700문장 모듈 (데이터 없이는 스키마/임포터만 존재 — 실제 문장 데이터 필요)
- 쉐도잉 모드
- AI 상황 대화 (현재 하단 네비게이션에 자리만 있고 미구현)
- 학습 통계/레이더 차트, B2 준비도 점수
- Anki CSV/TSV 가져오기 (내보내기는 미구현 포함 Phase 1 범위 밖)
- `conversation_turns` 보존기간 정리 작업 (pg_cron/Edge Function)
- 필드 단위 오프라인 충돌 해소
