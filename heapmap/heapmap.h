// heap.bin 포맷. 자세한 설명은 FORMAT.md
#pragma once
#include <stdint.h>

#define HM_MAGIC {'H', 'E', 'A', 'P', 'M', 'A', 'P', '\0'}
#define HM_VERSION 1

enum { HM_MALLOC = 1, HM_FREE = 2, HM_CALLOC = 3, HM_REALLOC = 4 };

typedef struct {
    char magic[8];
    uint32_t version;
    uint32_t rec_size;
    uint32_t pid;
    uint32_t reserved;
} hm_header_t; // 24바이트

typedef struct {
    uint64_t ts;   // CLOCK_MONOTONIC, ns
    uint64_t addr; // 반환된 주소 (free는 해제한 주소). 실패하면 0
    uint64_t size; // 요청 크기 (calloc은 n*size, free는 0)
    uint64_t old;  // realloc의 원래 주소. 나머지는 0
    uint32_t tid;
    uint8_t type;  // HM_*
    uint8_t pad[3];
} hm_record_t; // 40바이트

_Static_assert(sizeof(hm_header_t) == 24, "header size");
_Static_assert(sizeof(hm_record_t) == 40, "record size");
