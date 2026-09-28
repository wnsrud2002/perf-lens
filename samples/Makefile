CFLAGS = -O1 -g -pg -fno-omit-frame-pointer -Wall -Wextra
LDLIBS = -lpthread
UFTRACE ?= uftrace
HEAPMAP = $(abspath ../heapmap/libheapmap.so)

leaky_server: leaky_server.c

fixed_server: leaky_server.c
	$(CC) $(CFLAGS) -DFIXED -o $@ $< $(LDLIBS)

# 함수 트레이스(trace.json)와 힙 기록(heap.bin)을 한 번 실행으로 함께 남긴다. 둘은 같은 CLOCK_MONOTONIC을 쓴다
# --no-libcall: strcmp 등 libc 호출 수천만 건을 빼서 트레이스를 함수 단위로 유지한다
trace.json: leaky_server $(HEAPMAP)
	LD_PRELOAD=$(HEAPMAP) HEAPMAP_OUT=$(CURDIR)/heap.bin $(UFTRACE) record --no-libcall ./leaky_server
	$(UFTRACE) dump --chrome > $@

# 고친 버전: 전후 비교용 (뷰어의 비교 탭)
trace-fixed.json: fixed_server $(HEAPMAP)
	LD_PRELOAD=$(HEAPMAP) HEAPMAP_OUT=$(CURDIR)/heap-fixed.bin $(UFTRACE) record -d uftrace.data.fixed --no-libcall ./fixed_server
	$(UFTRACE) dump -d uftrace.data.fixed --chrome > $@

$(HEAPMAP):
	$(MAKE) -C ../heapmap libheapmap.so

clean:
	rm -rf leaky_server fixed_server uftrace.data* trace*.json heap*.bin gmon.out

.PHONY: clean
