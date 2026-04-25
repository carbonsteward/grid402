# <Host 이름> — Hackathon Host API Spec

> **Instructions**: 새 host 문서 만들 때 이 파일을 `<host>.md`로 복사하고 10개 섹션 전부 채우세요.
> Category A 조사 목표 = "이 Host를 쓰고 있다"를 해커톤 심사위원에게 증명.

---

## 1. 제품 카테고리
- **한 줄 정의**: <e.g., "Decentralized LLM inference" / "On-chain analytics">
- **해커톤 후원 성격**: <main sponsor / track sponsor / tooling>
- **공식 홈페이지**: <URL>

## 2. Grid402 내 역할
- **Layer** (Layer 0 taxonomy 기준): <Brain / Body / Wallet / Data / Analytics / Orchestration>
- **어떤 UC에 기여하나**: UC1 / UC2 / UC3 중 해당
- **다른 Host와의 겹침·연결**: <e.g., "FLock은 Brain, AgentKit이 Body를 제공 → 상호 보완">

## 3. 기술 통합 스펙
- **통합 방식**: <SDK / REST API / MCP / CLI>
- **패키지 / 엔드포인트**: <npm 이름 or URL>
- **인증**: <API key / wallet signature / OAuth>
- **호출 예시**:
  ```bash
  # 또는 코드 스니펫
  ```

## 4. 해커톤 심사 요건
- **필수 사용 증거**: <e.g., "Basescan tx URL 스크린샷", "chat 출력 로그">
- **점수 기여 / 보너스**: <있으면 명시>

## 5. Grid402 통합 코드
- **파일 위치**: <api/src/* or agent/src/*>
- **기존 코드**: <이미 작성된 함수 목록>
- **추가 작성 필요**: <TODO 목록>

## 6. 데모 시나리오
- **등장 순간**: 5분 데모의 몇 초 지점에서 어떻게 등장
- **증거 아티팩트**: <스크린샷 경로 / tx 링크 / 터미널 출력>

## 7. 라이선스·크레딧
- **무료 tier**: <한계>
- **유료 tier**: <비용 / 과금 모델>
- **해커톤 credits**: <지급 여부 / 액수>

## 8. 알려진 함정·제약
- Rate limit / 지역 제한 / ToS 조항 / 버그

## 9. Fallback 전략
- Host 서비스 다운 시: <대응 플랜>
- 대체 서비스: <있으면 명시>

## 10. 상태 (Status)
- [ ] 계정 생성 · API key 확보
- [ ] 로컬 smoke test 통과
- [ ] Grid402 코드베이스 통합
- [ ] 데모 스크립트에 등장 지점 명시
- [ ] 증거 아티팩트 저장 (`demo-evidence/`)
- [ ] 팀 내부 리뷰 완료

---

**Last updated**: YYYY-MM-DD
**Investigator**: <name>
