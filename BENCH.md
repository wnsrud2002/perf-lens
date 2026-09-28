# 뷰어 성능 측정 (3주차)

## 측정 대상과 조건

- 트레이스: jq 1.7.1 (`-pg`, 정적 빌드). 이벤트 1,452,180개(B/E), 함수 호출 726,086건, 최대 깊이 22, JSON 104MB
  ```bash
  uftrace record --no-libcall -d jqtrace jq-1.7.1/jq -n '[range(400)] | map({a:., b:(.*2|tostring)}) | group_by(.a%10) | length'
  uftrace dump -d jqtrace --chrome > jq-trace.json
  ```
- 측정 환경: Jetson Orin Nano (전력 모드 MAXN_SUPER, `jetson_clocks` 적용: CPU 6코어 1.728GHz 고정), headless Chromium 153 (GPU 없음, 소프트웨어 래스터), 뷰포트 1400×800
  - `jetson_clocks`는 "GPU frequency scaling not supported" 오류를 내지만 CPU 고정은 적용된다(`scaling_min_freq` = `scaling_max_freq`로 확인). 측정은 CPU만 쓴다.
- 측정 스크립트: `cd viewer && npm run bench -- ../targets/jq-trace.json 5` (5회 반복, 표는 중앙값)
  - 로딩: 페이지 열기부터 첫 화면이 그려질 때까지
  - 로딩 중 최장 멈춤: 로딩하는 동안 rAF 간격의 최댓값 (메인 스레드가 멈춘 가장 긴 시간)
  - 줌/팬: 전체 보기에서 매 프레임 휠(또는 드래그) 이벤트 하나씩 80프레임, 프레임 간격의 중앙값과 p95
  - 메모리: 강제 GC 후 JS 힙 + ArrayBuffer 저장소(TypedArray는 JS 힙 밖에 있어서 따로 더해야 한다)

## 결과

| 지표 | 최적화 전 | 최적화 후 | 변화 |
|---|---|---|---|
| 로딩 → 첫 화면 | 3,041 ms | 2,063 ms | −32% |
| 로딩 중 최장 멈춤 | 1,550 ms | 83 ms | −95% |
| 줌 프레임 (중앙 / p95) | 350 / 817 ms (3 fps) | 16.7 / 16.7 ms (60 fps) | 21배 |
| 팬 프레임 (중앙 / p95) | 850 / 900 ms (1 fps) | 16.7 / 16.8 ms (60 fps) | 51배 |
| JS 메모리 | 50 MB | 23 MB | −54% |

### 맥에서 (최적화 후만)

MacBook Air(Apple Silicon), 3회 중앙값. 같은 `bench.mjs`와 같은 트레이스로 쟀다.

| 지표 | Orin Nano, headless | 맥, headless Chromium 153 | 맥, Chrome (`CHANNEL=chrome`) |
|---|---|---|---|
| 로딩 → 첫 화면 | 2,063 ms | 442 ms | 610 ms |
| 로딩 중 최장 멈춤 | 83 ms | 17 ms | 83 ms |
| 줌 프레임 (중앙 / p95) | 16.7 / 16.7 ms | 16.7 / 16.7 ms | 16.7 / 16.8 ms |
| 팬 프레임 (중앙 / p95) | 16.7 / 16.8 ms | 16.7 / 16.8 ms | 16.7 / 16.7 ms |
| JS 메모리 | 23 MB | 23 MB | 23 MB |

맥 headless 로딩 단계: 읽기 146 · JSON.parse 162 · 구간 변환 91 · 분석 21 ms. 모든 환경에서 60fps 상한에 닿는다.

Orin Nano 로딩 단계별 시간(최적화 후, Worker 안): 읽기 980 · JSON.parse 920 · 구간 변환 560 · 분석 77 ms

60fps는 화면 주사율 상한이라 이 측정으로는 더 올라가지 않는다.

## 한 일과 효과

