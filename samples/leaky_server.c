// 일부러 느리고, 메모리가 새고, 힙을 단편화하는 가짜 서버.
// 심어 둔 문제 (뷰어에서 찾아야 할 정답):
//   느린 함수 1: checksum()      — 바이트마다 앞부분을 다시 훑는 O(n^2)
//   느린 함수 2: lookup_route()  — 정렬된 테이블을 선형 탐색 + 매번 strcmp
//   누수      : parse_request() — 요청마다 header 사본을 malloc하고 free하지 않음
//   단편화    : cache_put()     — 크고 작은 블록을 번갈아 할당하고 작은 것만 해제
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NOINLINE __attribute__((noinline))

enum { N_ROUTES = 20000, N_CACHE = 512 };

static char routes[N_ROUTES][32];

typedef struct {
    char *method, *path, *header;
} request_t;

typedef struct {
    void *slots[N_CACHE];
    int n;
} cache_t;

static NOINLINE unsigned checksum(const char *buf, size_t len)
{
    unsigned sum = 0;
    for (size_t i = 0; i < len; i++)
        for (size_t j = 0; j <= i; j++)
            sum = sum * 31 + (unsigned char)buf[j];
    return sum;
}

static NOINLINE int lookup_route(const char *path)
{
    for (int i = 0; i < N_ROUTES; i++)
        if (strcmp(routes[i], path) == 0)
            return i;
    return -1;
}

static NOINLINE char *dup_token(const char *s, size_t n)
{
    char *p = malloc(n + 1);
    memcpy(p, s, n);
    p[n] = '\0';
    return p;
}

static NOINLINE void parse_request(const char *raw, request_t *req)
{
    const char *sp1 = strchr(raw, ' ');
    const char *sp2 = strchr(sp1 + 1, ' ');
    req->method = dup_token(raw, sp1 - raw);
    req->path = dup_token(sp1 + 1, sp2 - sp1 - 1);
    req->header = dup_token(sp2 + 1, strlen(sp2 + 1)); // 누수: 아무도 free하지 않는다
}

static NOINLINE void free_request(request_t *req)
{
    free(req->method);
    free(req->path);
    // BUG(의도적): free(req->header) 누락
}

static NOINLINE void cache_put(cache_t *c, unsigned key)
{
    if (c->n + 2 > N_CACHE)
        return;
    void *big = malloc(256 + key % 1024);
    void *small = malloc(16 + key % 48);
    c->slots[c->n++] = big;
    free(small); // 큰 블록 사이에 작은 구멍만 남는다
}

static NOINLINE void cache_clear(cache_t *c)
{
    for (int i = 0; i < c->n; i++)
        free(c->slots[i]);
    c->n = 0;
}

static NOINLINE unsigned handle_request(const char *raw, cache_t *cache)
{
    request_t req;
    parse_request(raw, &req);
    int route = lookup_route(req.path);
    unsigned sum = checksum(req.header, strlen(req.header));
    cache_put(cache, sum ^ (unsigned)route);
    free_request(&req);
    return sum;
}

static void *worker(void *arg)
{
    int id = (int)(long)arg;
    int n_req = 2000;
    cache_t cache = {0};
    unsigned acc = 0;
    char raw[1024], pad[512];
    memset(pad, '.', sizeof pad);

    for (int i = 0; i < n_req; i++) {
        snprintf(raw, sizeof raw, "GET /api/v1/item/%d X-Worker:%d;X-Seq:%d;padding=%.*s",
                 (i * 7919 + id) % N_ROUTES, id, i, i % 512, pad);
        acc += handle_request(raw, &cache);
    }
    cache_clear(&cache);
    return (void *)(long)acc;
}

int main(int argc, char **argv)
{
    int n_threads = argc > 1 ? atoi(argv[1]) : 2;
    pthread_t th[16];
    if (n_threads < 1 || n_threads > 16)
        n_threads = 2;

    for (int i = 0; i < N_ROUTES; i++)
        snprintf(routes[i], sizeof routes[i], "/api/v1/item/%d", i);

    for (long i = 0; i < n_threads; i++)
        pthread_create(&th[i], NULL, worker, (void *)i);
    unsigned total = 0;
    for (int i = 0; i < n_threads; i++) {
        void *r;
        pthread_join(th[i], &r);
        total += (unsigned)(long)r;
    }
    printf("done: %d threads, checksum %u\n", n_threads, total);
    return 0;
}
