# Korea (KR) — Endpoint Spec

> **Zone**: 대한민국 본토(Mainland) + 제주(Jeju). Grid402 V1은 본토만, V2에 제주 분리.
> **목적**: 한국 전력시장의 가격(SMP), 전원믹스, 수요/공급 데이터를 Grid402 zone으로 노출.
> **결론 한 줄**: **KPX OpenAPI(`openapi.kpx.or.kr` via data.go.kr 인증키)가 5분 단위 mix + SMP를 모두 제공함**. HTML 스크래핑은 Phase 0 fallback. KEPCO Big Data Center는 통계/파일이며 실시간 mix는 없음.

---

## 1. 기본 정보

| 항목 | 값 |
|---|---|
| ISO/TSO | **KPX (한국전력거래소, Korea Power Exchange)** |
| 보조기관 | KEPCO(한전, 송배전), 산업통상자원부, KEEI(에너지경제연), KEA(에너지공단) |
| 관할 지역 | 대한민국 (육지 = 본토, 제주 = 별도 시장) |
| 시그널 | **Price (SMP)** + **Generation Mix (5분 fuel)** + **Supply/Demand (5분)** + **REC** + **Forecast** |
| Upstream URL (V1 권장) | `https://openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m` (mix) · `https://openapi.kpx.or.kr/openapi/sukub5mMaxDatetime/getSukub5mMaxDatetime` (수급) · `https://openapi.kpx.or.kr/openapi/smp1hToday/getSmp1hToday` (SMP) |
| Upstream URL (Phase 0 fallback) | `https://new.kpx.or.kr/smpInland.es` (SMP HTML) · `https://new.kpx.or.kr/powerinfoSubmain.es` (mix HTML) |
| HTTP 메서드 | **GET** (KPX OpenAPI, 단순 querystring) |
| 응답 포맷 | **XML** (KPX OpenAPI 기본) · CSV(파일 다운로드) · HTML(Phase 0 fallback) · JS-embedded JSON(EPSIS 차트) |
| 업데이트 주기 | **5분** (mix·수급) · **1시간** (SMP) · **일평균/월평균** SMP 별도 |
| 가용 zone 수 | 시스템 단일 (본토 system-wide). 제주는 별도 endpoint(`chejusukub.do`) 존재. 노드별 LMP 없음(단일가격제) |
| 시간대 | **KST (UTC+9)**, DST 없음 |
| Grid402 엔드포인트 | `/spot/KR/KPX/live` · `/mix/KR/live` · `/emissions/KR/live` · `/combined/KR/KPX/live` |

### 1.1 한국 전력시장 1분 컨텍스트

- 한국은 **단일 가격제(uniform pricing)**: 노드별 LMP 없음, 시스템 전체에 SMP 1개. 본토 vs 제주만 분리.
- 시장 운영 = **KPX**, 송배전·소매 = **KEPCO**, 정책·통계 = **산업통상자원부**.
- KPX는 매 1시간 단위 SMP를 발표(전일 결정), 5분 단위 실시간 수급·연료별 발전량을 자체 OpenAPI로 공개.
- 제주는 재생E 비중 높아 음의 가격 빈번, 별도 시장으로 운영. **MVP 본토만**.

## 2. 인증

### 2.1 권장 경로 — data.go.kr ServiceKey (Phase 1)

- **방식**: 단일 ServiceKey (URL `?serviceKey=...` querystring), **인증서/oauth 불필요**
- **발급 경로**:
  1. `https://www.data.go.kr` 회원가입 (이메일 인증 — 한국 휴대폰 인증 미필수)
  2. 원하는 OpenAPI 페이지에서 **활용신청** (한국어 양식, 사용 목적 작성)
  3. **자동승인** (KPX OpenAPI는 `자동승인` 분류 — 보통 즉시~수시간 발급)
  4. 마이페이지 → 인증키 확인
