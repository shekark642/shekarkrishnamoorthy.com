CC = gcc
CFLAGS = -std=gnu11 -Wall -Wextra -O2 -Wno-unused-function
TARGETS = hello-html-c hello-json-c environment-c echo-c state-c

.PHONY: all clean
all: $(TARGETS)

%: %.c common.h
	$(CC) $(CFLAGS) -o $@ $<
	chmod 755 $@

clean:
	rm -f $(TARGETS)
