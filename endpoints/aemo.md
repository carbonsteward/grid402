# AEMO — Endpoint Spec

## 1. 기본 정보
| 항목 | 값 |
|---|---|
| ISO/TSO | Australian Energy Market Operator (AEMO) — National Electricity Market (NEM) |
| 관할 지역 | 호주 동부·남부 5개 region: NSW1, QLD1, VIC1, SA1, TAS1 (WA의 WEM은 별도 시장, 본 spec 범위 밖) |
| 시그널 | **Price (5-min DISPATCH RRP)** + **Generation Mix (5-min DISPATCH SCADA)** + (보조) **Rooftop Solar (30-min)** |
| Upstream URL | NEMWEB rolling "Current" directories (디렉토리 listing → 가장 최신 ZIP fetch). 인증 없음. |
| | Price: `https://nemweb.com.au/Reports/Current/DispatchIS_Reports/` |
| | Generation: `https://nemweb.com.au/Reports/Current/Dispatch_SCADA/` |
| | Rooftop PV: `https://nemweb.com.au/Reports/Current/ROOFTOP_PV/ACTUAL/` |
| HTTP 메서드 | GET (둘 다) |
| 응답 포맷 | **Zipped CSV** (모두 NEMDF "C/I/D" 다중 섹션 CSV). 디렉토리는 IIS 스타일 HTML index. |
| 업데이트 주기 | **5분** (Dispatch_SCADA, DispatchIS) · 30분 (Rooftop PV satellite) |
| 가용 zone | 5 region (NSW1, QLD1, VIC1, SA1, TAS1). 가격은 region별, mix는 587+ DUID 단위로 published → fuel별 합산해서 region/system 두 단위로 노출 |
| 시간대 | **NEM time = AEST (UTC+10), 연중 고정 — DST 없음**. interval timestamp는 interval **종료** 시각. ROOFTOP_PV satellite는 30분 종료 시각 기준. |
| Grid402 엔드포인트 | `/spot/AEMO/:region/live` · `/mix/AEMO/:region/live` · `/mix/AEMO/live` (system) · `/emissions/AEMO/:region/live` · `/combined/AEMO/:region/live` |

## 2. 인증
- **방식**: **무인증** (NEMWEB CURRENT 디렉토리는 완전 공개 GET)
- **발급 경로**: 없음
- **토큰 저장**: 불필요
- **예상 발급 소요**: 0 (즉시 사용)
- **참고**: OpenElectricity v4 API (`api.openelectricity.org.au/v4/...`)는 Bearer token 필요 (free tier 가능) — Grid402는 NEMWEB 직접 패스 우선, OpenElectricity는 fallback 후보로만 검토.

## 3. 데이터 스키마

### 3.1 NEMDF 공통 포맷 (모든 NEMWEB ZIP CSV)

ZIP 안에 단일 CSV. 한 파일 안에 여러 "테이블"이 섹션별로 들어있음. 각 행 첫 컬럼이 row type:
- `C,...` — comment / file header & footer ("END OF REPORT" 종료)
- `I,<package>,<table>,<version>,<col1>,<col2>,...` — interface (해당 섹션의 컬럼 정의)
- `D,<package>,<table>,<version>,<val1>,<val2>,...` — data row (직전 `I` 행의 컬럼명에 매핑)

파서는 `I` 행을 만나면 컬럼 헤더를 갱신, 이후 `D` 행을 그 헤더에 따라 파싱.

### 3.2 Price — `DispatchIS_Reports`

파일명 패턴: `PUBLIC_DISPATCHIS_<YYYYMMDDHHMM>_<seq>.zip` (5분마다 신규)

CSV 안 관심 섹션: `I,DISPATCH,PRICE,5,...`