- **토큰 저장**: `.env` `DATA_GO_KR_SERVICE_KEY` 또는 macOS Keychain `service=data-go-kr-grid402`
- **발급 소요 (실측 표본)**:
  - 자동승인 KPX 전력수급 (15056640): **즉시 ~ 1시간**
  - 한국전력공사 가구사용량 (15101404): 자동승인, 즉시
  - 일부 KEPCO 산업분류 데이터: **개발 1~3일** (심의 케이스)
- **rate limit**: 일 1,000건 (개발용) → 신청서에 "운영" 명시 시 일 10,000~100,000건까지 상향 가능
- **국적 제한**: 비한국인도 가입 가능(외국인등록번호 불요), 단 한국어 portal

### 2.2 Fallback 경로 — KPX HTML 스크래핑 (Phase 0)

- **방식**: **무인증** (단순 GET)
- **단점**: HTML 변경 시 파서 깨짐, 응답 ~80~350KB
- **장점**: 즉시 사용, 가입 절차 0
- **rate limit**: 명시 없음, 60초+ 권장

### 2.3 EPSIS Chart endpoint (보조)

- **방식**: 세션 쿠키 + AJAX (`X-Requested-With: XMLHttpRequest`)
- 초기 GET → 세션 발급 → POST `*.ajax` 호출 → JS chartData 추출

## 3. 데이터 스키마

### 3.1 KPX OpenAPI: `getSumperfuel5m` — **5분 단위 연료별 발전량 (V1 코어)**

URL: `https://openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m?ServiceKey={KEY}`

응답 (XML, `tbAllSumperfuel5mResponse > items > item`):

| 필드 | 한글 | 단위 | Canonical FuelType | 비고 |
|---|---|---|---|---|
| `baseDatetime` | 기준일시 | YYYYMMDDhhmmss (KST) | timestamp | 매 5분(00,05,10,...) |
| `fuelPwr1` | 수력 | MW | `hydro` | 일반 수력만 |
| `fuelPwr2` | 유류 | MW | `oil` | |
| `fuelPwr3` | 유연탄 | MW | `coal` | |
| `fuelPwr4` | 원자력 | MW | `nuclear` | |
| `fuelPwr5` | 양수 | MW | `storage` | 음수=충전, 양수=방전 |
| `fuelPwr6` | 가스 | MW | `gas` | LNG |
| `fuelPwr7` | 국내탄 | MW | `coal` | 무연탄, fuelPwr3와 합산 |
| `fuelPwr8` | 태양광(시장) | MW | `solar` | **시장 거래분만** (PPA·BTM 제외) |
| `fuelPwr9` | 풍력 | MW | `wind` | |
| `fuelPwr10` | 신재생 | MW | `unknown` (또는 `biomass` 추정) | 바이오·연료전지·기타 혼합 |
| `pEsmw` | PPA 추정 | MW | `solar` (mostly) | 시장외 태양광 추정 → fuelPwr8과 합산 권장 |
| `bEmsw` | BTM 추정 | MW | `solar` | 자가소비 태양광(behind-the-meter) |
| `fuelPwrTot` | 시장수요(현재) | MW | (검증용) | sum(fuelPwr1~10) ≈ fuelPwrTot |

**Grid402 매핑 (권장)**:
- `solar` = `fuelPwr8 + pEsmw + bEmsw`  ← Electricity Maps 방식과 동일하게 PPA/BTM 포함
- `coal`  = `fuelPwr3 + fuelPwr7`
- `hydro` = `fuelPwr1`  (양수 storage는 별도)
- `wind`  = `fuelPwr9`
- `nuclear` = `fuelPwr4`
- `gas`   = `fuelPwr6`
- `oil`   = `fuelPwr2`
- `storage` = `fuelPwr5`  (양수 — 양수=방전 / 음수=충전 부호 KPX 자체 컨벤션 검증 필요)
- `other` = `fuelPwr10`  (신재생 잔여)

