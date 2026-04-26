# ERCOT — Endpoint Spec

## 1. 기본 정보
| 항목 | 값 |
|---|---|
| ISO/TSO | Electric Reliability Council of Texas (ERCOT) |
| 관할 지역 | 미국 텍사스 주 (~90% 텍사스 부하, ~26 GW 평균 / ~85 GW 피크) |
| 시그널 | **Price (15-min RTM SPP, 8 hubs + 8 load zones)** + **Generation Mix (5-min, 8 fuels)** + Storage (5-min) + Load (hourly) |
| Upstream URL | ERCOT 공개 대시보드 JSON (`/api/1/services/read/dashboards/...json`) — Incapsula 차단 → **Cloud Run proxy 필수** |
| HTTP 메서드 | GET |
| 응답 포맷 | **JSON** (gzip 가능) |
| 업데이트 주기 | **5분** (mix·storage) / **15분** (RT SPP hub·zone) / **60분** (system load) |
| 가용 zone | **거래 hub 7개**: `hbBusAvg`, `hbHubAvg`, `hbHouston`, `hbNorth`, `hbPan`, `hbSouth`, `hbWest` · **Load zone 8개**: `lzAen`, `lzCps`, `lzHouston`, `lzLcra`, `lzNorth`, `lzRaybn`, `lzSouth`, `lzWest`. Mix는 system-wide만 (per-SP fuel breakdown 없음). |
| 시간대 | **Central Prevailing Time (CPT = CST/CDT)** — JSON에 `-0500`/`-0600` 명시. DST 자동 적용됨 |
| Grid402 엔드포인트 | `/spot/ERCOT/:zone/live` · `/mix/ERCOT/live` · `/emissions/ERCOT/live` · `/combined/ERCOT/:zone/live` |

> **Sub-hourly mix bar**: ERCOT 통과. fuel-mix.json은 **진짜 5분 시스템-와이드 fuel breakdown** 8개 연료 (CAISO와 동급). 단 storage 별도, gas는 CC/CT 미분리.

## 2. 인증

ERCOT은 두 트랙이 있음 — Grid402은 **Track A (대시보드 + Public Proxy)** 를 메인으로, Track B는 향후 옵션.

### 2.1 Track A — Public Dashboard JSON (현재 메인)
- **방식**: 무인증
- **블로커**: 직접 호출은 Imperva/Incapsula bot wall (HTTP 403 + iframe `_Incapsula_Resource`) — 모든 일반 UA 차단
- **우회**: Electricity Maps 가 운영하는 Google Cloud Run 프록시 사용
  - `https://us-ca-proxy-jfnx5klx2a-uw.a.run.app/api/1/services/read/dashboards/<dashboard>.json?host=https://www.ercot.com`
  - **주의**: 외부 무료 프록시 의존 → Grid402 자체 Cloud Run/Workers 프록시로 대체 권장 (해커톤 데모 단계에선 EM proxy 사용 OK, 프로덕션은 자체 프록시 필수)
- **토큰 저장**: 불필요
- **예상 발급 소요**: 0 (즉시)

### 2.2 Track B — ERCOT Public Data API (향후 정식 LMP용)
- **방식**: **Azure AD B2C ROPC OAuth + Subscription Key (이중 헤더)**
- **발급 경로**:
  1. `https://apiexplorer.ercot.com/` 회원 가입 (이메일 인증)
  2. Products 페이지에서 "Public API" 구독 → Subscription Key 복사
  3. ID Token 획득 (1시간 유효):
     ```
     POST https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token
     ?username=<email>&password=<pw>&grant_type=password
     &scope=openid+fec253ea-0d06-4272-a5e6-b478baeecd70+offline_access
     &client_id=fec253ea-0d06-4272-a5e6-b478baeecd70&response_type=id_token
     ```
  4. 모든 호출에 `Authorization: Bearer <id_token>` + `Ocp-Apim-Subscription-Key: <key>` 헤더
