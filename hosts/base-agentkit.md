# Base SDK (Coinbase AgentKit) — Host A1

## 1. 제품 카테고리
- **한 줄 정의**: 모든 AI 에이전트에 온체인 지갑과 tool use capability를 부여하는 SDK
- **해커톤 후원 성격**: Base 해커톤 메인 스폰서 스택 (Coinbase Developer Platform)
- **공식 홈페이지**:
  - 코드: https://github.com/coinbase/agentkit
  - 문서: https://docs.cdp.coinbase.com/agentkit/docs/welcome
  - npm: `@coinbase/agentkit`, `@coinbase/agentkit-langchain` 등
- **현재 버전**: `@coinbase/agentkit@^0.8.x`
- **저장소 활동**: ⭐1,209, 2026-04-24 기준 활발히 업데이트

## 2. Grid402 내 역할
- **Layer**: **Body** (에이전트의 행동 레이어) + **Wallet** (온체인 지갑 바인딩)
- **기여 UC**:
  - **UC1 (수요관리)**: 에이전트가 Grid402 HTTP 엔드포인트를 x402로 호출하는 주 경로
  - **UC2 (DePIN/AVS 오라클)**: AVS 컨트랙트 호출 시 동일 지갑이 Grid402도 결제
  - **UC3 (예측시장)**: prediction market 포지션 결제 지갑과 Grid402 결제 지갑이 동일 = 아이덴티티 연속성
- **다른 Host와의 겹침·연결**:
  - **FLock** = Brain, AgentKit = Body → 쌍을 이룸
  - **Nansen** = 이 Body가 만든 지갑을 외부에서 관찰 (traction 측정)

## 3. 기술 통합 스펙

### 3.1 통합 방식
- 에이전트 측: **npm SDK** (`@coinbase/agentkit`)
- 서버 측: 별도 통합 없음 (x402 프로토콜만 지원하면 됨 — `api/src/index.ts`에 이미 있음)

### 3.2 주요 패키지
```
@coinbase/agentkit                    ← core
@coinbase/agentkit-langchain          ← LangChain 통합 (우리 데모용)
@coinbase/agentkit-vercel-ai-sdk      ← 대체 옵션
@coinbase/agentkit-model-context-protocol  ← MCP 통합
```

### 3.3 인증
- **CDP API key** (서버 쪽 지갑 호출용): `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`
- **발급**: https://portal.cdp.coinbase.com → *Create Secret API Key*
- **저장 위치**: `agent/.env` (이미 `.env.example` 준비됨)

### 3.4 Grid402에서의 사용 예시
```ts
// agent/src/index.ts (현재 구현)
import { AgentKit, CdpEvmWalletProvider, x402ActionProvider } from "@coinbase/agentkit";

const walletProvider = await CdpEvmWalletProvider.configureWithWallet({
  apiKeyId: process.env.CDP_API_KEY_ID!,
  apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  walletSecret: process.env.CDP_WALLET_SECRET!,
  networkId: "base-sepolia",
});

const agentkit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    x402ActionProvider({
      registeredServices: [process.env.GRID402_URL!],
      maxPaymentUsdc: 0.10,
    }),
  ],
});
```

## 4. 해커톤 심사 요건
- **필수 사용 증거**: AgentKit 에이전트가 Grid402를 호출해서 받은 응답 + **Basescan tx URL**
- **점수 기여 / 보너스**:
  - Base 해커톤의 메인 스폰서 스택 → 사용 자체가 기본 점수
  - x402 action provider 활용 시 추가 점수 기대 (Coinbase가 밀고 있는 프로토콜)
  - "every API call = Base tx" 메시지로 Base 체인 트랜잭션 볼륨 기여 서사

## 5. Grid402 통합 코드
- **파일 위치**: `agent/src/index.ts` (99 lines, 이미 완료)
- **기존 코드**:
  - `CdpEvmWalletProvider.configureWithWallet()` 로 지갑 초기화
  - `x402ActionProvider` 를 actionProviders에 주입
  - LangChain ReAct 에이전트에 `getLangChainTools(agentkit)` 바인딩
  - One-shot prompt 실행 + stream 출력