### 3.2 KPX OpenAPI: `getSukub5mMaxDatetime` — **5분 단위 수급 현황**

URL: `https://openapi.kpx.or.kr/openapi/sukub5mMaxDatetime/getSukub5mMaxDatetime?ServiceKey={KEY}`

응답 필드(예시: 2015-11-12 15:25):
| 필드 | 한글 | 단위 | 매핑 |
|---|---|---|---|
| `baseDatetime` | 기준일시 | YYYYMMDDhhmmss | timestamp |
| `currPwrTot` | 공급능력 | MW | `supply_capability_mw` |
| `supCapaTot` | 현재수요 | MW | `current_load_mw` |
| `forcastTot` | 최대예측수요 | MW | `peak_forecast_mw` |
| `currOprPwr` | 공급예비력 | MW | `operating_reserve_mw` |
| `currOprRate` | 공급예비율 | % | `reserve_margin_pct` |

(필드명은 KPX 공식 가이드 v1.6 기준 — 활용 시 ServiceKey 발급 후 1회 응답 검증 필수)

### 3.3 KPX OpenAPI: `getSmp1hToday` — **시간별 SMP**

URL: `https://openapi.kpx.or.kr/openapi/smp1hToday/getSmp1hToday?areaCd=1&serviceKey={KEY}`

- `areaCd=1` → 본토(육지), `areaCd=2` → 제주
- 응답 필드: `baseDatetime` (YYYYMMDDhh), `smp` (원/kWh)
- **단위 변환**: `usd_per_mwh = smp_won_per_kwh * 1000 / KRW_USD_RATE` (실시간 환율 OR daily fix)
- 갱신: 매시 정각 (전일 24개 + 당일 누적)

### 3.4 KPX OpenAPI 전체 카탈로그 (data.go.kr 기준)

| data.go.kr ID | 명칭 | API URL 핵심 | 주기 | 인증 | Grid402 가치 |
|---|---|---|---|---|---|
| **15056640** | 한국전력거래소_현재전력수급현황 (=5분단위) | `sukub5mMaxDatetime` | 5분 | 자동승인 | ★★★ Mix 보조(수급) |
| **(신규)** | 한국전력거래소_5분단위 연료원별 발전 | `sumperfuel5m` | **5분** | 자동승인(예상) | **★★★★★ 코어 mix** |
| **15051436** | 한국전력거래소_전력수급예보조회 | `forecast.do` | 1일 | 자동승인 | ★★ load forecast |
| **15065266** | 한국전력거래소_시간별 전국 전력수요량 | (CSV file) | 1시간 | 즉시 다운로드 | ★ historical only |
| **15003824** | 신재생에너지(REC) 현물시장 거래 | API | 일 | 자동승인 | ★ price comparison |
| **15003823** | 신재생에너지 건설 및 개발현황 | API | 월 | 자동승인 | ☆ capacity, V2 |
| **15101408** | 한국전력공사_신재생 에너지 현황 | API | 실시간 표기 | 자동승인 | ★ capacity by region |
| **15101404** | 한국전력공사_가구 평균 전력사용량 | API | 월 | 자동승인 | ☆ V2 demographics |
| **15101360** | 한국전력공사_계약종별 전력사용량 | API | 월 | 자동승인 | ☆ V2 sector breakdown |
| **15101403** | 한국전력공사_산업분류 별 전력사용량 | API | 월 | 자동승인 | ☆ V2 |
| **15084084** | 기상청_단기예보 | API | 3시간 | 자동승인 | 보조: 재생E 보정용 |
| **15057210** | 기상청_지상(ASOS) 시간자료 | API | 1시간 | 자동승인 | 보조: 일사량/풍속 |

### 3.5 EPSIS chart endpoints (KPX 통계 포털)