- **토큰 저장**:
  - `.env`: `ERCOT_API_USERNAME`, `ERCOT_API_PASSWORD`, `ERCOT_API_SUBSCRIPTION_KEY`
  - macOS Keychain service 권장: `ercot-api-pubdata` (id_token은 캐시·1h refresh)
- **예상 발급 소요**: ~10분 (가입 즉시 사용 가능, 이메일 인증 수 분)
- **주요 Report 엔드포인트** (`https://api.ercot.com/api/public-reports/<emil>/<artifact>`):
  - `np6-788-cd/lmp_node_zone_hub` — **5-min RT SCED LMP 전체 노드+zone+hub** (이게 진짜 5-min price)
  - `np4-190-cd/dam_stlmnt_pnt_prices` — Day-Ahead SPP
  - `np6-905-cd/spp_node_zone_hub` — RTM SPP 15-min historical archive
  - `np4-732-cd/wpp_actual_5min_avg_values` — 5-min Wind Power Production (actual)
  - `np4-737-cd/spp_actual_5min_avg_values` — 5-min Solar Power Production (actual)

> P0 단계는 Track A로 충분. Track B는 Hub-level 외에 **개별 노드 가격이 필요할 때** 활성화.

## 3. 데이터 스키마

### 3.1 원본 필드 — `fuel-mix.json` (Generation Mix, 5-min)

```json
{
  "lastUpdated": "2026-04-24 22:21:00-0500",
  "monthlyCapacity": {"Coal and Lignite":13705,"Hydro":579,"Natural Gas":68388,
                      "Nuclear":5268,"Other":647,"Power Storage":17934,
                      "Solar":37967,"Wind":40534},
  "types": ["Coal and Lignite","Hydro","Natural Gas","Nuclear","Other",
            "Power Storage","Solar","Wind"],
  "data": {
    "2026-04-24": {
      "2026-04-24 22:19:57-0500": {
        "Coal and Lignite":{"gen":7300.85},
        "Hydro":{"gen":191.90},
        "Nuclear":{"gen":4711.88},
        "Other":{"gen":0},
        "Power Storage":{"gen":1186.86},
        "Solar":{"gen":0.29},
        "Wind":{"gen":9370.08},
        "Natural Gas":{"gen":32397.67}
      }, ...
    }
  }
}
```

- **interval 끝 시각**: `HH:MM:57` 형태 (예: `00:04:57` = 0분 ~ 5분 average, 끝 5초 마진).
- 각 fuel 값은 **현재 5분 평균 발전량(MW)**.
- **Power Storage**: 양수 = 방전(discharge), 음수 = 충전(charge) — 전체 그리드 배터리 net output.
- 268~288 intervals/day (자정~현재 라이브, ~2분 lag).
- 32 GW 가스, 9 GW 풍, 4.7 GW 원전 등 시스템 합계 ~55 GW 야간 정상.

### 3.2 원본 필드 — `systemWidePrices.json` (RT Hub/Zone SPP, 15-min)

```json
{
  "lastUpdated":"2026-04-24 22:17:00-0500",
  "rtSppData":[
    {
      "intervalEnding":"22:15", "dstFlag":"N",
      "hbBusAvg":215.27, "hbHubAvg":259.03,
      "hbHouston":170.44, "hbNorth":142.73, "hbPan":-4.06,
      "hbSouth":317.01, "hbWest":405.94,
      "lzAen":283.18, "lzCps":344.0, "lzHouston":173.57,
      "lzLcra":301.7, "lzNorth":139.77, "lzRaybn":131.39,
      "lzSouth":382.67, "lzWest":809.79,
      "timestamp":"2026-04-24 22:15:00-0500", "interval":1777086900000
    }, ...
  ]
}
```

- **단위**: USD/MWh
- **delta**: 정확히 900초 (15분) — interval ending 시각 (e.g. "22:15" = 22:00~22:15 결제구간)
- 89 rows 자정 이후 누적 (22h × 4)
- 네이밍 매핑: `hbNorth` = ERCOT settlement point `HB_NORTH`, `hbHouston` = `HB_HOUSTON`, ... `hbHubAvg` = 4개 거래 hub 평균.

