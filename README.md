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
  AI가 생성한 값이 아니다 (`ai_analysis_status`는 `pending`으로 남아
  있어 이후 분석과 구분됨).

**아직 구현하지 않은 보조 기능** (요청에서 "위 기능이 완성된 뒤"로 명시된 부분):
- "확인 필요" 줄을 Edge Function으로 AI 정리하는 `[AI로 정리]` 버튼
- `meaning_ko`가 빈 표현을 백그라운드 AI로 채우는 자동화 (현재는 수동으로
  표현장에서 수정하거나, 추후 이 자동화가 추가될 때까지 비어 있는 채로 둠)

**별개로 주의할 점:** `src/content/chatgpt-prompt.md`에 넣은 ChatGPT
프롬프트는 **CSV 표 형식**(````csv` 블록, `프랑스어,한국어 뜻,분류,출처`
헤더)을 출력하도록 되어 있는데, 이는 `src/lib/csvImport.ts` 기반의 "CSV
미리보기 가져오기" 플로우(요청상 더 먼저 설계됐지만 이번엔 화면까지는
만들지 않음)용이다. 지금 만든 `/paste-save` 화면은 그 CSV를 파싱하지
않는다 — 자유 형식 글머리 목록을 붙여넣는 용도다. 두 플로우를 다 쓰려면
나중에 "프롬프트 복사" 버튼과 CSV 미리보기 화면을 별도로 이어서 만들어야
한다.

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

## Edge Function 배포

```bash
supabase link --project-ref xwbcpanispdyrchddnzi
supabase functions deploy analyze-expression
supabase secrets set OPENAI_API_KEY=sk-...   # 터미널에만 직접 입력. 채팅/코드에 쓰지 않기.
```

보안 지시서 원칙: **보안 테스트(인증 차단, RLS, 동시 요청 제한, Kill
Switch)를 통과하기 전에는 실제 OpenAI 키를 연결하지 않는다.**

## 사용자가 직접 해야 하는 설정 (Claude Code가 대신 할 수 없는 작업)

1. **Supabase 마이그레이션 적용**: 위 8개 SQL을 순서대로 SQL Editor에서 실행 (0006~0008은 새로 추가됨, 아직 미실행이면 검토 후 적용)
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
7. **Edge Function 배포**: 위 "Edge Function 배포" 절 참고
8. **최초 push**: `git push -u origin main` (원격 저장소가 비어있는 것을 확인했으므로 안전)

## 테스트 결과

### 자동화 (이번 세션에서 실행, 통과 확인)

- `npm run typecheck` — 통과
- `npm run build` — 통과 (더미 env로 로컬 빌드, 번들에 비밀키 누출 없음 확인)
- `npm test` (`vitest`) — **39개 테스트 통과**
  - `normalizeFr.test.ts` (3개)
  - `pasteParser.test.ts` (36개): 유저 예시 3줄 분리, 글머리 기호 9종,
    원형 숫자, 마크다운 굵게/코드/표, 구분자 8종, `peut-être`/`Qu'est-ce
    que`/`Est-ce que` 보존, 프랑스어만 있는 줄, 제목→tags, 한글만 있는
    줄→확인 필요, 설명 문장 무시, 빈 줄 무시, 중복(정확 일치/악센트
    다름/아포스트로피 통일/배치 내 반복/재붙여넣기) 전부 포함
- `src/lib/csvImport.ts`용 자동 테스트는 **아직 작성 안 함** (이번 우선순위
  변경으로 `/paste-save`에 집중했고, CSV 미리보기 플로우는 화면까지
  만들지 않아 보류)

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