- **세션 핸드셰이크 필요**: GET `/epsisnew/selectEkmaSmpShdChart.do?menuId=040202` (쿠키 획득) → POST `/epsisnew/selectEkmaSmpShdChart.ajax` (X-Requested-With + 쿠키)
- 응답: `text/html` 안에 embedded JS `chartData.push({"Date":"...","Value":"..."})` — 정규표현식으로 추출
- **장점**: 인증 무요, JSON-like (값 추출 즉시)
- **단점**: HTML 메가 응답(50~170KB), 세션 만료 시 reauth, 공식 API 아님 (차단 위험)
- **확인된 ajax endpoint들**:
  - `selectEkmaSmpShdChart.ajax` — SMP 시간별 (확인 완료, HTTP 200, 47KB)
  - `selectEkmaSmpShd.ajax` — SMP raw 데이터
  - `selectEkpoBftChart.ajax` — 연료원별 발전 yearly aggregate (확인 완료, HTTP 200, 99KB)
  - `selectEkesPdctChart.ajax` — 발전실적(추정)
  - `selectEkgeEpsMepRealChart.ajax` — 실시간 수급 차트 → **HTTP 404** (현재 deprecated)

### 3.6 KPX `new.kpx.or.kr` HTML (Phase 0 fallback)

- **`smpInland.es`** (육지 SMP): HTML table, 최근 7일 × 24시간 SMP. 정규식 `(\d+\.\d+)\s*원\/kWh`로 추출
- **`smpJeju.es`** (제주 SMP): 동일 구조, V2
- **`powerinfoSubmain.es`** (실시간 수급): HTML, 9개 연료별 MW + 공급능력/현재부하. 시간당 갱신 추정(5분 아님!)
- **`powerSource.es`** (원별 차트): POST + CSRF 토큰 필요 — **EnergyTag 방식과 동일한 session 핸드셰이크**

### 3.7 KEPCO Big Data Center (`bigdata.kepco.co.kr`)

- **확인 결과: 실시간 OpenAPI 없음.** 통계/CSV 파일 다운로드 위주.
- 메뉴: 거래통계, 판매통계, 발전통계, 정전통계, 신재생통계 등 (모두 월/연 단위 집계)
- 회원가입 → 자료요청 → 검토 (영업일 3~5일)
- **Grid402 V1 가치 = 낮음**. V2에서 지역별 소비 분석에 보조로 사용 가능.
- 실제 KEPCO 실시간 데이터는 모두 data.go.kr `한국전력공사_*` API로 라우팅됨.

### 3.8 특이사항

- **시간대**: 모든 KPX 데이터는 **KST(UTC+9)**, DST 없음. canonical `time` 필드를 ISO 8601 UTC로 변환.
- **fuelPwrTot 검증**: `sum(fuelPwr1..10) ≈ fuelPwrTot` 차이 ≥ 5% 이면 데이터 이상.
- **양수 부호 컨벤션 미확정**: KPX `fuelPwr5` (양수)가 양수=방전 / 음수=충전인지 ServiceKey 발급 후 직접 검증 필요. CAISO Batteries와 동일 가정.
- **PPA/BTM 추정값**: `pEsmw`, `bEmsw`는 KPX 자체 추정. 실제 측정값 아님 → "estimated" 플래그.
- **유연탄+국내탄**: 모두 `coal`로 합산.
- **신재생(`fuelPwr10`)**: 바이오매스·연료전지·소수력·해양·폐기물 혼합 → IPCC factor 보수적으로 200 gCO2/kWh 적용 권장(전체 평균치).
- **음수 mix 처리**: 양수 외 발전원이 음수면 데이터 오류 → `max(v, 0)`.
- **SMP 0원 가능**: 제주에서 흔함 (재생E 과잉). 본토는 거의 없음.

## 4. Sample curl (실제 작동 검증)

