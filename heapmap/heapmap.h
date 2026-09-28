// heap.bin 포맷 (version 2). 자세한 설명은 FORMAT.md
#pragma once
#include <stdint.h>

#define HM_MAGIC {'H', 'E', 'A', 'P', 'M', 'A', 'P', '\0'}
#define HM_VERSION 2

// HM_REALLOC_OLD: realloc이 원래 블록을 놓은 것. 같은 시각의 HM_REALLOC(새 블록) 바로 앞에 온다
enum { HM_MALLOC = 1, HM_FREE = 2, HM_CALLOC = 3, HM_REALLOC = 4, HM_REALLOC_OLD = 5 };

#define HM_ADDR_BITS 56 // 사용자 공간 주소는 48비트 이하라 위 8비트에 type을 넣는다

typedef struct {
    char magic[8];
    uint32_t version;
    uint32_t rec_size;
    uint32_t pid;
    uint32_t reserved;
} hm_header_t; // 24바이트, 파일 맨 앞에 한 번

// 스레드 버퍼 하나를 비울 때마다 레코드 묶음 앞에 붙는다. 같은 묶음의 레코드는 모두 이 스레드 것이다
typedef struct {
    uint32_t tid;
    uint32_t count;   // 뒤따르는 레코드 수
    uint64_t base_ts; // CLOCK_MONOTONIC ns. 레코드의 dt는 이 시각부터의 차이
} hm_block_t; // 16바이트

typedef struct {
    uint32_t dt;        // base_ts로부터 ns (4.29초를 넘으면 새 묶음을 시작한다)
    uint32_t size;      // 요청 크기, 4GiB 이상은 0xffffffff로 잘린다. free는 0
    uint64_t addr_type; // 하위 56비트 주소 | type << 56
} hm_record_t; // 16바이트

_Static_assert(sizeof(hm_header_t) == 24, "header size");
_Static_assert(sizeof(hm_block_t) == 16, "block size");
_Static_assert(sizeof(hm_record_t) == 16, "record size");
