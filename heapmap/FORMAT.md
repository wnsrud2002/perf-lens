# heap.bin 포맷 (version 1)

libheapmap이 남기는 malloc/free 기록이다. 모든 정수는 리틀 엔디언이다. 정의는 `heapmap.h`에 있다.

## 구조

```
[헤더 24바이트][레코드 40바이트] × N
```

파일 끝까지 레코드가 이어진다. 레코드 수 = (파일 크기 − 24) / 40.

### 헤더

| 오프셋 | 크기 | 필드 | 값 |
|---|---|---|---|
| 0 | 8 | magic | `"HEAPMAP\0"` |
| 8 | 4 | version | 1 |
| 12 | 4 | rec_size | 40 (읽는 쪽은 이 값이 기대와 다르면 거부한다) |
| 16 | 4 | pid | 기록한 프로세스 |
| 20 | 4 | reserved | 0 |

### 레코드

| 오프셋 | 크기 | 필드 | 설명 |
|---|---|---|---|
| 0 | 8 | ts | `CLOCK_MONOTONIC` ns. uftrace의 `ts`(µs)와 같은 시계라 `ts / 1000`으로 바로 비교된다 |
| 8 | 8 | addr | 반환된 주소. free는 해제한 주소. 할당 실패는 0 |
| 16 | 8 | size | 요청 크기. calloc은 n × size, free는 0 |
| 24 | 8 | old | realloc의 원래 주소. 다른 종류는 0 |
| 32 | 4 | tid | 호출한 스레드 (`gettid()`, uftrace의 tid와 같다) |
| 36 | 1 | type | 1 malloc, 2 free, 3 calloc, 4 realloc |
| 37 | 3 | pad | 0 |

## 읽을 때 알아야 할 것

- **순서**: 레코드는 시각 순이 아니다. 스레드마다 버퍼에 모았다가(4096개) 한꺼번에 쓰기 때문이다. `ts`로 정렬해서 재생한다.
- **시각을 재는 시점**: 할당은 진짜 할당이 끝난 **뒤**, free는 진짜 해제 **전**에 잰다. 그래서 스레드 A가 해제한 주소를 스레드 B가 곧바로 받아도 로그에서는 항상 "A의 free → B의 malloc" 순서가 된다. realloc은 끝난 뒤에 재므로 이 보장이 없다(드묾).
- **realloc**: 레코드 하나가 "old 해제 + addr 할당"을 뜻한다. `realloc(NULL, n)`은 old가 0이다.
- **모르는 주소의 free**: 후킹 전에 할당됐거나, `posix_memalign`, `aligned_alloc`, `memalign`처럼 후킹하지 않는 함수로 할당된 블록이다. 무시한다.
- **free(NULL)**: addr 0인 free 레코드로 남는다. 호출 수를 정확히 맞추려고 남긴다.

## 기록하는 프로세스

- `HEAPMAP_OUT`이 있는 **첫 프로세스**만 기록한다. 파일을 연 직후 환경 변수 이름을 `_EAPMAP_OUT`으로 바꿔 자식 프로세스(exec 포함)에게 숨긴다. 그러지 않으면 자식이 같은 파일을 `O_TRUNC`로 열어 부모 기록을 지운다.
- 예외: `uftrace`는 기록하지 않고 변수도 숨기지 않는다. 그래서 `LD_PRELOAD=libheapmap.so HEAPMAP_OUT=heap.bin uftrace record ./prog`가 동작한다.
- 그 밖의 실행기(`timeout`, `env` 등)를 LD_PRELOAD 안쪽에 두면 그 실행기가 기록을 가져간다. 대상 프로그램에 직접 붙이거나 uftrace로 감싼다.
- fork한 자식은 기록하지 않는다.

## 기록이 사라지지 않게

스레드 버퍼는 다음 시점에 파일로 비운다. 버퍼가 가득 찰 때, 스레드가 끝날 때(pthread key 소멸자), 프로세스가 끝날 때(destructor), `_exit` · `_Exit` · `execve` 직전.

종료 시점에 아직 돌고 있는 다른 스레드의 버퍼와, SIGKILL처럼 강제로 죽은 경우의 버퍼는 잃는다.