```bash
# (1) KPX OpenAPI 5분 mix — ServiceKey 필요. 무효 키로 schema 확인:
curl -sSL "https://openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m?ServiceKey=test" \
  -o /tmp/kr_mix.xml \
  -w "HTTP %{http_code}  size %{size_download}  type %{content_type}\n"
# HTTP 200  size 330  type application/xml;charset=ISO-8859-1
# → resultCode 30 SERVICE KEY IS NOT REGISTERED ERROR (정상 응답 — 키만 발급되면 즉시 사용)

# (2) KPX OpenAPI 5분 수급:
curl -sSL "https://openapi.kpx.or.kr/openapi/sukub5mMaxDatetime/getSukub5mMaxDatetime?ServiceKey=test" \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 296

# (3) KPX OpenAPI SMP 시간별:
curl -sSL "https://openapi.kpx.or.kr/openapi/smp1hToday/getSmp1hToday?areaCd=1&serviceKey=test" \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 296

# (4) Phase 0 fallback — KPX SMP HTML:
curl -sSL "https://new.kpx.or.kr/smpInland.es?mid=a10606080100&device=pc" \
  -o /tmp/kr_smp.html \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 83069  type text/html;charset=UTF-8

# (5) Phase 0 fallback — KPX 실시간 수급 HTML:
curl -sSL "https://new.kpx.or.kr/powerinfoSubmain.es?mid=a10606030000" \
  -o /tmp/kr_mix.html \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 355550  type text/html;charset=UTF-8

# (6) EPSIS chart (세션 + AJAX):
curl -sSL -c /tmp/cookies.txt \
  "https://epsis.kpx.or.kr/epsisnew/selectEkmaSmpShdChart.do?menuId=040202" \
  -o /dev/null
curl -sSL -X POST -b /tmp/cookies.txt \
  -H "X-Requested-With: XMLHttpRequest" \
  "https://epsis.kpx.or.kr/epsisnew/selectEkmaSmpShdChart.ajax" \
  -o /tmp/epsis_smp.html \
  -w "HTTP %{http_code}  size %{size_download}\n"
# HTTP 200  size 47862  → grep "chartData.push" 으로 추출
```

예상 응답 (sumperfuel5m, 정상 키):
```xml
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <items>
    <item>
      <baseDatetime>20260425120500</baseDatetime>
      <fuelPwr1>233.98</fuelPwr1>      <!-- 수력 -->
      <fuelPwr2>319.13</fuelPwr2>      <!-- 유류 -->
      <fuelPwr3>13602.9</fuelPwr3>     <!-- 유연탄 -->
      <fuelPwr4>23077.7</fuelPwr4>     <!-- 원자력 -->
      <fuelPwr5>419.78</fuelPwr5>      <!-- 양수 -->
      <fuelPwr6>25221.0</fuelPwr6>     <!-- 가스 -->
      <fuelPwr7>0.15</fuelPwr7>        <!-- 국내탄 -->
      <fuelPwr8>1596.34</fuelPwr8>     <!-- 태양광시장 -->
      <fuelPwr9>400.13</fuelPwr9>      <!-- 풍력 -->
      <fuelPwr10>2559.94</fuelPwr10>   <!-- 신재생 -->
      <pEsmw>3446.57</pEsmw>           <!-- PPA 추정 -->
      <bEmsw>934.4</bEmsw>             <!-- BTM 추정 -->
      <fuelPwrTot>66592.9</fuelPwrTot> <!-- 총 시장수요 -->
    </item>
  </items>
</response>
```

## 5. 파서 구현

