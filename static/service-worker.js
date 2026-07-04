const CACHE_NAME = 'newscraft-mobile-v1';
const PRECACHE_URLS = ['/', '/manifest.webmanifest', '/brand/logo-mark.svg', '/brand/logo-wordmark.svg'];

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			await cache.addAll(PRECACHE_URLS);
			await self.skipWaiting();
		})()
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
		return;
	}

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE_NAME);
			const cached = await cache.match(request);
			if (cached) return cached;

			try {
				const response = await fetch(request);
				if (response && response.ok) {
					await cache.put(request, response.clone());
				}
				return response;
			} catch (error) {
				throw error;
			}
		})()
	);
});