### 3.3 원본 필드 — `energy-storage-resources.json` (Battery, 5-min)

```json
{"timestamp":"2026-04-24 22:25:00-0500",
 "totalCharging":-398.83, "totalDischarging":1478.59, "netOutput":1079.75}
```
- 270 intervals/day (5분).
- **netOutput**: 양수 = 시스템 net 방전, 음수 = net 충전.
- fuel-mix.json의 "Power Storage"와 거의 같은 값 (몇 분 차이로 약간 다름) — Grid402은 **fuel-mix만 사용** 하면 됨 (storage 별도 호출 불필요).

### 3.4 원본 필드 — `loadForecastVsActual.json` (Hourly Load)

```json
{"hourEnding":24,"systemLoad":52191.48,"currentLoadForecast":52191.48,
 "dayAheadForecast":54283.34,"timestamp":"2026-04-25 00:00:00-0500"}
```
- 24 rows/day (시간별).
- `systemLoad` = 실측 부하 (MW), `currentLoadForecast` = 발행시점 모델 예측, `dayAheadForecast` = D-1 예측.

### 3.5 원본 → Grid402 canonical 매핑

**Price** (`systemWidePrices.json`):

```ts
const ERCOT_HUB_FIELD_MAP = {
  "HB_NORTH":   "hbNorth",
  "HB_HOUSTON": "hbHouston",
  "HB_SOUTH":   "hbSouth",
  "HB_WEST":    "hbWest",
  "HB_PAN":     "hbPan",
  "HB_BUSAVG":  "hbBusAvg",
  "HB_HUBAVG":  "hbHubAvg",
  "LZ_NORTH":   "lzNorth",
  "LZ_HOUSTON": "lzHouston",
  "LZ_SOUTH":   "lzSouth",
  "LZ_WEST":    "lzWest",
  "LZ_AEN":     "lzAen",
  "LZ_CPS":     "lzCps",
  "LZ_LCRA":    "lzLcra",
  "LZ_RAYBN":   "lzRaybn",
};
// rtSppData[i][hub_field] → lmp_usd_per_mwh
// timestamp + intervalEnding → ISO UTC (CDT/CST 변환)
```

**Generation Mix** — `api/src/ercot.ts`의 `ERCOT_FUEL_MAP`:

| 원본 컬럼 | Canonical `FuelType` | 비고 |
|---|---|---|
| `Coal and Lignite` | `coal` | Lignite (텍사스 갈탄) 포함 |
| `Natural Gas` | `gas` | CC + CT + ST 합산 — sub-type 분리 없음 |
| `Nuclear` | `nuclear` | Comanche Peak + South Texas Project (~5 GW 평탄) |
| `Wind` | `wind` | West/South/Coastal/Panhandle 합산 — 텍사스 #1 풍력주 |
| `Solar` | `solar` | 야간 음수 가능 (self-consumption) → `max(v,0)` |
| `Hydro` | `hydro` | LCRA 댐류, 매우 적음 (<600 MW) |
| `Power Storage` | `storage` | 양수=discharge, 음수=charge (CAISO Batteries와 동일 부호) |
| `Other` | `other` | Biomass·Diesel·Petcoke·Black liquor 모두 여기 (개별 분리 없음) |

**참고**: ERCOT은 **biomass를 별도 컬럼으로 노출하지 않음** (Other에 묶음) — CAISO와 차이. 따라서 emission factor 계산시 `other` 카테고리에 평균 fossil-ish 값 적용 필요 (현재 `emission-factors.ts` 가 처리 가정).

### 3.6 특이사항