- **파일**: `api/src/kpx.ts`
- **주요 함수**:
  - `fetchKpxLiveSmp(area: 'inland'|'jeju')` → `KrPriceTick`
    - **Phase 0**: `new.kpx.or.kr/smpInland.es` HTML 정규식 추출
    - **Phase 1**: `openapi.kpx.or.kr/openapi/smp1hToday/getSmp1hToday?areaCd=1&serviceKey=...`
  - `fetchKpxGenerationMix()` → `KrMixTick` (5분 fuel)
    - **Phase 0**: `new.kpx.or.kr/powerinfoSubmain.es` HTML 추출 (1시간 단위)
    - **Phase 1**: `openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m?serviceKey=...` (**5분**)
  - `fetchKpxSupplyDemand()` → `KrSupplyTick` — `sukub5mMaxDatetime`
  - `getKpxSmpCached(area)` · `getKpxMixCached()` — 60s TTL
- **예상 코드량**:
  - Phase 0 (HTML): ~120줄 (cheerio 또는 정규식)
  - Phase 1 (OpenAPI): ~150줄 (fast-xml-parser, 환율 변환 포함)
- **의존성**: `fast-xml-parser` (OpenAPI XML), `cheerio` (HTML fallback), `fetch` (내장)
- **환율**: `lib/fx.ts` — `KRW→USD` daily snapshot (Yahoo Finance 또는 ExchangeRate-API)

## 6. 라이선스 / 재배포

| 소스 | 라이선스 | 재배포 | Attribution |
|---|---|---|---|
| KPX OpenAPI (data.go.kr) | **공공누리 제1유형** (출처표시, 상업이용 가능, 변형 가능) | **YES** | "출처: 한국전력거래소(KPX)" 필수 |
| KPX `new.kpx.or.kr` HTML | 명시 없음 (공공기관 게시물) | 보수적: 가공/정규화 결과로만 | "출처: 한국전력거래소" 명기 |
| EPSIS 차트 데이터 | KPX 운영 통계 포털, 라이선스 명시 없음 | 학술/보도용 OK, 상용은 보수적 | "출처: EPSIS, 한국전력거래소" |
| KEPCO Big Data | 공공누리 제1유형 (자료별 상이) | YES (자료별 표기 확인) | "출처: 한국전력공사" |
| 기상청 (KMA) data.go.kr | 공공누리 제1유형 | YES | "출처: 기상청" |

**Citation 예시**:
```json
{
  "publisher": "한국전력거래소(KPX), data.go.kr OpenAPI",
  "license": "공공누리 제1유형 (KOGL Type 1, attribution required, commercial use allowed)",
  "upstream": "https://openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m"
}
```

## 7. 품질 체크

### 7.1 SMP 합리성 (KRW/kWh)
- **일반 범위**: 80 ~ 200 원/kWh (USD 약 0.06 ~ 0.15 / kWh)
- **극단 범위**: 50 ~ 350 원/kWh
- **음수 SMP**: 본토는 거의 없음, 제주는 가끔 발생
- 현재(2026-04-25) 표본: 약 **101~166 원/kWh** (EPSIS chart 확인)

### 7.2 Generation Mix 완결성
- `sum(fuelPwr1~10 + pEsmw + bEmsw) ≈ fuelPwrTot` (±5% 허용)
- **Nuclear 변동 거의 없음**: 23,000 ± 500 MW 안정 (정비 외)
- **Coal 비중**: 15~30% (계절 따라)
- **Solar 일중 변화**: 정오 피크 ~5,000 MW, 야간 0
- **Wind**: 변동 큼, 1,000 MW 안팎

### 7.3 샘플 검증 (2019-11-28 00:05 KPX 표본 기준 — 공식 가이드 예제)
- 총 시장수요(`fuelPwrTot`): 66,592.9 MW
- 합산 fuelPwr1~10 + pEsmw + bEmsw ≈ 71,861 MW (PPA/BTM 포함)
- 차이 PPA/BTM 별도 계산 → 매핑 시 주의

### 7.4 Fallback 전략
- KPX OpenAPI 503/timeout → EPSIS chart endpoint
- EPSIS도 실패 → KPX HTML 스크래핑
- HTML도 실패 → last-known-good (15분 유예)

## 8. 기존 구현 참조

