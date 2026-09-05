<?php
// tracking-pixel.php — Serves a 1x1 transparent GIF and logs the request
// (HW3 Module 03: Server-Log Collection)

// Prevent caching so every page view generates a new request. Without this,
// the browser would serve a cached copy of the image on repeat views and
// no new HTTP request (and no new log entry) would ever fire.
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');

// Serve the smallest valid GIF (43 bytes) - a 1x1 transparent pixel.
header('Content-Type: image/gif');
echo base64_decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');

// Log the hit as one line of JSON. Written OUTSIDE public_html - in a
// directory dedicated to this and owned by www-data - so the raw log
// (visitor IPs, User-Agents) is never web-servable, and survives the
// deploy pipeline's `rsync --delete` into public_html on the next push.
$data = [
    'timestamp' => date('c'),
    'ip'        => $_SERVER['REMOTE_ADDR'] ?? '',
    'ua'        => $_SERVER['HTTP_USER_AGENT'] ?? '',
    'referer'   => $_SERVER['HTTP_REFERER'] ?? '',
    'page'      => $_GET['page'] ?? '',
    'type'      => $_GET['t'] ?? 'pageview',
    'language'  => $_SERVER['HTTP_ACCEPT_LANGUAGE'] ?? '',
];

$logFile = dirname(__DIR__) . '/pixel-logs/pixel-hits.jsonl';
file_put_contents($logFile, json_encode($data) . "\n", FILE_APPEND | LOCK_EX);