| 컬럼 | 타입 | 단위 | 의미 |
|---|---|---|---|
| `SETTLEMENTDATE` | datetime | NEM (UTC+10) | interval 종료시각, e.g. `"2026/04/25 13:30:00"` |
| `RUNNO` | int | — | dispatch run 번호 |
| `REGIONID` | string | — | `NSW1` / `QLD1` / `SA1` / `TAS1` / `VIC1` |
| `DISPATCHINTERVAL` | int | — | YYYYMMDDPPP (PPP=001~288 일내 5분 슬롯) |
| `INTERVENTION` | int | — | 0 = 정상 dispatch row (Grid402는 0만 사용) |
| `RRP` | float | **AUD/MWh** | Regional Reference Price = 해당 region 5분 spot 가격 |
| `EEP`, `ROP` | float | AUD/MWh | (참고용 — 사용 안 함) |
| `RAISE6SECRRP` 등 | float | — | FCAS ancillary 가격 (Grid402 무시) |
| `LASTCHANGED` | datetime | NEM | publication 시각 |

### 3.3 Generation Mix — `Dispatch_SCADA`

파일명 패턴: `PUBLIC_DISPATCHSCADA_<YYYYMMDDHHMM>_<seq>.zip` (5분마다 신규, ~3-4 KB ZIP)

CSV 안 단일 섹션: `I,DISPATCH,UNIT_SCADA,1,SETTLEMENTDATE,DUID,SCADAVALUE,LASTCHANGED`

| 컬럼 | 타입 | 단위 | 의미 |
|---|---|---|---|
| `SETTLEMENTDATE` | datetime | NEM | interval 종료시각 |
| `DUID` | string | — | Dispatchable Unit Identifier (e.g. `BAYSW1`, `BARCSF1`, `MACARTH1`). 587+ 등록 DUID |
| `SCADAVALUE` | float | **MW** | 해당 DUID의 5분 평균 출력. 양수 = 발전, 음수 가능 (배터리 충전·자체소비) |
| `LASTCHANGED` | datetime | NEM | SCADA 측정 시각 (보통 `SETTLEMENTDATE - 5min`) |

**중요**: SCADA 값에는 **rooftop solar 미포함**. AEMO의 rooftop PV는 별도 30분 satellite 추정치 (3.4 참조).

### 3.4 Rooftop PV (보조) — `ROOFTOP_PV/ACTUAL`

파일명 패턴: `PUBLIC_ROOFTOP_PV_ACTUAL_SATELLITE_<YYYYMMDDHHMMSS>_<seq>.zip` (30분마다)

`I,ROOFTOP,ACTUAL,2,INTERVAL_DATETIME,REGIONID,POWER,QI,TYPE,LASTCHANGED`

| 컬럼 | 의미 |
|---|---|
| `INTERVAL_DATETIME` | 30분 종료시각 (NEM) |
| `REGIONID` | NSW1 / QLD1 / SA1 / TAS1 / VIC1 |
| `POWER` | MW (region 합계, 위성 추정) |
| `QI` | quality index 0~1 (0.6 = 위성 nowcast) |
| `TYPE` | `SATELLITE` (Grid402가 사용) / `MEASUREMENT` (사후 보정) |

5-min Dispatch_SCADA + 30-min ROOFTOP을 합쳐야 "총" solar가 됨 → Grid402 mix endpoint는 두 fuel sub-bucket 결합 처리 (`solar.utility` + `solar.rooftop`).

### 3.5 DUID → Fuel 매핑

**핵심 함정**: NEMWEB은 DUID별 raw MW만 제공 — fuel category는 외부 매핑 필요.

레퍼런스 매핑 소스 (셋 다 호환 가능):
- **OpenNEM facility registry** (현재 권장): `https://raw.githubusercontent.com/opennem/opennem/master/opennem/db/fixtures/facility_registry.json` — 587 DUID, `duid_data[duid].fuel_tech` 필드. 공개 GitHub fetch.
- **AEMO NEM Registration & Exemption List (NER)**: `aemo.com.au/-/media/files/electricity/nem/participant_information/nem-registration-and-exemption-list.xls` (Excel) — 공식이지만 다운로드 차단 (HTTP 403, User-Agent 우회 필요). 정기 갱신 (월 1회).
- **OpenElectricity v4 facilities API**: token 필요.

Grid402 권장: **OpenNEM JSON registry를 빌드 타임에 fetch → static TS map으로 freeze**. 신규 DUID 발견 시 (`UNKNOWN_DUID` warning) 메일 알림 + 다음 빌드에서 갱신.

