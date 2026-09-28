# heap.bin 포맷 (version 2)

libheapmap이 남기는 malloc/free 기록이다. 모든 정수는 리틀 엔디언이다. 정의는 `heapmap.h`에 있다.

version 1(레코드 40바이트)에서 레코드를 16바이트로 줄였다. 이유와 측정은 `BENCH.md`의 7주차 절에 있다.

## 구조

```
[파일 헤더 24바이트]
[묶음 머리 16바이트][레코드 16바이트 × count]
[묶음 머리 16바이트][레코드 16바이트 × count]
...
```

묶음 하나는 스레드 버퍼 하나를 비운 것이다. 한 묶음의 레코드는 모두 같은 스레드 것이고, write 한 번으로 통째로 쓰여서 다른 스레드 묶음과 섞이지 않는다.

### 파일 헤더

| 오프셋 | 크기 | 필드 | 값 |
|---|---|---|---|
| 0 | 8 | magic | `"HEAPMAP\0"` |
| 8 | 4 | version | 2 |
| 12 | 4 | rec_size | 16 (읽는 쪽은 version과 이 값이 기대와 다르면 거부한다) |
| 16 | 4 | pid | 기록한 프로세스 |
| 20 | 4 | reserved | 0 |

### 묶음 머리

| 오프셋 | 크기 | 필드 | 설명 |
|---|---|---|---|
| 0 | 4 | tid | 이 묶음을 쓴 스레드 (`gettid()`, uftrace의 tid와 같다) |
| 4 | 4 | count | 뒤따르는 레코드 수 (최대 4096) |
| 8 | 8 | base_ts | `CLOCK_MONOTONIC` ns. 레코드 시각 = base_ts + dt |

### 레코드

| 오프셋 | 크기 | 필드 | 설명 |
|---|---|---|---|
| 0 | 4 | dt | base_ts로부터 ns. 4.29초를 넘으면 새 묶음을 시작한다 |
| 4 | 4 | size | 요청 크기. calloc은 n × size, free와 realloc_old는 0. 4GiB 이상은 `0xffffffff`로 잘린다 |
| 8 | 8 | addr_type | 하위 56비트 주소, 상위 8비트 type |

type: 1 malloc, 2 free, 3 calloc, 4 realloc(새 블록), 5 realloc_old(realloc이 놓은 원래 블록)

시각을 µs로 바꾸면(`/ 1000`) uftrace `trace.json`의 `ts`와 바로 비교된다. 같은 시계다.

## 읽을 때 알아야 할 것

- **순서**: 레코드는 파일 전체로는 시각 순이 아니다. 스레드마다 버퍼에 모았다가(4096개) 묶음으로 쓰기 때문이다. 시각으로 정렬해서 재생한다. 같은 시각이면 파일 순서를 지켜야 한다(안정 정렬). realloc_old가 realloc보다 앞에 와야 제자리 realloc(새 주소 = 원래 주소)이 꼬이지 않는다.
- **시각을 재는 시점**: 할당은 진짜 할당이 끝난 **뒤**, free는 진짜 해제 **전**에 잰다. 그래서 스레드 A가 해제한 주소를 스레드 B가 곧바로 받아도 로그에서는 항상 "A의 free → B의 malloc" 순서가 된다. realloc은 끝난 뒤에 재므로 이 보장이 없다(드묾).
- **realloc**: realloc_old(원래 블록 해제) + realloc(새 블록 할당) 두 레코드로 남고, 시각이 같다. `realloc(NULL, n)`은 realloc 하나만, `realloc(p, 0)`은 realloc_old 하나만 남는다. 실패(NULL 반환)하면 원래 블록이 그대로 살아 있으므로 아무것도 남기지 않는다.
- **모르는 주소의 free**: 후킹 전에 할당됐거나, `posix_memalign`, `aligned_alloc`, `memalign`처럼 후킹하지 않는 함수로 할당된 블록이다. 무시한다.
- **free(NULL)**: addr 0인 free 레코드로 남는다. 호출 수를 정확히 맞추려고 남긴다.
- **주소 상위 8비트**: type을 넣느라 주소는 56비트까지만 남는다. 사용자 공간 주소는 48비트 이하라 문제없지만, MTE나 HWASan처럼 포인터 상위 바이트에 태그를 쓰는 환경에서는 태그가 사라진다.

## 기록하는 프로세스

- `HEAPMAP_OUT`이 있는 **첫 프로세스**만 기록한다. 파일을 연 직후 환경 변수 이름을 `_EAPMAP_OUT`으로 바꿔 자식 프로세스(exec 포함)에게 숨긴다. 그러지 않으면 자식이 같은 파일을 `O_TRUNC`로 열어 부모 기록을 지운다.
- 예외: `uftrace`는 기록하지 않고 변수도 숨기지 않는다. 그래서 `LD_PRELOAD=libheapmap.so HEAPMAP_OUT=heap.bin uftrace record ./prog`가 동작한다.
- 그 밖의 실행기(`timeout`, `env` 등)를 LD_PRELOAD 안쪽에 두면 그 실행기가 기록을 가져간다. 대상 프로그램에 직접 붙이거나 uftrace로 감싼다.
- fork한 자식은 기록하지 않는다.

## 기록이 사라지지 않게

스레드 버퍼는 다음 시점에 파일로 비운다. 버퍼가 가득 찰 때, 스레드가 끝날 때(pthread key 소멸자), 프로세스가 끝날 때(destructor), `_exit` · `_Exit` · `execve` 직전.

종료 시점에 아직 돌고 있는 다른 스레드의 버퍼와, SIGKILL처럼 강제로 죽은 경우의 버퍼는 잃는다.