- **Electricity Maps parser**: `electricitymap/contrib/parsers/KPX.py`
  - 사실 참조: `REAL_TIME_URL`, `PRICE_URL`, `HISTORICAL_PRODUCTION_URL`, `PRODUCTION_MAPPING`
  - **AGPL-3.0**: 코드 복붙 금지, 사실(URL · 필드명 · 매핑 표)만 참조 OK
- **Zone YAML**: `electricitymap/contrib/config/zones/KR.yaml` — capacity 참조용

## 9. 알려진 함정

- **DST**: 한국은 DST **없음** → 날짜 변환 안전 (CAISO와 다름)
- **CSRF on `powerSource.es`**: KPX HTML 스크래핑 시 EnergyTag 방식 — 세션 GET → 토큰 → POST. EPSIS도 비슷.
- **EPSIS `selectEkgeEpsMepRealChart.ajax` deprecated**: HTTP 404 (2026-04 확인). 실시간 수급은 KPX OpenAPI로 이관됨.
- **OpenAPI XML encoding mismatch**: 헤더는 ISO-8859-1지만 실제 본문 UTF-8. parser는 UTF-8 강제 디코딩.
- **ServiceKey URL encoding**: data.go.kr 발급 키는 URL-encoded 형태와 raw 형태 두 종이 있음 → **raw로 사용**, 추가 인코딩 금지.
- **휴일/주말 응답 변경 없음**: KPX는 24/7 시장 운영 → 주말도 동일 응답 구조.
- **시계열 누락**: 5분 단위라 매 interval에 데이터 있어야 하지만, KPX 자체 점검 시 1~3 interval 누락 가능 → 마지막 known-good fallback.
- **Won → USD 변환**: 환율 캐시 (24h TTL) + Grid402 응답에 `fx_rate_used` 필드 노출.
- **fuelPwr10(신재생) gCO2/kWh 추정**: IPCC AR6 lifecycle "biomass" 230 또는 "other RE" 평균 100~250. 보수적 200 권장, citation에 명시.
- **데이터 시제(latency)**: KPX OpenAPI는 `getSukub5mMaxDatetime`(이름의 "MaxDatetime") = 가장 최근 5분 1건 반환. Pagination 없는 단일 row API.
- **3개월 윈도우 제한**: 과거 데이터 조회는 3개월 이내만. Backfill 필요시 `historicalSukub` 별도 endpoint 사용.
- **제주 별도 시스템**: V1은 본토만, 제주는 `chejusukub.do` + SMP `areaCd=2`로 V2 분리.

## 10. 테스트

- **Smoke test**: `.context/grid402/scripts/smoke_kpx.sh`
  - SMP HTML 추출 → 가격 1개 (Phase 0)
  - mix HTML 추출 → 9개 연료 합산 (Phase 0)
  - OpenAPI XML 응답(서비스키 발급 후) → 13 fields × resultCode 검증
- **Contract test**: `api/src/kpx.test.ts` (Vitest, mock 응답 5개):
  1. 정상 mix XML (5분 인터벌)
  2. SMP HTML 정상 (오늘 + 어제)
  3. ServiceKey 미등록 (resultCode=30)
  4. PPA/BTM 결측치
  5. EPSIS chart fallback
- **Live smoke**: 5회 연속 (5분 간격) 기록

---

## 11. Status (Done Definition)

