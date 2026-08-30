Hello, this is the github page for shekarkrishnamoorthy.com

Feel free to explore.

## Password-protected area

The `/members` directory on shekarkrishnamoorthy.com is protected with HTTP Basic Authentication over HTTPS.

- URL: https://shekarkrishnamoorthy.com/members/
- Username: shekar
- Password: K6fTCWFCRfhK

## Compression (mod_deflate)

Apache's `mod_deflate` was already installed and enabled on this server, with `/etc/apache2/mods-available/deflate.conf` already configured to compress `text/html`, `text/css`, `text/javascript`, and `application/javascript` (this site's JavaScript is inline in HTML, so it's compressed as part of the document rather than as a separate file).

Verified compression is active:

| File | Content-Type | Uncompressed | Gzip-compressed |
|---|---|---|---|
| `/` (index.html) | text/html | 8,755 bytes | 2,958 bytes |
| `/assets/site-nav.css` | text/css | larger | 434 bytes |

In Chrome DevTools' Network tab, after reloading the page with compression enabled, the document request's **Response Headers** show `content-encoding: gzip`, and the **Size** column shows two numbers instead of one — the actual transferred size (much smaller) alongside the true uncompressed resource size. For the homepage, that's roughly a **66% reduction** in bytes actually sent over the wire, with no visible change to the rendered page.
