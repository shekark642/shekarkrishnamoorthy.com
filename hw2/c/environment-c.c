#include "common.h"

extern char **environ;

static int compare_env(const void *a, const void *b) {
    return strcmp(*(const char **)a, *(const char **)b);
}

int main(void) {
    printf("Cache-Control: no-cache\n");
    printf("Content-Type: text/html\n\n");

    printf("<!DOCTYPE html>\n");
    printf("<html><head><title>Environment Variables - C - Shekar Krishnamoorthy</title></head>\n");
    printf("<body><h1 align=\"center\">Environment Variables - C - Shekar Krishnamoorthy</h1><hr>\n");

    int count = 0;
    while (environ[count]) count++;

    char **sorted = malloc((size_t)count * sizeof(char *));
    if (!sorted) return 1;
    memcpy(sorted, environ, (size_t)count * sizeof(char *));
    qsort(sorted, (size_t)count, sizeof(char *), compare_env);

    for (int i = 0; i < count; i++) {
        const char *eq = strchr(sorted[i], '=');
        if (!eq) continue;
        size_t key_len = (size_t)(eq - sorted[i]);
        char *key = malloc(key_len + 1);
        if (!key) continue;
        memcpy(key, sorted[i], key_len);
        key[key_len] = '\0';

        printf("<b>");
        print_html_escaped(key);
        printf(":</b> ");
        print_html_escaped(eq + 1);
        printf("<br />\n");

        free(key);
    }

    free(sorted);
    printf("</body></html>\n");
    return 0;
}
