#include "common.h"
#include <unistd.h>

#define MAX_PAIRS 64

typedef struct {
    char key[256];
    char value[1024];
} Pair;

static Pair pairs[MAX_PAIRS];
static int pair_count = 0;

static void add_pair(const char *key, size_t key_len, const char *value, size_t value_len) {
    if (pair_count >= MAX_PAIRS) return;
    if (key_len >= sizeof pairs[0].key) key_len = sizeof(pairs[0].key) - 1;
    if (value_len >= sizeof pairs[0].value) value_len = sizeof(pairs[0].value) - 1;
    memcpy(pairs[pair_count].key, key, key_len);
    pairs[pair_count].key[key_len] = '\0';
    memcpy(pairs[pair_count].value, value, value_len);
    pairs[pair_count].value[value_len] = '\0';
    pair_count++;
}

/* Parses application/x-www-form-urlencoded data: a=1&b=2 */
static void parse_urlencoded(char *data) {
    char *saveptr;
    for (char *tok = strtok_r(data, "&", &saveptr); tok; tok = strtok_r(NULL, "&", &saveptr)) {
        char *eq = strchr(tok, '=');
        if (eq) {
            *eq = '\0';
            url_decode_inplace(tok);
            url_decode_inplace(eq + 1);
            add_pair(tok, strlen(tok), eq + 1, strlen(eq + 1));
        } else {
            url_decode_inplace(tok);
            add_pair(tok, strlen(tok), "", 0);
        }
    }
}

/* Minimal parser for a flat JSON object of string/number values, e.g.
 * {"a": "1", "b": 2}. Good enough for this demo's form data; does not
 * support nested objects/arrays. */
static void parse_flat_json(const char *data) {
    const char *p = data;
    while (*p && *p != '{') p++;
    if (*p != '{') return;
    p++;

    while (*p) {
        while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r' || *p == ',') p++;
        if (*p == '}' || !*p) break;
        if (*p != '"') break;
        p++;
        const char *key_start = p;
        while (*p && *p != '"') p++;
        size_t key_len = (size_t)(p - key_start);
        if (*p == '"') p++;

        while (*p == ' ' || *p == ':') p++;

        const char *val_start;
        size_t val_len;
        if (*p == '"') {
            p++;
            val_start = p;
            while (*p && *p != '"') {
                if (*p == '\\' && p[1]) p++;
                p++;
            }
            val_len = (size_t)(p - val_start);
            if (*p == '"') p++;
        } else {
            val_start = p;
            while (*p && *p != ',' && *p != '}') p++;
            val_len = (size_t)(p - val_start);
            while (val_len > 0 && (val_start[val_len - 1] == ' ')) val_len--;
        }
        add_pair(key_start, key_len, val_start, val_len);
    }
}

int main(void) {
    const char *method = getenv_or("REQUEST_METHOD", "GET");
    const char *content_type = getenv_or("CONTENT_TYPE", "");
    const char *query_string = getenv_or("QUERY_STRING", "");
    const char *content_length_s = getenv_or("CONTENT_LENGTH", "0");
    long content_length = atol(content_length_s);

    const char *source = "";

    if ((strcmp(method, "POST") == 0 || strcmp(method, "PUT") == 0) && content_length > 0) {
        char *body = read_stdin_body(content_length);
        if (body) {
            source = "request body";
            if (strstr(content_type, "application/json")) {
                parse_flat_json(body);
            } else {
                parse_urlencoded(body);
            }
        }
    } else if (query_string[0]) {
        char *qs_copy = strdup(query_string);
        source = "query string";
        parse_urlencoded(qs_copy);
        free(qs_copy);
    }

    char hostname[256];
    if (gethostname(hostname, sizeof hostname) != 0) {
        strcpy(hostname, "unknown");
    }

    printf("Cache-Control: no-cache\n");
    printf("Content-Type: text/html\n\n");

    printf("<!DOCTYPE html>\n");
    printf("<html><head><title>Echo - C - Shekar Krishnamoorthy</title></head>\n");
    printf("<body><h1 align=\"center\">Echo Request - C</h1><hr>\n");

    printf("<p><b>HTTP Method:</b> ");
    print_html_escaped(method);
    printf("</p>\n");

    printf("<p><b>Content-Type received:</b> ");
    if (content_type[0]) print_html_escaped(content_type); else printf("(none)");
    printf("</p>\n");

    printf("<p><b>Data source:</b> %s</p>\n", source[0] ? source : "(none)");

    printf("<p><b>Received data:</b></p><ul>\n");
    if (pair_count == 0) {
        printf("<li>(nothing received)</li>\n");
    } else {
        for (int i = 0; i < pair_count; i++) {
            printf("<li>");
            print_html_escaped(pairs[i].key);
            printf(" = ");
            print_html_escaped(pairs[i].value);
            printf("</li>\n");
        }
    }
    printf("</ul>\n");

    printf("<p><b>Server hostname:</b> ");
    print_html_escaped(hostname);
    printf("</p>\n");

    printf("<p><b>Date/time:</b> ");
    print_current_time();
    printf("</p>\n");

    printf("<p><b>User-Agent:</b> ");
    print_html_escaped(getenv_or("HTTP_USER_AGENT", ""));
    printf("</p>\n");

    printf("<p><b>Your IP Address:</b> ");
    print_html_escaped(getenv_or("REMOTE_ADDR", ""));
    printf("</p>\n");

    printf("</body></html>\n");
    return 0;
}