### 3.6 원본 → Grid402 canonical 매핑

**Price**: `RRP` (REGIONID, INTERVENTION=0) → `lmp_aud_per_mwh` (Grid402는 AUD 보존 + USD 환산 필드 별도). 일관성 위해 `lmp_local_per_mwh` + `currency: "AUD"` 패턴 채택.

**Generation Mix** — DUID `fuel_tech` → canonical FuelType:

| OpenNEM `fuel_tech` | Canonical FuelType | 비고 |
|---|---|---|
| `black_coal` | `coal` | |
| `brown_coal` | `coal` | VIC 1차연료 |
| `gas_ccgt` | `gas` | |
| `gas_ocgt` | `gas` | |
| `gas_recip` | `gas` | |
| `gas_steam` | `gas` | |
| `gas_wcmg` | `gas` | Coal-mine waste gas — gas 통합 |
| `distillate` | `oil` | 디젤 피커 |
| `hydro` | `hydro` | |
| `pumps` | `storage` | Pumped hydro charging (load) — 음수 표기 |
| `wind` | `wind` | |
| `solar` | `solar` (utility scale) | rooftop은 별도 추가 |
| `bioenergy_biogas` | `biomass` | |
| `bioenergy_biomass` | `biomass` | |
| `biomass` | `biomass` | (legacy 표기) |
| `battery_charging` | `storage` (음수) | |
| `battery_discharging` | `storage` (양수) | |
| `nuclear` | `nuclear` | NEM에 없음 (호주 nuclear 발전 0) — 매핑만 두기 |
| (rooftop 별도) | `solar` (rooftop bucket) | ROOFTOP_PV/ACTUAL.POWER, region별 |

### 3.7 특이사항
- **Negative SCADAVALUE**: 배터리 충전·일부 발전기 self-consumption. Grid402는 storage는 부호 보존, 그 외 fuel은 `max(v, 0)`.
- **DUID 분리 charging/discharging**: 일부 신규 BESS는 단일 DUID (양·음수 모두), 일부 구형은 charge/discharge DUID 페어. Registry의 `battery_charging`/`battery_discharging` 표기 따름.
- **가격 단위 AUD**: Grid402 응답에서 `currency: "AUD"` + 옵션 `usd_equivalent` (FX는 daily ECB rate).
- **Negative prices**: NEM 가격 floor `-A$1,000/MWh`, cap `+A$17,500/MWh` (2025-26). 음수는 매우 흔함 (정오 호주). 본 조사 시점 (2026-04-25 13:30 NEM) SA1=−A$58.48, VIC1=−A$59.46 — 정상.
- **Interval timestamp 의미**: `SETTLEMENTDATE` = interval **종료**시각. `13:30:00` = 13:25~13:30 5분 dispatch 결과. CAISO와 같은 컨벤션.
- **NEM time has no DST** — `Australia/Sydney`, `Australia/Melbourne` 와 다름 주의. 변환 시 `Etc/GMT-10` 또는 직접 `+10:00` 부착.
- **Rooftop PV는 30분 lag**: `ROOFTOP_PV` 폴더의 가장 최근 파일은 통상 30~50분 전 interval. Grid402는 mix 응답에 `rooftop_solar_as_of` 별도 timestamp 노출.

## 4. Sample curl (실제 작동 — 2026-04-25 검증됨)

