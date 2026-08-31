#include "common.h"

int main(void) {
    const char *address = getenv_or("REMOTE_ADDR", "");

    printf("Cache-Control: no-cache\n");
    printf("Content-Type: text/html\n\n");

    printf("<!DOCTYPE html>\n<html>\n");
    printf("<head><title>Hello CGI World - Shekar Krishnamoorthy</title></head>\n");
    printf("<body>\n");
    printf("<h1 align=center>Hello HTML World - Shekar Krishnamoorthy</h1><hr/>\n");
    printf("<p>Hello World, from Shekar Krishnamoorthy</p>\n");
    printf("<p>This page was generated with the C programming language</p>\n");
    printf("<p>This program was generated at: ");
    print_current_time();
    printf("</p>\n");
    printf("<p>Your current IP Address is: ");
    print_html_escaped(address);
    printf("</p>\n");
    printf("</body>\n</html>\n");
    return 0;
}
