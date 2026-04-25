# CAISO — Endpoint Spec

## 1. 기본 정보
| 항목 | 값 |
|---|---|
| ISO/TSO | California ISO (CAISO) |
| 관할 지역 | 미국 캘리포니아 주 (+ 일부 인접 유틸리티) |
| 시그널 | **Price (5-min RTM LMP)** + **Generation Mix (5-min)** |
| Upstream URL | `https://oasis.caiso.com/oasisapi/SingleZip` (price) + `https://www.caiso.com/outlook/current/fuelsource.csv` (mix) |
| HTTP 메서드 | GET (둘 다) |
| 응답 포맷 | **ZIP+CSV** (price) / **plain CSV** (mix) |
| 업데이트 주기 | 5분 (price + mix 둘 다) |
| 가용 zone | 3개 거래 hub (TH_NP15_GEN-APND, TH_SP15_GEN-APND, TH_ZP26_GEN-APND) + 수천 개 노드. mix는 시스템 전체 |
| 시간대 | UTC (OASIS) · Pacific PST/PDT (fuelsource.csv, 자체 변환 필요) |
| Grid402 엔드포인트 | `/spot/CAISO/:zone/live` · `/mix/CAISO/live` · `/emissions/CAISO/live` · `/combined/CAISO/:zone/live` |

## 2. 인증
- **방식**: **무인증** (둘 다 공개 엔드포인트)
- **발급 경로**: 없음
- **토큰 저장**: 불필요
- **예상 발급 소요**: 0 (즉시 사용)

## 3. 데이터 스키마

### 3.1 원본 필드 — Price (OASIS)

CAISO OASIS `PRC_INTVL_LMP` 쿼리 응답 (ZIP 안 CSV):

| 컬럼 | 의미 |
|---|---|
| `INTERVALSTARTTIME_GMT` | 5분 interval 시작 (UTC) |
| `INTERVALENDTIME_GMT` | interval 끝 (UTC) |
| `NODE` | 거래 노드 / hub 이름 |
| `DATA_ITEM` | `LMP_PRC`, `LMP_CONG_PRC`, `LMP_ENE_PRC`, `LMP_LOSS_PRC` |
| `VALUE` | 금액 (USD/MWh) |
| `MARKET_RUN_ID` | `RTM` / `DAM` |

**Grid402 사용 방식**: 여러 row 중 `DATA_ITEM=LMP_PRC` 필터 + 최신 interval row 추출 → `lmp_usd_per_mwh`

### 3.2 원본 필드 — Generation Mix (fuelsource.csv)

```
Time,Solar,Wind,Geothermal,Biomass,Biogas,Small hydro,Coal,Nuclear,Natural Gas,Large Hydro,Batteries,Imports,Other
00:00,-62,5119,645,123,141,271,0,2277,2670,3126,2760,4792,0
00:05,-61,5114,645,122,141,270,0,2278,2723,3058,2925,4983,0
...
```

- **Time**: `HH:MM` Pacific 로컬 (DST 자동 적용되는 듯 — 검증 필요)
- **각 연료 컬럼**: MW (system-wide sum)
- **Batteries**: 양수 = 방전, 음수 = 충전
- **Imports**: 양수 = 수입, 음수 = 순수출

### 3.3 원본 → Grid402 canonical 매핑

**Price**: `VALUE` (DATA_ITEM=LMP_PRC) → `signals.price.lmp_usd_per_mwh`

**Generation Mix** — `api/src/caiso.ts` 의 `CAISO_FUEL_MAP`:

| 원본 컬럼 | Canonical `FuelType` | 비고 |
|---|---|---|
| Solar | `solar` | 새벽엔 음수 가능 (self-consumption) |
| Wind | `wind` | |
| Geothermal | `geothermal` | |
| Biomass | `biomass` | Biogas와 합산 |
| Biogas | `biomass` | |
| Small hydro | `hydro` | Large Hydro와 합산 |
| Large Hydro | `hydro` | |
| Coal | `coal` | 최근엔 거의 항상 0 |
| Nuclear | `nuclear` | Diablo Canyon only |
| Natural Gas | `gas` | |
| Batteries | `storage` | 양수=discharge, 음수=charge |
| Imports | `imports` | |
| Other | `other` | Unknown 범주 |

### 3.4 특이사항
- **Solar 음수값**: 자정·새벽에 ~ -60 MW (self-consumption) → Grid402에서 `max(v, 0)` 처리
- **Batteries 음수**: 충전 중 정상 (-380 등). 발전 총합에서 제외 (storage 카테고리)
- **Imports 음수**: 순수출 (드물게)
- **DST 처리**: `api/src/caiso.ts::isPacificDst()` — 2nd Sunday March ~ 1st Sunday November PDT

## 4. Sample curl (실제 작동)

```bash
# Price
curl -sSL "https://oasis.caiso.com/oasisapi/SingleZip?queryname=PRC_INTVL_LMP&startdatetime=20260425T00:00-0000&enddatetime=20260425T01:00-0000&market_run_id=RTM&version=3&node=TH_NP15_GEN-APND&resultformat=6" \
  -o /tmp/caiso_price.zip \
  -w "HTTP %{http_code}  size %{size_download}  type %{content_type}\n"
# HTTP 200  size 1110 bytes  type application/x-zip-compressed

# Generation Mix
curl -sSL "https://www.caiso.com/outlook/current/fuelsource.csv" \
  -o /tmp/caiso_mix.csv \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size ~14420 bytes
head -3 /tmp/caiso_mix.csv
```

