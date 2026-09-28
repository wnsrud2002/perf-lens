// libheapmap: malloc/free/calloc/realloc를 가로채 heap.bin에 기록한다.
// 사용: LD_PRELOAD=./libheapmap.so HEAPMAP_OUT=heap.bin ./program  (HEAPMAP_OUT이 없으면 기록하지 않는다)
// 포맷은 FORMAT.md 참고.
//
// 이 파일 안의 코드는 malloc을 절대 부르면 안 된다(부르면 자기 자신으로 다시 들어온다).
// 그래서 printf 대신 write, 버퍼는 mmap, 시각은 clock_gettime(vDSO)만 쓴다.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include "heapmap.h"

#define BUF_RECS 4096 // 스레드마다 레코드 4096개(64KB)를 모았다가 write 한 번

// 묶음 머리와 레코드를 붙여 두어 write 한 번으로 통째로 쓴다
typedef struct {
    hm_block_t hdr;
    hm_record_t recs[BUF_RECS];
} tbuf_t;

static void *(*real_malloc)(size_t);
static void (*real_free)(void *);
static void *(*real_calloc)(size_t, size_t);
static void *(*real_realloc)(void *, size_t);

static int fd = -1;
static int direct;          // 1이면 버퍼 없이 바로 쓴다 (프로세스 종료 플러시 이후)
static int initializing;
static pthread_key_t key;

// initial-exec: TLS 접근에 __tls_get_addr(내부에서 malloc할 수 있음)을 거치지 않게 한다
#define TLS __thread __attribute__((tls_model("initial-exec")))
static TLS tbuf_t *buf;
static TLS uint32_t my_tid;
static TLS int in_hook;     // 재진입 플래그: 후킹 안에서 다시 malloc이 불리면 기록하지 않는다

// dlsym이 내부에서 calloc을 부르는데, 그땐 아직 진짜 calloc 주소를 모른다.
// 그동안은 이 정적 버퍼에서 잘라 준다. 앞 8바이트에 크기를 둔다(realloc용).
static char boot[64 * 1024] __attribute__((aligned(16)));
static size_t boot_used;

static int is_boot(void *p) { return (char *)p >= boot && (char *)p < boot + sizeof boot; }

static void *boot_alloc(size_t size)
{
    size_t need = (size + 16 + 15) & ~(size_t)15;
    if (boot_used + need > sizeof boot)
        return NULL;
    char *p = boot + boot_used;
    boot_used += need;
    *(size_t *)p = size;
    return p + 16;
}

static void write_all(const void *p, size_t len)
{
    const char *c = p;
    while (len) {
        ssize_t w = write(fd, c, len);
        if (w < 0 && errno == EINTR)
            continue; // 시그널에 끊긴 건 다시 쓴다. 그냥 두면 버퍼 한 통(레코드 4096개)을 잃는다
        if (w <= 0)
            return; // 그 밖의 실패로 대상 프로그램을 죽이지는 않는다
        c += w;
        len -= w;
    }
}

static void flush(tbuf_t *b)
{
    if (b && b->hdr.count && fd >= 0) // O_APPEND라 스레드끼리 섞여도 묶음이 쪼개지지 않는다
        write_all(&b->hdr, sizeof b->hdr + b->hdr.count * sizeof(hm_record_t));
    if (b)
        b->hdr.count = 0;
}

// 스레드가 끝날 때 pthread가 불러 준다
static void thread_exit(void *p)
{
    flush(p);
    munmap(p, sizeof(tbuf_t));
    buf = NULL; // 이후 이 스레드에서 또 할당하면 새 버퍼를 만들고, pthread가 이 함수를 다시 부른다
}

// fork한 자식은 부모 버퍼 내용까지 복사해 오므로 그대로 두면 부모 기록이 중복된다. 자식은 기록하지 않는다.
static void in_child(void)
{
    if (buf)
        buf->hdr.count = 0;
    fd = -1;
}

static void init(void)
{
    initializing = 1;
    real_malloc = dlsym(RTLD_NEXT, "malloc");
    real_free = dlsym(RTLD_NEXT, "free");
    real_calloc = dlsym(RTLD_NEXT, "calloc");
    real_realloc = dlsym(RTLD_NEXT, "realloc");
    initializing = 0;

    char *path = getenv("HEAPMAP_OUT");
    // `LD_PRELOAD=... uftrace record ./prog`로 함께 쓸 때 uftrace 자신도 이 라이브러리를 싣는다.
    // uftrace는 기록하지 않고 HEAPMAP_OUT도 숨기지 않아 대상 프로그램에 넘긴다
    if (!path || strcmp(program_invocation_short_name, "uftrace") == 0)
        return;
    fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND | O_CLOEXEC, 0644);
    // exec된 자식도 LD_PRELOAD를 물려받는다. 그대로 두면 자식이 같은 파일을 O_TRUNC로 열어 부모 기록을 지운다.
    // 환경 문자열 "HEAPMAP_OUT=..."의 첫 글자를 바꿔 자식에게는 안 보이게 한다 (제자리 수정이라 malloc 없음).
    // ponytail: 자식 프로세스는 기록하지 않는다. 필요하면 HEAPMAP_OUT에 %p(pid)를 넣어 프로세스별 파일로
    path[-(int)sizeof("HEAPMAP_OUT=") + 1] = '_';
    hm_header_t h = {.magic = HM_MAGIC, .version = HM_VERSION, .rec_size = sizeof(hm_record_t), .pid = getpid()};
    if (fd >= 0)
        write_all(&h, sizeof h);
    pthread_key_create(&key, thread_exit);
    pthread_atfork(NULL, NULL, in_child);
}

