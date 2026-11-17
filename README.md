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

## 데이터베이스 마이그레이션

`supabase/migrations/`에 번호 순서로 들어있다. **검토 후 Supabase SQL
Editor(또는 `supabase db push`)에서 직접 실행한다 — 자동으로 적용되지
않는다.**

1. `0001_core_schema.sql` — expressions, review_states(FSRS), review_attempts, conversation_*, user_settings, user_streaks
2. `0002_ai_usage_and_budget.sql` — Kill Switch, 요청 제한, 과금 카운터
3. `0003_rls_policies.sql` — 모든 테이블 RLS
4. `0004_new_user_provisioning.sql` — 신규 유저(Google 로그인 첫 성공 포함) 기본 행 자동 생성 트리거
5. `0005_ai_usage_functions.sql` — 과금 카운터 원자적 증가 함수 (Edge Function 전용, 클라이언트 호출 불가)

## Edge Function 배포

```bash
supabase link --project-ref xwbcpanispdyrchddnzi
supabase functions deploy analyze-expression
supabase secrets set OPENAI_API_KEY=sk-...   # 터미널에만 직접 입력. 채팅/코드에 쓰지 않기.
```

보안 지시서 원칙: **보안 테스트(인증 차단, RLS, 동시 요청 제한, Kill
Switch)를 통과하기 전에는 실제 OpenAI 키를 연결하지 않는다.**

## 사용자가 직접 해야 하는 설정 (Claude Code가 대신 할 수 없는 작업)

1. **Supabase 마이그레이션 적용**: 위 5개 SQL을 순서대로 SQL Editor에서 실행
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

### 자동화

- `npm run typecheck` — 로컬에서 실행 확인 필요 (아래 "미검증" 참고)
- `npm test` (`vitest`) — `normalizeFr` 유닛 테스트만 존재. 핵심 플로우(저장/복습/인증)에 대한 자동화 테스트는 아직 없음

### 수동 (사용자 환경에서만 가능 — 미검증)

다음은 실제 Supabase 프로젝트 연결, Google OAuth 설정, GitHub Pages 배포가
끝나야 검증 가능하여 **이번 세션에서는 미검증**으로 남긴다:

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
