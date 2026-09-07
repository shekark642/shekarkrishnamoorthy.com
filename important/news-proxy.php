<?php
// Same-origin relay for NewsAPI.org's top-headlines endpoint. The browser only ever
// talks to this same-origin script, so there's no CORS problem to solve client-side,
// and the API key never reaches the page's JS.
header('Content-Type: application/json');

$apiKey = '890434a0b66748c9b504cc28df6511ff';
$category = isset($_GET['category']) ? $_GET['category'] : '';

$allowed = ['', 'business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'];
if (!in_array($category, $allowed, true)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid category']);
    exit;
}

$url = 'https://newsapi.org/v2/top-headlines?country=us&apiKey=' . urlencode($apiKey);
if ($category !== '') {
    $url .= '&category=' . urlencode($category);
}

$context = stream_context_create(['http' => ['timeout' => 10]]);
$response = @file_get_contents($url, false, $context);

if ($response === false) {
    http_response_code(502);
    echo json_encode(['error' => 'upstream request failed']);
    exit;
}

echo $response;
