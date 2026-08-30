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

## Obscuring server identity

**Goal:** change the `Server:` response header from `Apache/2.4.58 (Ubuntu)` to `CSE135 Server`.

**What didn't work (the obvious approach):** enabling `mod_headers` and adding `Header always set Server CSE135 Server`. This loaded without error and passed `apache2ctl configtest`, but had **zero effect** — every response still returned `Server: Apache/2.4.58 (Ubuntu)`, including on 404 error pages, even after a full `systemctl restart apache2`. This is because Apache's core sets the `Server` header *after* `mod_headers`' output filter runs, so mod_headers' value is silently overwritten every time. Verified this failure directly with `curl -I` before moving on, rather than assuming it worked.

**What actually worked:** installing `libapache2-mod-security2` and using its dedicated `SecServerSignature` directive, which operates at a lower level specifically built for rewriting this header:

- Set `SecServerSignature CSE135 Server` in `/etc/modsecurity/modsecurity.conf`
- Set `ServerTokens Full` (required — ModSecurity needs Apache to generate its most verbose banner first, so it has a complete string to overwrite)
- Set `SecRuleEngine Off` — only the header-rewrite behavior is used here; ModSecurity's actual Web Application Firewall rule engine is intentionally left off for now, since enabling real WAF filtering needs its own deliberate tuning pass to avoid false positives on legitimate traffic

**Related leak fixed at the same time:** Apache's default error pages were also printing the same version info in the page body via `ServerSignature On` (e.g. `Apache/2.4.58 (Ubuntu) Server at shekarkrishnamoorthy.com Port 443` at the bottom of every 404/500 page) — a separate mechanism from the `Server:` header that would have defeated the whole point if left alone. Set `ServerSignature Off` to close this too.

**Also checked:** PHP's `X-Powered-By` header (a common parallel version leak) — already absent, since `expose_php = Off` was already set in `php.ini`.

**Verification** (`curl -I`), confirmed on every response type, including the exact edge case where the naive fix failed:

| Response | Server header |
|---|---|
| Homepage | `CSE135 Server` |
| 404 error page | `CSE135 Server` |
| `hello.php` (PHP-generated) | `CSE135 Server` |

Screenshot of the fetch/DevTools Network tab showing the changed header is included alongside this README.
