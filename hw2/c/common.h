#ifndef HW2_COMMON_H
#define HW2_COMMON_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <time.h>

/* Writes s to stdout with &<>"' escaped, so nothing attacker-controlled
 * (query strings, form fields, headers like User-Agent) can break out of
 * the surrounding HTML. */
static void print_html_escaped(const char *s) {
    if (!s) return;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
            case '&': fputs("&amp;", stdout); break;
            case '<': fputs("&lt;", stdout); break;
            case '>': fputs("&gt;", stdout); break;
            case '"': fputs("&quot;", stdout); break;
            case '\'': fputs("&#39;", stdout); break;
            default: fputc(*p, stdout);
        }
    }
}

/* Minimal JSON string escaping for the flat key/value shapes these demos use. */
static void print_json_escaped(const char *s) {
    if (!s) return;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (*p < 0x20) printf("\\u%04x", *p);
                else fputc(*p, stdout);
        }
    }
}

static const char *getenv_or(const char *name, const char *fallback) {
    const char *v = getenv(name);
    return v ? v : fallback;
}

static char hex_to_char(char h, char l) {
    int hi = isdigit(h) ? h - '0' : tolower(h) - 'a' + 10;
    int lo = isdigit(l) ? l - '0' : tolower(l) - 'a' + 10;
    return (char)((hi << 4) | lo);
}

/* Decodes application/x-www-form-urlencoded in place; safe since decoding
 * only ever shrinks the string. */
static void url_decode_inplace(char *s) {
    char *w = s;
    for (char *r = s; *r; r++) {
        if (*r == '+') {
            *w++ = ' ';
        } else if (*r == '%' && isxdigit((unsigned char)r[1]) && isxdigit((unsigned char)r[2])) {
            *w++ = hex_to_char(r[1], r[2]);
            r += 2;
        } else {
            *w++ = *r;
        }
    }
    *w = '\0';
}

static char *read_stdin_body(long content_length) {
    if (content_length <= 0) return NULL;
    char *buf = malloc((size_t)content_length + 1);
    if (!buf) return NULL;
    size_t read_total = fread(buf, 1, (size_t)content_length, stdin);
    buf[read_total] = '\0';
    return buf;
}

static void print_current_time(void) {
    time_t now = time(NULL);
    char buf[64];
    struct tm tmv;
    localtime_r(&now, &tmv);
    strftime(buf, sizeof buf, "%a %b %d %H:%M:%S %Y", &tmv);
    fputs(buf, stdout);
}

#endif
