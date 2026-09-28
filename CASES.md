# 실전 분석 사례

## jq 1.7.1: 끝까지 해제되지 않는 블록은 무엇인가 (2026-09-28)

### 기록

```bash
LD_PRELOAD=heapmap/libheapmap.so HEAPMAP_OUT=jq-heap.bin \
  uftrace record --no-libcall jq -n '[range(400)] | map({a:., b:(.*2|tostring)}) | group_by(.a%10) | length'
uftrace dump --chrome > jq-both.json
```

jq는 `-pg`로 정적 빌드했다. 함수 호출 72만 건, 할당 9천 건이다.

### 처음 본 것

뷰어의 함수별 할당 표에서, 종료할 때까지 해제되지 않은 블록(누수 후보)은 45개였다.

| 할당 순간의 호출 경로 | 블록 | 바이트 |
|---|---|---|
| (트레이스 밖: main 이전) | 17 | 174,052 |
| main | 27 | 3,944 |
| main → process → jq_next → stack_save | 1 | 48 |

### 1. `main`에서 직접 할당된 27개 → `setlocale`

`--no-libcall`로 기록하면 libc 함수는 트레이스에 없다. 그래서 libc 안에서 일어난 할당은 그 함수를 부른 jq 함수(`main`)에 붙는다. 라이브러리 호출까지 넣어(`-D 2`, 깊이 2까지만) 다시 기록하니 27개 모두 `main → setlocale`이었다.

glibc는 `setlocale`로 읽은 로캘 데이터를 프로세스가 끝날 때까지 일부러 들고 있다. 누수가 아니라 의도된 캐시다.

### 2. `stack_save`의 48바이트 → jq가 아니라 uftrace의 할당

`stack_save`는 jq 실행 스택이 모자랄 때만 `jv_mem_realloc`으로 할당한다. 그 크기는 `(기존 크기 + 요청 + 256) × 2`라 최소 수백 바이트이고, 48바이트는 나올 수 없다. 또 `jv_mem_realloc`은 추적되는 함수라서, 거기서 할당했다면 경로 끝에 그 이름이 붙었어야 한다.

같은 바이너리를 uftrace 없이 libheapmap만 걸어 돌려 비교했다.

| 조건 | 누수 후보 | 48B 블록 | 73,728B 블록 |
|---|---|---|---|
| libheapmap만 | 27개, 3,944B | 0 | 0 |
| uftrace와 함께 | 45개, 178,044B | 1 | 1 |

늘어난 18개(174KB)는 모두 uftrace의 libmcount가 **대상 프로세스 안에서** 할당한 것이다. 73,728B 블록(leaky_server에서도 봤던 것)과 48B 블록이 여기 포함된다. 48B 블록은 libmcount가 우연히 `stack_save` 실행 중에 할당해서, 시각만 보고 연결하는 뷰어가 `stack_save`에 붙였다.

### 결론

- jq 자체의 누수 후보는 `setlocale` 캐시뿐이다. 진짜 누수는 찾지 못했다.
- **추적 도구의 할당이 힙 기록에 섞이고, 시각이 겹치면 사용자 함수에 잘못 붙는다.** 두 로그를 시각으로 연결하는 방식의 한계다.
  - 다른 도구로 교차 확인하는 습관이 필요하다. 이번에는 "uftrace 없이 한 번 더"로 구분했다.
  - 고치려면 할당한 쪽의 반환 주소를 기록해 libmcount 안이면 빼야 한다. 다만 libmcount가 `strdup` 같은 libc 함수를 거쳐 할당하면 반환 주소가 libc를 가리켜서, 이것만으로는 다 걸러지지 않는다.
- 라이브러리 호출을 트레이스에서 빼면(`--no-libcall`), 라이브러리 안의 할당은 그 라이브러리를 부른 함수에 붙는다. 표에서 `main`이 할당한 것처럼 보이면 라이브러리 호출을 의심한다.