- **Solar 음수**: 야간 self-consumption → `max(v, 0)` 처리 (CAISO와 동일 패턴)
- **Power Storage 음수**: 충전 정상 — `storage` 카테고리 그대로 부호 보존
- **Hydro = 0** 인 5분 구간 흔함 (totally idle) — null 아님, 정상 0
- **단위**: 모두 MW (MWh 아님). 1×60/12 = 5분 적분 시 MWh.
- **`-0500` vs `-0600`**: CDT (DST 적용시) vs CST. ERCOT JSON은 `dstFlag` 필드 + 명시적 offset 동시 제공 → 파서는 offset만 파싱하면 안전.

## 4. Sample curl (실제 작동, 2026-04-24 22:20 CDT 기준)

```bash
PROXY="https://us-ca-proxy-jfnx5klx2a-uw.a.run.app"
HOST="host=https://www.ercot.com"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124'

# 1) Generation Mix (5-min, 8 fuels)
curl -sSL -A "$UA" "${PROXY}/api/1/services/read/dashboards/fuel-mix.json?${HOST}" \
  -o /tmp/ercot_fuel.json \
  -w "HTTP %{http_code}  size %{size_download}  type %{content_type}\n"
# HTTP 200  size 166415  type text/plain; charset=utf-8

# 2) RT Hub/Zone SPP (15-min)
curl -sSL -A "$UA" "${PROXY}/api/1/services/read/dashboards/systemWidePrices.json?${HOST}" \
  -o /tmp/ercot_swp.json \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 38575

# 3) System load (hourly)
curl -sSL -A "$UA" "${PROXY}/api/1/services/read/dashboards/loadForecastVsActual.json?${HOST}" \
  -o /tmp/ercot_load.json \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 15079

# 4) Grid frequency / DC ties (10s — overkill, optional)
curl -sSL -A "$UA" "${PROXY}/api/1/services/read/dashboards/rtsyscond.json?${HOST}" \
  -o /tmp/ercot_freq.json \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 1551588   (10초 해상도 너무 크니 cache 60s 권장 — 사용 우선순위 낮음)
```

**HEAD 5 lines fuel-mix.json (실측):**
```
{"lastUpdated":"2026-04-24 22:21:00-0500",
 "monthlyCapacity":{"Coal and Lignite":13705,"Hydro":579,"Natural Gas":68388,
                    "Nuclear":5268,"Other":647,"Power Storage":17934,
                    "Solar":37967,"Wind":40534},
 ...}
```

## 5. 파서 구현
- **파일**: `api/src/ercot.ts` (CAISO 패턴과 동일 구조)
- **주요 함수**:
  - `fetchErcotLivePrice(zone)` → `ErcotPriceTick` — `systemWidePrices.json` 호출, 매핑 룩업, 최신 row 추출
  - `fetchErcotGenerationMix()` → `ErcotMixTick` — `fuel-mix.json` 호출, 가장 최근 5-min interval 추출, 8 fuel → canonical 매핑
  - `getErcotLivePriceCached(zone)` · `getErcotMixCached()` — 60s TTL
  - `parseErcotTimestamp(s)` — `"2026-04-24 22:19:57-0500"` → `Date` (Date.parse 직접 처리 가능, ISO 포맷 호환)
- **예상 코드량**: 약 **170~210줄** (CAISO 237줄보다 짧음 — JSON only, ZIP 풀기 없음, 구조도 단순)
- **의존성**: 없음 (`fetch` 내장, JSON 파싱만)
- **프록시 설정**: `ERCOT_PROXY_BASE` env 변수 (default: EM proxy URL, prod에선 자체 Cloud Run/Workers)

## 6. 라이선스 / 재배포
- **License**: **US public domain** (ERCOT은 텍사스 PUC 규제 비영리 ISO; 공시 데이터는 공개 재배포 허용 — `ercot.com/help/terms/data-portal`)
- **Attribution 필수**: no (공개 데이터지만 Grid402은 명시)
- **Redistributable**: **yes**
- **Citation**:
  ```json
  {
    "publisher": "Electric Reliability Council of Texas (ERCOT) Public Dashboards",
    "license": "US public domain (Texas open data)",
    "upstream": "ercot.com/api/1/services/read/dashboards (via proxy)"
  }
  ```