```bash
# Step 1: 디렉토리 listing → 가장 최근 .zip 파일명 추출
curl -sSL "https://nemweb.com.au/Reports/Current/Dispatch_SCADA/" \
  -o /tmp/scada_idx.html \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size ~122000

LATEST=$(grep -oE 'PUBLIC_DISPATCHSCADA_[0-9]+_[0-9]+\.zip' /tmp/scada_idx.html | tail -1)
echo "$LATEST"
# PUBLIC_DISPATCHSCADA_202604251325_0000000514674385.zip

# Step 2: 그 ZIP fetch + unzip
curl -sSL "https://nemweb.com.au/Reports/Current/Dispatch_SCADA/$LATEST" \
  -o /tmp/scada.zip \
  -w "HTTP %{http_code}  size %{size_download}  type %{content_type}\n"
# HTTP 200  size 4054 bytes  type application/x-zip-compressed
unzip -p /tmp/scada.zip | head -5
```
실제 응답 (오늘 검증):
```
C,NEMP.WORLD,DISPATCHSCADA,AEMO,PUBLIC,2026/04/25,13:20:18,0000000514674385,DISPATCHSCADA,0000000514674379
I,DISPATCH,UNIT_SCADA,1,SETTLEMENTDATE,DUID,SCADAVALUE,LASTCHANGED
D,DISPATCH,UNIT_SCADA,1,"2026/04/25 13:25:00",BARCSF1,15.20,"2026/04/25 13:20:17"
D,DISPATCH,UNIT_SCADA,1,"2026/04/25 13:25:00",BUTLERSG,6.60,"2026/04/25 13:20:17"
D,DISPATCH,UNIT_SCADA,1,"2026/04/25 13:25:00",BWTR1,0,"2026/04/25 13:20:17"
```

```bash
# Price (DispatchIS_Reports) — 같은 패턴
curl -sSL "https://nemweb.com.au/Reports/Current/DispatchIS_Reports/" -o /tmp/dis_idx.html
LATEST=$(grep -oE 'PUBLIC_DISPATCHIS_[0-9]+_[0-9]+\.zip' /tmp/dis_idx.html | tail -1)
curl -sSL "https://nemweb.com.au/Reports/Current/DispatchIS_Reports/$LATEST" -o /tmp/dis.zip \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 19562 bytes
unzip -p /tmp/dis.zip | grep "^D,DISPATCH,PRICE," | awk -F',' '{print $7,$10}'
```
실제 응답 (2026-04-25 13:30 NEM, AUD/MWh):
```
NSW1   2.15
QLD1   0.58374
SA1   -58.48425
TAS1   33.32551
VIC1  -59.46
```

## 5. 파서 구현
- **파일**: `api/src/aemo.ts` (예상)
- **주요 함수**:
  - `fetchAemoLatestScadaZipUrl()` → directory HTML scrape, 마지막 ZIP URL 반환
  - `fetchAemoLatestDispatchIsZipUrl()` → 동일 (DispatchIS 디렉토리)
  - `fetchAemoLatestRooftopZipUrl()` → 동일 (ROOFTOP_PV/ACTUAL)
  - `parseNemdfCsv(buffer)` → `{tables: Map<tableName, {headers, rows}>}` — `C/I/D` 다중 섹션 파서
  - `fetchAemoLivePrice(region)` → `AemoPriceTick { region, settlementDate, rrp, currency:"AUD" }`
  - `fetchAemoGenerationMix(region?)` → `AemoMixTick` — DUID×SCADA → fuel 합산 + ROOFTOP 합치기
  - `getAemoLivePriceCached(region)` · `getAemoMixCached(region)` (60s TTL)
  - `loadDuidFuelMap()` → `Map<DUID, FuelType>` — build-time JSON import (frozen)
- **예상 코드량**: ~350-450 lines (CAISO보다 길다 — directory scrape + 다중 ZIP + DUID 매핑)
- **의존성**:
  - `fflate` (ZIP 풀기) — CAISO와 동일
  - HTML 파싱: 디렉토리 listing은 단순 `<A HREF="...zip">` regex로 충분 (cheerio 불필요)
  - `fetch` 내장
  - `aemo-duid-fuel.json` (build-time fetch에서 freeze한 정적 매핑)