## 5. 파서 구현
- **파일**: `api/src/caiso.ts` (237 lines)
- **주요 함수**:
  - `fetchCaisoLiveLmp(zone)` → `CaisoPriceTick` — ZIP 다운로드, unzip, CSV 파싱, 최신 LMP_PRC 추출
  - `fetchCaisoGenerationMix()` → `CaisoMixTick` — fuelsource.csv 파싱, 14 컬럼 → 11 canonical 매핑
  - `getCaisoLivePriceCached(zone)` · `getCaisoMixCached()` — 60s TTL
- **의존성**: `fflate` (ZIP 풀기), `fetch` (내장)
- **배출량 계산**: `api/src/emission-factors.ts::computeEmissions(mix)` — IPCC AR6 lifecycle 적용

## 6. 라이선스 / 재배포
- **License**: **US public domain** (California 주정부 공기관 데이터)
- **Attribution 필수**: no (공개 도메인) — **그래도 Grid402는 무조건 명시**
- **Redistributable**: **yes** (제약 없음)
- **Citation**:
  ```json
  {
    "publisher": "California ISO (CAISO) OASIS + Outlook",
    "license": "US public domain",
    "upstream": "oasis.caiso.com + www.caiso.com/outlook"
  }
  ```

## 7. 품질 체크

### 7.1 Price 합리성
- 일반 범위: **$20 - $200/MWh**
- 극단 범위: **-$150 ~ +$2000/MWh** (음의 가격, 피크 급등 포함)
- 체크: 같은 노드의 15분 전 값과 ±300% 벗어나면 warn

### 7.2 Generation Mix 완결성
- `sum(mw for fuel != imports,storage) ≈ total_load` (±5%)
- 각 fuel별 이전 interval ±50% 벗어나면 warn
- Nuclear는 변동 거의 없음 (Diablo Canyon 2270 MW 근처 고정)

### 7.3 샘플 검증 (오늘 데이터 기준)
오늘 CAISO 19:15 로컬:
- Total generation: 14,887 MW
- 계산된 `gco2_per_kwh` = **101.6** (IPCC AR6 lifecycle) ✓
- Renewable %: 72.5% ✓
- Carbon-free %: 87.8% ✓

## 8. 기존 구현 참조
- **Electricity Maps parser**: `electricitymap/contrib/parsers/US_CA.py` (412 lines)
  - **AGPL-3.0 주의**: 읽기만 OK
  - 우리가 참조한 사실: `CAISO_PROXY` URL, `PRODUCTION_URL_REAL_TIME` = `outlook/current/fuelsource.csv`, 14개 연료 컬럼 이름
- **우리 구현**: 독립 작성 (`api/src/caiso.ts`) — Python → TypeScript 재구현, 코드 공유 없음

## 9. 알려진 함정
- **DST 전환 (봄 2nd Sunday Mar / 가을 1st Sunday Nov)**: Pacific time → UTC 변환 시 1시간 스키드 가능 → `isPacificDst()` 함수로 처리
- **CSRF/session 불필요** (공개 GET)
- **Rate limit** 명시 없음 but 공손하게: 5분 이하 폴링 금지
- **OASIS 정기 유지보수**: 주 1회 새벽 (PT 02:00-04:00) 30분 downtime 가능 → 60초 캐시 + last-known-good fallback 권장
- **빈 CSV 응답**: 아주 신선한 interval은 데이터 없을 수 있음 — `fetch_production` 이 빈 row 반환 → 바로 전 interval 사용
- **Negative Solar**: 새벽 self-consumption — `max(v, 0)` 필요
- **Batteries 부호**: 양수 = discharge (MW 생산), 음수 = charge (MW 소비). Grid402 FuelType `storage` 에 그대로 저장

## 10. 테스트
- **Smoke test**: `.context/grid402/scripts/smoke_caiso.sh` (작성 예정)
- **Contract test**: `api/src/caiso.test.ts` (작성 예정) — Vitest, mock 3개 케이스:
  1. 정상 price 응답
  2. mix 정상 응답
  3. 음수 solar + 음수 battery
- **Live smoke**: 오늘 여러 번 실행해서 작동 확인 ✓

---

## 11. Status (Done Definition)
- [x] Spec 섹션 1-10 채움
- [ ] Smoke test 스크립트 작성 (pending `scripts/`)
- [x] TypeScript 파서 작성 (`api/src/caiso.ts` 237 lines)
- [ ] `pnpm tsc --noEmit` 통과 (pending pnpm install)
- [ ] Vitest 테스트 3개 이상 (pending)
- [x] `/spot/CAISO/:zone/live` 라우팅 연결 (코드 상 있음)
- [x] `/mix/CAISO/live` 라우팅 연결
- [x] `/emissions/CAISO/live` → 오늘 샘플 ~101.6 gCO2/kWh 수동 검증 완료
- [x] `/combined/CAISO/:zone/live` 라우팅 연결
- [x] Attribution payload에 명시 (`caisoOasisSource`, `caisoFuelsourceSource`, `caisoCombinedSource`)

---

**Last updated**: 2026-04-25
**Investigator**: Grid402 팀
**관련 파일**: `api/src/caiso.ts` · `api/src/emission-factors.ts` · `api/src/types.ts` · `api/src/index.ts`