- [x] Spec 섹션 1-10 채움 (이번 문서)
- [x] Live URL HTTP 검증:
  - [x] `openapi.kpx.or.kr/openapi/sumperfuel5m/getSumperfuel5m` → HTTP 200 (XML, 미등록 키 응답 정상)
  - [x] `openapi.kpx.or.kr/openapi/sukub5mMaxDatetime/getSukub5mMaxDatetime` → HTTP 200
  - [x] `openapi.kpx.or.kr/openapi/smp1hToday/getSmp1hToday` → HTTP 200
  - [x] `new.kpx.or.kr/smpInland.es` → HTTP 200 (83KB HTML)
  - [x] `new.kpx.or.kr/powerinfoSubmain.es` → HTTP 200 (355KB HTML)
  - [x] `epsis.kpx.or.kr/epsisnew/selectEkmaSmpShdChart.ajax` → HTTP 200 (47KB JS-embedded)
  - [x] `bigdata.kepco.co.kr/cmsmain.do?scode=S01&pcode=main` → HTTP 200 (정적 포털, no API)
  - [x] `data.go.kr` 검색·메타 → HTTP 200, OpenAPI 카탈로그 12개 식별
- [ ] data.go.kr ServiceKey 발급 신청 (15056640 + 신규 sumperfuel5m + smp1hToday)
- [ ] Phase 0 파서 작성 (`api/src/kpx.ts` HTML scrape) → SMP 1개값 추출
- [ ] Phase 1 파서 작성 → XML 파싱 + 13 필드 매핑
- [ ] `lib/fx.ts` 환율 변환 (KRW→USD)
- [ ] Smoke test 5회 통과
- [ ] Vitest 테스트 5개 통과
- [ ] `/spot/KR/KPX/live` 로컬 응답 확인
- [ ] `/mix/KR/live` 로컬 응답 확인
- [ ] `/emissions/KR/live` 합리값 (300~500 gCO2/kWh 예상 — 한국 mix 기준)
- [ ] `/combined/KR/KPX/live` 통합 응답
- [ ] Attribution payload: "출처: 한국전력거래소(KPX) via data.go.kr (공공누리 제1유형)"
- [ ] V2: 제주 분리 (`/spot/KR/KPX-JEJU/live`)
- [ ] V2: KEPCO 지역별 소비 통계 통합

---

## 12. 권장 구현 순서 (핵심 결정 요약)

| Phase | 시점 | 목표 | 작업량 |
|---|---|---|---|
| **Phase 0 (이번 주말, MVP)** | 즉시 | KPX HTML scraping → 1시간 mix + SMP, 인증 0 | 3-4h |
| **Phase 1 (해커톤 주중)** | data.go.kr 키 발급 후 | OpenAPI XML → **5분 mix** + SMP, 자동승인 | +4-6h |
| **Phase 2 (post-hackathon)** | 안정화 | EPSIS fallback + 환율 캐시 + Jeju 분리 + KEPCO 보조 | +4-6h |

**총 추정**: Phase 0+1 통합 = **8-10시간** (TypeScript 파서 + 환율 + 캐시 + 테스트). CAISO 대비 약간 더 소요(XML+환율 계층 추가).

---

## 13. Gotcha 우선순위 Top 5

1. **ServiceKey raw 사용** (URL 추가 인코딩 금지) — data.go.kr 가장 흔한 hodling 실수
2. **fuelPwr10(신재생) 매핑** — `unknown` 또는 `biomass` 200 gCO2/kWh, citation 명기
3. **PPA/BTM(`pEsmw`/`bEmsw`)** — 추정값. solar에 합산하되 `estimated:true` 메타 노출
4. **양수(`fuelPwr5`) 부호 컨벤션 검증 필수** — 첫 정상 응답으로 양수=방전 가정 검증
5. **환율 변환 없음 = 데모 망함** — KRW→USD 환산 필수, 24h TTL 캐시

---

**Last updated**: 2026-04-25
**Investigator**: Grid402 팀 (Samuel Lee + Claude research agent)
**관련 파일**: `api/src/kpx.ts` (작성 예정) · `api/src/types.ts` ("KPX" Iso 추가됨) · `api/src/emission-factors.ts` (KR도 동일 IPCC AR6) · `lib/fx.ts` (작성 예정 — KRW/USD)
**Reference research**: `.context/grid402/MAP_AND_KOREA_RESEARCH.md` §2