## 6. 라이선스 / 재배포
- **License**: AEMO 데이터는 **공공 정보** (Australia Open Government Data). NEMWEB 데이터는 명시적으로 free use 허용. 표준 attribution 권장.
- **공식 표기**: AEMO 웹사이트 Terms of Use에 따라 "Source: AEMO" attribution 권장 (강제 아님).
- **Attribution 필수**: 권장 (Grid402는 명시).
- **Redistributable**: **yes** (제약 없음, 단 데이터 무결성 변경 금지 — Grid402는 정규화만 하고 raw 보존).
- **OpenNEM facility registry**: GitHub `opennem/opennem` 저장소, **MIT License** — JSON 데이터 자유 사용 가능.
- **Citation**:
  ```json
  {
    "publisher": "Australian Energy Market Operator (AEMO) — NEMWEB",
    "license": "Public Australian Government Data (free use, attribution recommended)",
    "upstream": "nemweb.com.au/Reports/Current/Dispatch_SCADA + DispatchIS_Reports + ROOFTOP_PV/ACTUAL",
    "duid_fuel_map_source": "github.com/opennem/opennem facility_registry.json (MIT)"
  }
  ```

## 7. 품질 체크

### 7.1 Price 합리성
- 일반 범위: **−A$50 ~ +A$300/MWh**
- 극단 범위: **−A$1,000 ~ +A$17,500/MWh** (NEM regulated cap/floor 2025-26)
- 체크: 같은 region의 5분 전 값과 ±500% 벗어나면 warn (스파이크 흔함, 차단 X)
- **음수 정상**: 정오 SA1·VIC1 자주 음수, 양호 신호.

### 7.2 Generation Mix 완결성
- `sum(mw for fuel != imports,storage) ≈ region TOTALDEMAND ± net interconnector flow` (DispatchIS_Reports의 REGIONSUM 섹션과 ±5% 매치 시 통과)
- `solar` (utility) + `solar_rooftop` 합 vs UIGF (REGIONSUM의 `UIGF` = Unconstrained Intermittent Generation Forecast) — 실제 dispatch는 보통 UIGF의 95~100% 대역
- 각 fuel별 5분 변화 ±50% 벗어나면 warn (단 solar 새벽·해질녘 급변 정상)
- NEM에 nuclear 없음 → 항상 0 (검증)

### 7.3 샘플 검증 (오늘 데이터 기준 — 2026-04-25 13:30 NEM)
- 5 region 가격 모두 fetch 성공 ✓
- SCADA 510 lines, ~507 DUID rows ✓ (등록 587 중 dispatch 중인 것만)
- TOTALDEMAND: NSW1=4731 MW, QLD1=5334, VIC1=2661, SA1=516, TAS1=856 — 합 14 GW (NEM 정오 정상 부하)
- VIC1 RRP=−A$59.46 → 호주 주말 정오 negative pricing 합리 ✓

## 8. 기존 구현 참조
- **Electricity Maps `parsers/AEMO.py`** (4151 bytes, 127 lines): **operational demand forecast만** 다룸 (`Operational_Demand/FORECAST_HH/`). 실시간 mix/price는 OPENNEM.py 위임.
- **Electricity Maps `parsers/OPENNEM.py`** (22744 bytes, 665 lines): OpenElectricity **v4 API 패스** 사용 (`api.openelectricity.org.au/v4/...`, Bearer token 필요). NEMWEB 직접 패스 안 함.
  - **AGPL-3.0 주의**: 읽기만 OK, 코드 복붙 금지. 우리가 참조한 사실:
    - `ZONE_KEY_TO_REGION` mapping (AU-NSW→NSW1 등)
    - `OPENNEM_PRODUCTION_CATEGORIES` fuel grouping
    - `OPENNEM_STORAGE_CATEGORIES` 분류
    - `IGNORED_FUEL_TECH_KEYS = {imports, exports, interconnector, aggregator_vpp, aggregator_dr}`
    - 배터리 sign convention: discharging = (−1) 곱해서 storage 음수 처리 (Grid402는 반대 컨벤션 — discharge 양수, charge 음수 — 채택 필요)
- **Grid402 차별점**: NEMWEB **직접 fetch** (token 불필요, 의존 ZIP/CSV만), build-time DUID map freeze. OpenElectricity 비 의존 → free tier rate-limit 노출 없음.