1. **파싱을 Web Worker로 옮김** (`src/worker.ts`): 멈춤 1.7초 → 0.1초. 로딩 중에도 화면이 반응한다.
2. **객체 배열 → TypedArray 열 구조** (`src/parse.ts`): 구간 72만 개가 객체 72만 개에서 배열 몇 개가 됐다. 메모리가 절반이 됐고, Worker에서 복사 없이 넘긴다(transfer).
3. **깊이별 이진 탐색**: 같은 깊이 구간은 겹치지 않아서 start와 end가 모두 정렬돼 있다. 화면 왼쪽 끝에 걸친 첫 구간을 `lowerBound`로 바로 찾는다.
4. **LOD**: 1px보다 좁은 구간은 픽셀 칸 하나로 합치고, 다음 칸의 첫 구간으로 이진 탐색해 건너뛴다. 한 줄을 그리는 비용이 구간 수가 아니라 화면 폭(px)에 비례한다. 전체 보기 기준으로 구간 72만 개를 칸 1만 3천 개로 줄였다.
5. **1px 칸은 ImageData에 직접 쓰기**: 4번까지 하고도 팬이 30fps였다. 원인을 아래 순서로 좁혔다.
   - 추측 1 "칸마다 `fillStyle`에 색 문자열을 넣어서 파싱 비용이 든다" → 색별 `Path2D`로 모아 봤지만 **변화 없음**
   - 계측해 보니 루프 16ms 중 대부분이 캔버스 API 호출(1만 3천 번) 자체의 비용이었다
   - 픽셀 버퍼에 쓰기로 바꿨지만 여전히 30fps. 다시 계측해 보니 `Uint32Array.fill()`을 20만 번(칸 × 행) 부르는 호출 비용이 20ms였다
   - 일반 반복문 대입으로 바꾸자 60fps(p95 16.8ms)

## 측정하면서 알게 된 함정

- **측정용 서버의 즉석 압축**: `vite preview`가 104MB를 요청마다 gzip해서 읽기가 3.8초로 부풀었다(압축 없으면 0.44초). 파일 드롭과 조건을 맞추려고 측정할 때는 압축을 끈다.
- **Playwright `route.fulfill`**: 100MB급 응답에서 페이지가 조용히 닫혔다. dist에 심볼릭 링크를 걸어 서버가 직접 서빙하게 했다.
- **빈 프레임 섞임**: Playwright로 휠 이벤트를 하나씩 보내면 다시 그리지 않는 프레임이 섞여 중앙값이 60fps로 잘못 나왔다. 페이지 안에서 매 프레임 이벤트를 넣는 방식으로 바꿨다.
- **메모리**: TypedArray는 `JSHeapUsedSize`에 잡히지 않아서 처음에 2MB로 나왔다. CDP `Runtime.getHeapUsage`의 `backingStorageSize`를 더한다.

## 남은 것

- 맥에서 최적화 전 버전도 재기. 위 전후 표는 Orin Nano 기준이고, 맥은 최적화 후만 쟀다.
- 로딩의 남은 병목은 읽기와 JSON.parse(1.8초). uftrace 출력은 한 줄에 이벤트 하나라서, 스트리밍 줄 파서로 바꾸면 104MB 문자열과 중간 객체를 만들지 않아도 된다. 1,000만 이벤트 규모가 필요해지면 한다.

## 검색 중 LOD

LOD 칸은 그 칸의 첫 구간 색으로 칠한다. 그래서 검색어와 맞는 작은 구간이 칸 안에 숨으면 전체 보기에서 강조가 사라졌다.
검색 중에는 합친 구간들을 훑어 일치하는 게 있으면 그 색으로 칠한다. 일치 구간이 하나도 없으면 훑지 않는다(훑으면 팬 p95가 33ms로 떨어졌다).
`jv_free`(5만 8천 건) 검색 중 팬: 16.7 / 16.8 ms (60 fps)