## 7. 품질 체크

### 7.1 Price 합리성
- **일반 범위**: $15 - $250/MWh (오늘 실측 hbHubAvg 평균 $103, min $12)
- **극단 범위**: **-$251 ~ +$5000/MWh** (ORDC scarcity cap; Uri 2021 Feb $9000 (구 cap) 도달했던 famous incident)
- 오늘 22:15 hbWest = **$809/MWh** 관찰 — 저녁 ramp 정상
- 음수 가격 정상 (West/Pan은 풍력 잉여 시 자주 음수)
- 체크: 같은 hub의 15분 전 ±500% 벗어나면 warn (스파이크 흔하므로 ±300%는 너무 strict)

### 7.2 Mix 완결성
- `sum(fuel for fuel != storage) ≈ system_load + losses` (±5%)
  - 오늘 22:20 sample: 7301 (coal) + 192 (hydro) + 4712 (nuc) + 0 (other) + 0.3 (solar, 야간) + 9370 (wind) + 32398 (gas) = **53,973 MW** (storage +1187 추가하면 55,160 MW)
  - System load (시간별) ~50,672 MW @ 22:00 → 약간 deficit이나 net export(DC ties)/오차 범위 OK
- **Power Storage 단독**: monthlyCapacity 17,934 MW → 절댓값 < 10 GW 정상
- **Wind 변동**: 5분 ±20% 흔함 (front passage시) — warn 임계 ±50%로
- **Nuclear**: 4.5~5.0 GW 거의 평탄, ±200 MW 이상 변하면 의심

### 7.3 샘플 검증 (오늘 22:20 CDT)
- Total generation (storage 제외): 53,973 MW
- Wind share: 17.4%, Solar: 0% (야간), Gas: 60.0%, Coal: 13.5%, Nuclear: 8.7%
- Renewable %: ~17.7% (야간 — solar 깨면 낮시간 50%+ 일반)
- Carbon-free %: ~26.4% (야간)
- 예상 `gco2_per_kwh` ≈ ~430 (야간, gas 우세). 낮 솔라+윈드 피크 시 ~150-200.

### 7.4 Fallback
- proxy 5xx → last-known-good (최대 15분 유예) 반환
- ERCOT dashboard 자체 다운 (드물지만 있음) → cache 30분까지 stale OK

## 8. 기존 구현 참조
- **Electricity Maps parser**: `electricitymap/contrib/parsers/US_ERCOT.py` (~750 lines incl. forecast/historical/exchange)
  - **AGPL-3.0**: 사실(URL, JSON 키, 매핑)만 참조, 코드 복사 ✗
  - **참조한 사실**:
    - `US_PROXY = "https://us-ca-proxy-jfnx5klx2a-uw.a.run.app"`
    - 4 dashboard 엔드포인트 path (`fuel-mix.json`, `systemWidePrices.json`, `loadForecastVsActual.json`, `rtsyscond.json`, `energy-storage-resources.json`)
    - `GENERATION_MAPPING` (Coal and Lignite → coal, etc.)
    - EMIL Report ID: NP6-788-CD (RT LMP), NP4-190-CD (DA LMP), NP4-732-CD (Wind 5min), NP4-737-CD (Solar 5min), NP3-560-CD (Load forecast)
    - Azure B2C OAuth ROPC 흐름 (client_id `fec253ea-0d06-4272-a5e6-b478baeecd70`)
- **우리 구현**: 독립 작성 (`api/src/ercot.ts`, TypeScript), Python 코드 미공유

## 9. 알려진 함정

