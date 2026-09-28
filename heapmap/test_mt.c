// libheapmap 검증용: 스레드 T개가 N번씩 malloc/calloc/realloc/free를 부른다.
// 크기를 7001~7008 / 7101 / 7201로 정해 두어 libc 내부 할당과 구분한다 (heapdump.py --check).
// 호출 수(스레드당): malloc N, calloc N, realloc N, free 2N. 그 밖에 main에서 실패하는 realloc 한 번
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int n_iter;

static void *worker(void *arg)
{
    (void)arg;
    for (int i = 0; i < n_iter; i++) {
        char *p = malloc(7001 + i % 8);
        char *q = calloc(1, 7101);
        q = realloc(q, 7201);
        p[0] = q[0] = 1; // 최적화로 할당이 사라지지 않게
        free(p);
        free(q);
    }
    return NULL;
}

int main(int argc, char **argv)
{
    int n_threads = argc > 1 ? atoi(argv[1]) : 4;
    n_iter = argc > 2 ? atoi(argv[2]) : 10000;
    pthread_t th[64];
    if (n_threads > 64)
        n_threads = 64;
    // 실패하는 realloc은 원래 블록을 건드리지 않는다: 기록에서도 7301 블록이 free까지 살아 있어야 한다
    char *keep = malloc(7301);
    if (realloc(keep, (size_t)1 << 62) != NULL)
        return 1;
    free(keep);
    for (int i = 0; i < n_threads; i++)
        pthread_create(&th[i], NULL, worker, NULL);
    for (int i = 0; i < n_threads; i++)
        pthread_join(th[i], NULL);
    printf("threads %d x iter %d: malloc %d, calloc %d, realloc %d, free %d\n", n_threads, n_iter,
           n_threads * n_iter, n_threads * n_iter, n_threads * n_iter, 2 * n_threads * n_iter);
    return 0;
}
