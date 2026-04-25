# <ISO 이름> — Endpoint Spec

> **Instructions**: 새 ISO 문서 만들 때 이 파일을 `<iso>.md`로 복사하고 10개 섹션 전부 채우세요.
> Category B 조사 목표 = Grid402가 upstream 데이터를 정상 정규화·서빙하는지 검증.

---

## 1. 기본 정보
| 항목 | 값 |
|---|---|
| ISO/TSO | <CAISO, ERCOT, ENTSO-E, KPX, ...> |
| 관할 지역 | <주·국가·지역 리스트> |
| 시그널 | <price / mix / load / flow / forecast — 이 파일이 커버하는 것> |
| Upstream URL | <전체 URL> |
| HTTP 메서드 | GET / POST |
| 응답 포맷 | <CSV / JSON / XML / HTML / Zipped CSV> |
| 업데이트 주기 | <5min / 15min / 30min / 1h / daily> |
| 가용 zone 수 | <예: 4300 nodes, 20 hubs, or system-wide only> |
| 시간대 | <UTC / Pacific / KST / ...> |
| Grid402 엔드포인트 | `/spot/<iso>/:zone/live` · `/mix/<iso>/live` · ... |

## 2. 인증
- **방식**: <무인증 / API key / security token / session+CSRF / OAuth>
- **발급 경로**: <URL>
- **토큰 저장**: `.env` 변수명 / Keychain service 이름
- **예상 발급 소요**: <즉시 / 수일>

## 3. 데이터 스키마

### 3.1 원본 필드 (관심 필드만)
<열 이름, 타입, 단위, 의미>

### 3.2 원본 → Grid402 canonical 매핑

**Price:**
- `COLUMN_X` → `lmp_usd_per_mwh`

**Generation Mix:**
| 원본 컬럼 | Canonical FuelType | 비고 |
|---|---|---|
| e.g. "Natural Gas" | `gas` | |
| e.g. "Large Hydro" + "Small hydro" | `hydro` | 합산 |
| e.g. "Batteries" | `storage` | 음수 = charge |

### 3.3 특이사항
- Negative values 처리
- Null / missing 처리
- 단위 변환 (MWh vs kWh, USD vs EUR, kW vs MW)

## 4. Sample curl (실제 작동)
```bash
curl -sSL "<URL>" \
  -H "<필요한 헤더>" \
  -o /tmp/sample.csv \
  -w "HTTP %{http_code}  size %{size_download}  type %{content_type}\n"
head -3 /tmp/sample.csv
```

예상 응답:
```
<응답 첫 3줄>
```

## 5. 파서 구현
- **파일**: `api/src/<iso>.ts`
- **주요 함수**:
  - `fetch<Iso>LivePrice(zone)` → `<Iso>PriceTick`
  - `fetch<Iso>GenerationMix()` → `<Iso>MixTick`
  - `get<Iso>PriceCached(zone)` · `get<Iso>MixCached()` (60s TTL)
- **예상 코드량**: <줄>
- **특별 의존성**: `fast-xml-parser` / `cheerio` / `fflate` / ...

## 6. 라이선스 / 재배포
- **License**: <Public domain / CC-BY 4.0 / Open Data with attribution / Proprietary>
- **Attribution 필수**: yes / no
- **Redistributable**: yes / no / restricted
- **Citation 예시**:
  ```json
  {
    "publisher": "<기관명>",
    "license": "<라이선스>",
    "upstream": "<URL>"
  }
  ```

## 7. 품질 체크
- **완결성**:
  - Mix: `sum(mw for fuel != imports,storage) ≈ total_mw` (±5%)
  - Price: 존재 범위 `[-$100, $3000]/MWh` (negative prices 합법)
- **이상치**:
  - 이전 interval ±50% 벗어나면 스테일 의심
  - Fuel별 허용 범위 (nuclear 변동 느림, solar 아침 0 정상)
- **Fallback**:
  - upstream 실패 시 last-known-good 반환 (최대 15분 유예)

## 8. 기존 구현 참조
- **Electricity Maps parser**: `electricitymap/contrib/parsers/<NAME>.py`
- **AGPL-3.0 주의**: 읽기만 OK, 코드 복붙 금지. 사실(URL, 필드명)만 참조.

## 9. 알려진 함정
- DST 전환 (봄/가을 시간 변경 시 1시간 스키드)
- CSRF 토큰 필요 (KPX, 일부 일본 utility)
- 레이트 리밋 (ENTSO-E 400 requests/min)
- 음수값 / 빈 필드 처리
- 주말·공휴일 응답 구조 변경

## 10. 테스트
- **Smoke test**: `.context/grid402/scripts/smoke_<iso>.sh`
- **Contract test**: `api/src/<iso>.test.ts` (Vitest, mock 응답 3개 이상)
- **Live smoke**: 5회 연속 성공 5분 간격

---

## 11. Status (Done Definition)
- [ ] Spec 섹션 1-10 채움
- [ ] Smoke test 스크립트 작성 + 5회 연속 통과
- [ ] TypeScript 파서 작성
- [ ] `pnpm tsc --noEmit` 통과
- [ ] Vitest 테스트 3개 이상 통과
- [ ] `/spot/<iso>/:zone/live` 로컬 응답 확인
- [ ] `/mix/<iso>/live` 로컬 응답 확인
- [ ] `/emissions/<iso>/live` gCO2/kWh 합리 범위
- [ ] `/combined/<iso>/:zone/live` 통합 응답 확인
- [ ] Attribution payload에 명시

---

**Last updated**: YYYY-MM-DD
**Investigator**: <name>
