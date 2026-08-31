#include "common.h"

int main(void) {
    const char *address = getenv_or("REMOTE_ADDR", "");

    printf("Cache-Control: no-cache\n");
    printf("Content-Type: application/json\n\n");

    printf("{\"title\": \"Hello, C! - Shekar Krishnamoorthy\", ");
    printf("\"heading\": \"Hello, C! - Shekar Krishnamoorthy\", ");
    printf("\"message\": \"This page was generated with the C programming language\", ");
    printf("\"time\": \"");
    print_current_time();
    printf("\", \"IP\": \"");
    print_json_escaped(address);
    printf("\"}\n");
    return 0;
}