static uint64_t now(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts); // uftrace와 같은 시계
    return (uint64_t)ts.tv_sec * 1000000000u + ts.tv_nsec;
}

// 레코드를 40바이트에서 16바이트로 줄였다(tid는 묶음 머리로, 시각은 묶음 기준 차이로, type은 주소 위 8비트로).
// 이벤트당 비용의 절반 가까이가 쓰는 바이트 수에 비례했다. write 횟수를 1/16로 줄여도 효과가 없었다 (BENCH.md)
static void record(uint64_t ts, uint8_t type, void *addr, size_t size)
{
    if (fd < 0)
        return;
    if (!my_tid)
        my_tid = gettid();
    hm_record_t r = {
        .size = size > UINT32_MAX ? UINT32_MAX : (uint32_t)size,
        .addr_type = ((uint64_t)addr & ((1ull << HM_ADDR_BITS) - 1)) | (uint64_t)type << HM_ADDR_BITS,
    };
    if (direct) {
        struct { hm_block_t h; hm_record_t r; } one = {{my_tid, 1, ts}, r};
        write_all(&one, sizeof one);
        return;
    }
    if (!buf) {
        void *m = mmap(NULL, sizeof(tbuf_t), PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (m == MAP_FAILED)
            return;
        buf = m;
        buf->hdr.tid = my_tid;
        pthread_setspecific(key, buf);
    }
    hm_block_t *h = &buf->hdr;
    if (h->count && (ts < h->base_ts || ts - h->base_ts > UINT32_MAX))
        flush(buf); // dt가 u32에 안 들어가면(4.29초 넘게 쉬었다 등) 새 묶음
    if (!h->count)
        h->base_ts = ts;
    r.dt = (uint32_t)(ts - h->base_ts);
    buf->recs[h->count++] = r;
    if (h->count == BUF_RECS)
        flush(buf);
}

// 프로세스 종료 시 호출한 스레드(보통 메인)의 버퍼를 비운다.
// ponytail: 종료 시점에 아직 돌고 있는 다른 스레드의 버퍼는 잃는다. 필요하면 전역 버퍼 목록을 두고 전부 플러시
__attribute__((destructor)) static void at_exit(void)
{
    flush(buf);
    direct = 1; // 이 뒤로 오는 free(다른 소멸자들)는 바로 쓴다
}

__attribute__((constructor)) static void at_start(void)
{
    if (!real_malloc)
        init();
}

void *malloc(size_t size)
{
    if (!real_malloc) {
        if (initializing)
            return boot_alloc(size);
        init();
    }
    if (in_hook)
        return real_malloc(size);
    in_hook = 1;
    void *p = real_malloc(size);
    record(now(), HM_MALLOC, p, size);
    in_hook = 0;
    return p;
}

void *calloc(size_t n, size_t size)
{
    if (!real_calloc) {
        if (initializing)
            return boot_alloc(n * size); // boot는 정적 배열이라 이미 0으로 채워져 있다
        init();
    }
    if (in_hook)
        return real_calloc(n, size);
    in_hook = 1;
    void *p = real_calloc(n, size);
    record(now(), HM_CALLOC, p, n * size);
    in_hook = 0;
    return p;
}

void *realloc(void *old, size_t size)
{
    if (is_boot(old)) { // 초기화 중에 준 블록: 진짜 malloc으로 옮긴다
        void *p = malloc(size);
        size_t had = *(size_t *)((char *)old - 16);
        if (p)
            memcpy(p, old, had < size ? had : size);
        return p;
    }
    if (!real_realloc) {
        if (initializing)
            return boot_alloc(size);
        init();
    }
    if (in_hook)
        return real_realloc(old, size);
    in_hook = 1;
    void *p = real_realloc(old, size);
    uint64_t ts = now();
    // 실패(NULL인데 size > 0)면 원래 블록은 그대로 살아 있다. realloc(p, 0)은 p를 놓고 NULL을 준다
    if (old && (p || !size))
        record(ts, HM_REALLOC_OLD, old, 0);
    if (p)
        record(ts, HM_REALLOC, p, size);
    in_hook = 0;
    return p;
}

void free(void *p)
{
    if (is_boot(p))
        return;
    if (!real_free) {
        if (initializing)
            return;
        init();
    }
    if (in_hook) {
        real_free(p);
        return;
    }
    in_hook = 1;
    // 시각은 해제 전에 잰다. 해제 뒤에 재면 그 사이 다른 스레드가 같은 주소를 받아 먼저 기록할 수 있어
    // 로그에서 '할당 → 해제' 순서가 뒤집힌다. (할당은 반대로 받은 뒤에 잰다)
    uint64_t ts = now();
    real_free(p);
    record(ts, HM_FREE, p, 0);
    in_hook = 0;
}

// exit()를 거치지 않고 끝나거나(_exit: dash 등 셸이 이렇게 끝난다) 프로세스를 갈아치우면(execve)
// destructor가 불리지 않아 버퍼에 모아 둔 레코드가 사라진다. 그 직전에 비운다.
// ponytail: 부른 스레드의 버퍼만 비운다. 다른 스레드 버퍼까지 필요하면 전역 버퍼 목록을 둔다
void _exit(int status)
{
    flush(buf);
    ((void (*)(int))dlsym(RTLD_NEXT, "_exit"))(status);
    __builtin_unreachable();
}

void _Exit(int status)
{
    flush(buf);
    ((void (*)(int))dlsym(RTLD_NEXT, "_Exit"))(status);
    __builtin_unreachable();
}

int execve(const char *path, char *const argv[], char *const envp[])
{
    flush(buf);
    return ((int (*)(const char *, char *const[], char *const[]))dlsym(RTLD_NEXT, "execve"))(path, argv, envp);
}
