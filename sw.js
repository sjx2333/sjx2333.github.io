const CACHE_NAME = "kotoba-question-bank-v3";
const APP_SHELL = [
    "./",
    "./index.html",
    "./bank.html",
    "./bank.css",
    "./bank.js",
    "./style.css",
    "./effects.js",
    "./manifest.webmanifest",
    "./logo_icon.png",
    "./question_banks/n3.json",
    "./question_banks/n2.json",
];

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(
            keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        )),
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.pathname.includes("/api/")) return;

    event.respondWith(
        caches.match(request).then((cached) => cached || fetch(request).then((response) => {
            if (response.ok && url.origin === self.location.origin) {
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
        })),
    );
});
