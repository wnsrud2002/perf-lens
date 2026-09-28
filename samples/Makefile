CFLAGS = -O1 -g -pg -fno-omit-frame-pointer -Wall -Wextra
LDLIBS = -lpthread
UFTRACE ?= uftrace

leaky_server: leaky_server.c

# --no-libcall: strcmp 등 libc 호출 수천만 건을 빼서 트레이스를 함수 단위로 유지한다
trace.json: leaky_server
	$(UFTRACE) record --no-libcall ./leaky_server
	$(UFTRACE) dump --chrome > $@

clean:
	rm -rf leaky_server uftrace.data* trace.json gmon.out

.PHONY: clean
