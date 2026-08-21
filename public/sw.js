const CACHE = "mbox-shell-v1";
const SHELL = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

// Кэшируем только манифест и иконки — статика, которая почти не меняется. JS/CSS-бандл,
// HTML и API сознательно не трогаем: приложение деплоится часто и живёт свежими данными
// (авторизация, реал-тайм), кэш тут дал бы витающую по клиентам устаревшую сборку.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
  }
});
