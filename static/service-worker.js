const CACHE_PREFIX = 'newscraft-';

self.addEventListener('install', (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const cacheNames = await caches.keys();
			await Promise.all(
				cacheNames
					.filter((name) => name.startsWith(CACHE_PREFIX))
					.map((name) => caches.delete(name))
			);
			const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			await Promise.all(clientsList.map((client) => client.navigate(client.url)));
			await self.registration.unregister();
		})()
	);
});
