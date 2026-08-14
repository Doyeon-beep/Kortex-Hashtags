# Hashtag Classifier (내부 툴)

해시태그를 입력하면 moria 구글시트(categories/brands 탭)를 라이브로 조회해서 분류를 도와주는 내부 툴입니다.

## 구현된 것

`hashtag_classification_guideline.md`의 "매칭 절차" 섹션 기준:

1. **정확한 문구로 exact match 조회** (`lib/sheetQuery.js`)
2. **어미 제거 후 재조회** — 복수형/진행형/과거형 (`lib/stem.js`)
3. **축약어 사전 확장 후 재조회** — nj, ca, dfw, pdx 등 (`lib/abbreviations.js`)
4. **1~3단계 모두 실패하면 Claude API로 신규 항목 조사** (`lib/claudeResearch.js`) — `query_taxonomy_sheet`(시트 재확인)와 `web_search`(TikTok/구글, 최대 2회) 도구를 주고, 반드시 `submit_classification`으로 마무리하게 강제. 비용이 드는 단계라 화면의 체크박스로 켜고 끌 수 있고, 기본값은 꺼짐.

기타:
- 비영어 세그먼트는 exact match 전에 번역 시도 (`lib/translate.js`) — `TRANSLATE_API_KEY` 없으면 스킵하고 바로 4단계로.
- 에러(조회 실패)와 매칭없음을 명확히 구분 (`sheetQuery.js`의 `runGvizQuery`가 `status: "error"` vs `status: "ok", rows: []` 분리 반환, 재시도 포함).
- **배치 내 일관성 재검토** (`lib/consistency.js`) — 같은 세그먼트가 배치 안에서 다르게 분류되면(주로 4단계 AI 응답의 비결정성 때문) 자동으로 고치지 않고 화면에 경고로 표시.
- **엑셀 export** (`lib/exportRows.js`, `/api/export`) — 결과를 기존 헤더 형식(cat1~5, brand, product line, hashtag, inclusion, new, comments)으로 다운로드.
- cat1~cat3 트리 캐싱 인프라(`lib/cat123Cache.js`)는 만들어뒀지만 아직 매칭 로직에 연결하지 않음 — 다음 최적화 후보.

## 검증 상태 (중요)

- `npm run build`로 스캐폴딩 초기 버전(UI + 1~3단계)은 이 작업 환경에서 정상 컴파일 확인했습니다.
- 이후 Claude API(task #8) + 엑셀 export(task #9)를 추가한 뒤에는, **이 작업 환경 자체의 리소스/네트워크 제약 때문에 `npm run build`가 끝까지 완료되는 걸 확인하지 못했습니다** (빌드가 웹팩 단계 이전에 멈추는 현상 — 이 샌드박스가 대부분의 외부 도메인 접근을 막아두고 있어서 Next.js의 초기 네트워크 관련 체크가 걸리는 것으로 추정됩니다). 각 파일의 문법 검사(`node --check`)는 통과했고, 새 라이브러리(`@anthropic-ai/sdk`)가 Node에서 정상 로드되는 것도 확인했지만, **실제 `npm run build`/`npm run dev`는 로컬 또는 Vercel에서 꼭 한 번 직접 확인해주세요.** 에러가 나면 알려주시면 바로 고칠게요.

## 로컬에서 실행하기

```bash
npm install
cp .env.example .env.local   # 값 채우기
npm run build   # 꼭 먼저 확인
npm run dev
```

## 환경변수 (Vercel 배포 시 Project Settings → Environment Variables)

`.env.example` 참고.
- `ANTHROPIC_API_KEY`: 4단계(신규 항목 AI 조사)에 필요. 없으면 그 단계는 자동으로 스킵됨(에러 안 남).
- `TRANSLATE_API_KEY`: 없으면 비영어 세그먼트가 번역 없이 바로 4단계로 넘어감.

## GitHub / Vercel 배포

```bash
git init
git add .
git commit -m "Initial hashtag classifier scaffold"
```

1. GitHub에 private repo 생성 후 위 커밋 push
2. Vercel에서 그 repo import
3. 위 환경변수들을 Vercel 대시보드에 입력
4. 배포 후 링크로 접속해서 해시태그 몇 개로 실제 분류 테스트