- **추가 작성 필요**:
  - [ ] `pnpm install` 실행 (agent + api 양쪽)
  - [ ] `.env`에 CDP key 3개 + OpenAI key 입력 (또는 FLock로 override)
  - [ ] 첫 smoke test: `pnpm dev` → 에이전트가 프롬프트 받고 Grid402 호출

## 6. 데모 시나리오
- **등장 순간**: 5분 데모의 **30~120초 구간** (UC1 라이브 데모)
- **대사**: *"Watch — I type 'what's the current CAISO NP15 price?' The agent hits Grid402, gets a 402, pays half a cent in USDC on Base Sepolia, and hands me back the cleared price."*
- **증거 아티팩트**:
  - 터미널 출력: `🤖 agent: The current NP15 price is $42.15/MWh...`
  - 터미널 출력: `🔧 tool [make_http_request_with_x402]: {"data":{...},"payment":{"txHash":"0x..."}}`
  - Basescan 링크 (brand new tx, 녹색 체크)
- **저장 경로**: `.context/grid402/demo-evidence/base-agentkit-*`

## 7. 라이선스·크레딧
- **Apache 2.0** 오픈소스
- **CDP API**: 무료 tier에 기본 Base 지갑 호출 포함
- **Base Sepolia**: testnet USDC 무료 (https://faucet.circle.com)
- **Base mainnet**: 실제 USDC 필요 (데모는 Sepolia로 충분)
- **해커톤 credits**: 별도 credits 지급은 없으나 CDP API·Base Sepolia는 본래 무료

## 8. 알려진 함정·제약
- **CDP Wallet 은 hosted custodial** — 키 자체는 Coinbase 인프라에 있음. 실 상용에선 Smart Wallet이나 Safe 권장 (해커톤 데모는 문제없음)
- **x402 v1.2 최신성**: `@x402/hono` · `@x402/evm` 신버전 (v1.2) 전제. AgentKit 내부 버전도 호환 필요 — 충돌 시 `pnpm why x402` 확인
- **Rate limit**: AgentKit 자체는 rate limit 없지만 CDP 지갑 API에는 있음. 데모 중 반복 호출 시 지연 가능
- **network id 문자열**: AgentKit은 `"base-sepolia"` / `"base"` 네이밍, `@x402/hono`는 CAIP-2 (`"eip155:84532"`) → 두 곳 동기화 필요

## 9. Fallback 전략
- **AgentKit 다운**: Grid402 API 자체는 독립적으로 작동 (cUrl 데모 준비). 에이전트만 생략하고 "여기서 cUrl 호출해보겠습니다" 모드로 전환
- **CDP Wallet 다운**: Privy, viem, ZeroDev 지갑 provider로 교체 가능 (AgentKit wallet-provider 추상화 덕분). 사전에 backup Privy 지갑 준비 권장
- **x402 facilitator 다운**: `https://x402.org/facilitator` 대신 self-facilitate 모드 스크립트 준비

## 10. 상태 (Status)
- [x] AgentKit npm 패키지 선정 (`@coinbase/agentkit@^0.8.0`)
- [x] `agent/src/index.ts` scaffold 완료
- [x] `agent/.env.example` 작성
- [ ] CDP API key 3개 발급 · Keychain 저장
- [ ] `pnpm install` 실행
- [ ] 첫 local smoke test (에이전트 → Grid402 호출 → 402 → payment → 200)
- [ ] Basescan tx URL 스크린샷 캡처
- [ ] 데모 스크립트 30~120초 구간 리허설
- [ ] 팀 내부 리뷰 완료

---

**Last updated**: 2026-04-25
**Investigator**: Grid402 팀
**관련 문서**: [PRD.md §7.1 Mandatory stack](../PRD.md), [CONCEPT_KR.md Layer 0](../CONCEPT_KR.md)