- **Incapsula 봇 차단** : 직접 `www.ercot.com` 호출 시 모든 일반 UA 403. **반드시 프록시** 필요 (EM proxy 또는 자체 Cloud Run/Workers proxy)
- **Texas DST**: 2nd Sunday Mar (CDT 시작) ~ 1st Sunday Nov (CST 복귀). JSON `timestamp` 필드의 offset이 자동 변경 → 파서는 offset만 신뢰, naive parse 금지
- **Uri 2021 (역사적)**: 2021-02-15 ~ 02-19 Real-time energy clearing $9,000/MWh cap 도달 + ERCOT $16B over-billing 분쟁. 현재 cap **$5,000/MWh** (2023년 PUC 인하). 음수 측은 -$251 (Operating Reserve Demand Curve).
- **5-min RTSPP lag**: SCED 결제 가격 발행 ~5분 지연 (즉, "22:15 interval ending" 가격은 22:20+ 에 publish). fuel-mix 도 비슷 (~2분 lag).
- **System-wide mix only**: per-settlement-point fuel breakdown 없음. 노드별 emission factor 정밀화 불가 (system-wide gco2/kWh만).
- **Gas sub-type 미분리**: CC vs CT vs ST 합산. emission factor는 ERCOT gas fleet 평균(~400 g/kWh) 사용.
- **Other 카테고리**: Biomass + Diesel + Coke + Misc 묶음. ~600 MW capacity, 실측 거의 0. emission factor `other` 카테고리 활용.
- **Power Storage 부호**: 양수=방전(generation), 음수=충전(consumption). CAISO Batteries와 동일 — Grid402 `storage` 그대로 부호 보존.
- **Panhandle (`hbPan`)** 음수 가격 빈번: 풍력 60% 점유 + 송전 제약 → 잉여시 음수 가격. 정상.
- **`hbHubAvg`**: 4 거래 hub (North/Houston/South/West) 단순 평균 — 별도 settlement point 아님 (정보용).
- **Public API ID Token 1h 만료**: refresh token 사용 가능, 코드는 token 캐시 + 만료 5분 전 refresh 권장.

## 10. 테스트
- **Smoke test**: `.context/grid402/scripts/smoke_ercot.sh` (작성 예정 — 4 dashboard endpoint 200 + 응답 schema 키 존재 확인)
- **Contract test**: `api/src/ercot.test.ts` (작성 예정) — Vitest, mock 4개 케이스:
  1. 정상 5-min mix (낮 — solar 양수)
  2. 야간 mix (solar 0/음수, storage 충전중)
  3. Hub 가격 정상 + Pan 음수
  4. ORDC scarcity 시나리오 (hbWest > $1000)
- **Live smoke**: 5분 간격 5회 — 실측 시각 진행, fuel-mix/systemWidePrices 둘다 응답 일관성 (proxy 안정성 검증)

---

## 11. Status (Done Definition)
- [x] Spec 섹션 1-10 채움
- [ ] Smoke test 스크립트 작성 (`scripts/smoke_ercot.sh`)
- [ ] TypeScript 파서 작성 (`api/src/ercot.ts` ~180 lines)
- [ ] `pnpm tsc --noEmit` 통과
- [ ] Vitest 테스트 4개 이상 통과
- [ ] `/spot/ERCOT/:zone/live` 로컬 응답 확인
- [ ] `/mix/ERCOT/live` 로컬 응답 확인
- [ ] `/emissions/ERCOT/live` gCO2/kWh 합리 범위 (낮 ~150 / 야간 ~430)
- [ ] `/combined/ERCOT/:zone/live` 통합 응답 확인
- [ ] Attribution payload에 명시 (`ercotDashboardSource`, `ercotProxySource`)
- [ ] 자체 프록시 (Cloudflare Workers 또는 Cloud Run) 셋업 → EM proxy 의존 제거 (post-hackathon)

---

**Last updated**: 2026-04-25
**Investigator**: Grid402 팀
**관련 파일**: `api/src/ercot.ts` (작성 예정) · `api/src/emission-factors.ts` · `api/src/types.ts` · `api/src/index.ts`
**Live verified**: 2026-04-24 22:20 CDT — 4 dashboard endpoints HTTP 200 via EM proxy