## 9. 알려진 함정
- **NEM time ≠ Australia/Sydney**: NEM은 연중 AEST(UTC+10) 고정. Sydney/Melbourne은 AEDT (UTC+11) 적용 시기 있음 → 변환 시 `Sydney` zone 쓰면 11~3월 1시간 어긋남. **항상 `Etc/GMT-10` 또는 `+10:00` 부착**.
- **DUID coverage 갭**: OpenNEM registry는 ~587 DUID. NEMWEB SCADA에는 신규 BESS·VPP·소형 DUID이 더 등장 (오늘 510 row 중 일부 unmapped 가능). 미매핑 DUID 발견 시 → `other` 카테고리로 폴백 + WARN 로그 + 빌드 갱신 트리거.
- **rooftop PV는 SCADA에 없음**: 위성 30-min 추정치 별도 폴더. mix 합산 시 timestamp 정합성 주의 (rooftop 13:00 + scada 13:25 같은 미스매치 발생).
- **directory listing 변동**: `Current/` 디렉토리는 ~24-48시간 보관 후 archive로 이동. 매 5분 폴링 OK, 24시간 이상 lag 시 빈 응답 가능.
- **publication 지연**: 5분 interval 종료 후 ~3-5분 publication. `13:30:00` SETTLEMENTDATE 행은 13:33-13:35에 ZIP 등장. cache + retry 권장.
- **MARKETSUSPENDEDFLAG**: PRICE 행에서 시장 정지 시 `1` — 가격 신뢰도 의심. Grid402는 quality flag로 노출.
- **`INTERVENTION=1` rows**: 시장 직권조정 발생 시 추가 row. Grid402는 `INTERVENTION=0`만 사용.
- **directory HTML scrape의 fragility**: AEMO IIS 서버가 HTML 포맷 변경 시 regex 깨질 수 있음. 안전장치: 파일명 패턴 strict regex + 5min 신선도 체크.
- **CSRF / Rate limit**: 명시 없음. 폴링 cadence는 60s 미만 금지 (CAISO와 같이 정중하게).

## 10. 테스트
- **Smoke test**: `.context/grid402/scripts/smoke_aemo.sh` (작성 예정) — 디렉토리 fetch → 최신 ZIP → unzip → 5 region price 출력
- **Contract test**: `api/src/aemo.test.ts` (Vitest, mock 응답 4개):
  1. 정상 5-region price
  2. 정상 generation mix (DUID→fuel 합산 검증)
  3. 음수 가격 (SA1 RRP < 0)
  4. unknown DUID → `other` 폴백 + WARN
- **Live smoke**: 5회 연속 5분 간격 성공 (각 fetch < 2초)

---

## 11. Status (Done Definition)
- [x] Spec 섹션 1-10 채움
- [ ] Smoke test 스크립트 작성 (`scripts/smoke_aemo.sh`)
- [ ] TypeScript 파서 작성 (`api/src/aemo.ts`)
- [ ] Build-time DUID→fuel JSON freeze (`api/src/aemo-duid-fuel.json`)
- [ ] `pnpm tsc --noEmit` 통과
- [ ] Vitest 4-test suite 통과
- [ ] `/spot/AEMO/:region/live` 라우팅 + 5 region 응답 검증
- [ ] `/mix/AEMO/:region/live` 라우팅 + 5 region 응답 검증
- [ ] `/mix/AEMO/live` system-wide 응답
- [ ] `/emissions/AEMO/:region/live` gCO2/kWh 합리 범위 (coal-heavy QLD1·NSW1 ~700-800, hydro-heavy TAS1 ~50-100)
- [ ] `/combined/AEMO/:region/live` 통합 응답
- [ ] Attribution payload (AEMO + OpenNEM facility registry)
- [ ] Live smoke 5회 연속 통과

---

**Last updated**: 2026-04-25
**Investigator**: Grid402 팀
**관련 파일 (예정)**: `api/src/aemo.ts` · `api/src/aemo-duid-fuel.json` · `api/src/emission-factors.ts` · `api/src/types.ts` · `api/src/index.ts`
**Live 검증 시각**: 2026-04-25 13:30 NEM (UTC+10) — Dispatch_SCADA·DispatchIS_Reports·ROOFTOP_PV/ACTUAL 모두 HTTP 200 응답, 5 region 가격·발전량 정상 수신 확인.
