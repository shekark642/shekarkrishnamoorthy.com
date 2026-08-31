#include "common.h"
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#define SESSION_DIR "/tmp/hw2-sessions"
#define SESSION_ID_LEN 32

static int is_hex_lower(char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

/* Only ever accepts our own secrets.token_hex-shaped output as a session id,
 * so a hostile cookie value can never be turned into a path outside
 * SESSION_DIR (no '..', no '/', fixed length, fixed alphabet). */
static int valid_session_id(const char *id) {
    if (!id) return 0;
    size_t len = strlen(id);
    if (len != SESSION_ID_LEN) return 0;
    for (size_t i = 0; i < len; i++) {
        if (!is_hex_lower(id[i])) return 0;
    }
    return 1;
}

static void generate_session_id(char out[SESSION_ID_LEN + 1]) {
    unsigned char raw[SESSION_ID_LEN / 2];
    int fd = open("/dev/urandom", O_RDONLY);
    if (fd >= 0) {
        if (read(fd, raw, sizeof raw) != (ssize_t)sizeof raw) {
            for (size_t i = 0; i < sizeof raw; i++) raw[i] = (unsigned char)(rand() & 0xFF);
        }
        close(fd);
    } else {
        for (size_t i = 0; i < sizeof raw; i++) raw[i] = (unsigned char)(rand() & 0xFF);
    }
    for (size_t i = 0; i < sizeof raw; i++) {
        sprintf(out + i * 2, "%02x", raw[i]);
    }
    out[SESSION_ID_LEN] = '\0';
}

static char *extract_cookie_value(const char *cookie_header, const char *name) {
    if (!cookie_header) return NULL;
    char *copy = strdup(cookie_header);
    char *saveptr;
    char *result = NULL;
    for (char *tok = strtok_r(copy, ";", &saveptr); tok; tok = strtok_r(NULL, ";", &saveptr)) {
        while (*tok == ' ') tok++;
        size_t name_len = strlen(name);
        if (strncmp(tok, name, name_len) == 0 && tok[name_len] == '=') {
            result = strdup(tok + name_len + 1);
            break;
        }
    }
    free(copy);
    return result;
}

static void parse_urlencoded_simple(char *data, char **out_action, char **out_value) {
    char *saveptr;
    for (char *tok = strtok_r(data, "&", &saveptr); tok; tok = strtok_r(NULL, "&", &saveptr)) {
        char *eq = strchr(tok, '=');
        if (!eq) continue;
        *eq = '\0';
        url_decode_inplace(tok);
        url_decode_inplace(eq + 1);
        if (strcmp(tok, "action") == 0) *out_action = strdup(eq + 1);
        else if (strcmp(tok, "value") == 0) *out_value = strdup(eq + 1);
    }
}

int main(void) {
    mkdir(SESSION_DIR, 0700);

    char *cookie_id = extract_cookie_value(getenv("HTTP_COOKIE"), "hw2_session");
    char session_id[SESSION_ID_LEN + 1];
    int is_new = 0;

    if (cookie_id && valid_session_id(cookie_id)) {
        strcpy(session_id, cookie_id);
    } else {
        srand((unsigned)time(NULL) ^ (unsigned)getpid());
        generate_session_id(session_id);
        is_new = 1;
    }
    free(cookie_id);

    char session_file[512];
    snprintf(session_file, sizeof session_file, "%s/c-%s", SESSION_DIR, session_id);

    const char *method = getenv_or("REQUEST_METHOD", "GET");
    long content_length = atol(getenv_or("CONTENT_LENGTH", "0"));

    if (strcmp(method, "POST") == 0 && content_length > 0) {
        char *body = read_stdin_body(content_length);
        if (body) {
            char *action = NULL, *value = NULL;
            parse_urlencoded_simple(body, &action, &value);
            if (action && strcmp(action, "clear") == 0) {
                unlink(session_file);
            } else if (value) {
                FILE *f = fopen(session_file, "w");
                if (f) {
                    fputs(value, f);
                    fclose(f);
                }
            }
            free(action);
            free(value);
            free(body);
        }
    }

    char saved_value[512] = "";
    FILE *f = fopen(session_file, "r");
    if (f) {
        size_t n = fread(saved_value, 1, sizeof saved_value - 1, f);
        saved_value[n] = '\0';
        fclose(f);
    }

    printf("Cache-Control: no-cache\n");
    if (is_new) {
        printf("Set-Cookie: hw2_session=%s; Path=/; HttpOnly; SameSite=Lax\n", session_id);
    }
    printf("Content-Type: text/html\n\n");

    printf("<!DOCTYPE html>\n");
    printf("<html><head><title>State - C - Shekar Krishnamoorthy</title></head>\n");
    printf("<body><h1 align=\"center\">Server-Side State - C</h1><hr>\n");

    if (saved_value[0]) {
        printf("<p><b>Currently saved value:</b> ");
        print_html_escaped(saved_value);
        printf("</p>\n");
    } else {
        printf("<p><b>Currently saved value:</b> (nothing saved yet)</p>\n");
    }

    printf("<form method=\"POST\">\n");
    printf("<input type=\"text\" name=\"value\" placeholder=\"Enter a value\" maxlength=\"500\">\n");
    printf("<button type=\"submit\">Save</button>\n");
    printf("</form>\n");
    printf("<form method=\"POST\" style=\"margin-top:10px\">\n");
    printf("<input type=\"hidden\" name=\"action\" value=\"clear\">\n");
    printf("<button type=\"submit\">Clear</button>\n");
    printf("</form>\n");

    printf("<p style='margin-top:20px;color:#666'>Session ID: ");
    print_html_escaped(session_id);
    printf("</p>\n");
    printf("<p>Reload this page after saving a value &mdash; it persists across separate requests via a server-side file keyed by your session cookie, not via localStorage.</p>\n");

    printf("</body></html>\n");
    return 0;
}
