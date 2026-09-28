CFLAGS = -O2 -g -Wall -Wextra -fPIC

libheapmap.so: heapmap.c heapmap.h
	$(CC) $(CFLAGS) -shared -o $@ heapmap.c -ldl -lpthread

test_mt: test_mt.c
	# -fno-builtin: 없으면 gcc가 밖으로 새지 않는 malloc/free 쌍을 통째로 지워서 호출 수가 안 맞는다
	$(CC) -O1 -g -Wall -fno-builtin -o $@ $< -lpthread

# 스레드 8개 × 반복 20000번. 표식 크기로 테스트 자신의 호출만 골라 개수를 맞춘다
check: libheapmap.so test_mt
	LD_PRELOAD=./libheapmap.so HEAPMAP_OUT=test.bin ./test_mt 8 20000
	python3 heapdump.py test.bin --check 8 20000

clean:
	rm -f libheapmap.so test_mt *.bin

.PHONY: check clean
