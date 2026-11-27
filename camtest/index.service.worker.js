// This service worker is required to expose an exported Godot project as a
// Progressive Web App. It provides an offline fallback page telling the user
// that they need an Internet connection to run the project if desired.
// Incrementing CACHE_VERSION will kick off the install event and force
// previously cached resources to be updated from the network.
/** @type {string} */
const CACHE_VERSION = '1795818456|1480646';
/** @type {string} */
const CACHE_PREFIX = 'Glade (3D protot-sw-cache-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
/** @type {string} */
const OFFLINE_URL = 'index.offline.html';
/** @type {boolean} */
const ENSURE_CROSSORIGIN_ISOLATION_HEADERS = false;
// Files that will be cached on load.
/** @type {string[]} */
const CACHED_FILES = ["index.html","index.js","index.offline.html","index.icon.png","index.apple-touch-icon.png","index.audio.worklet.js","index.audio.position.worklet.js"];
// Files that we might not want the user to preload, and will only be cached on first load.
/** @type {string[]} */
const CACHEABLE_FILES = ["index.wasm","index.pck"];
const FULL_CACHE = CACHED_FILES.concat(CACHEABLE_FILES);
// (deploy_web.py) The engine's own cache, named by its content: kept from deploy to deploy.
const ENGINE_CACHE = CACHE_PREFIX + 'engine-41560f8755ed1302';
const ENGINE_FILES = FULL_CACHE.filter((f) => /\.(wasm|js)$/.test(f) && !f.endsWith('.service.worker.js'));
const isEngineFile = (r) => ENGINE_FILES.some((f) => (typeof r === 'string' ? r === f : r.url.endsWith('/' + f)));
// A streamed world's chunk files (chunks/<content hash>.bin): they never change, so they're kept
// from deploy to deploy in a cache of their own.
const CHUNK_CACHE = CACHE_PREFIX + 'chunks';
const isChunkFile = (r) => /(^|\/)chunks\/[0-9a-f]+\.bin$/.test(typeof r === 'string' ? r : r.url);
async function openCaches() {
	const main = await caches.open(CACHE_NAME);
	const engine = await caches.open(ENGINE_CACHE);
	const chunks = await caches.open(CHUNK_CACHE);
	const which = (r) => (isEngineFile(r) ? engine : (isChunkFile(r) ? chunks : main));
	return {
		match: (r) => which(r).match(r),
		put: (r, response) => which(r).put(r, response),
	};
}

self.addEventListener('install', (event) => {
	self.skipWaiting();
	event.waitUntil((async () => {
		const main = await caches.open(CACHE_NAME);
		const engine = await caches.open(ENGINE_CACHE);
		const fresh = (f) => new Request(f, { cache: 'no-cache' });
		const preload = ENGINE_FILES.filter((f) => CACHED_FILES.includes(f));
		const have = await Promise.all(preload.map((f) => engine.match(f)));
		await engine.addAll(preload.filter((f, i) => !have[i]).map(fresh));
		await main.addAll(CACHED_FILES.filter((f) => !ENGINE_FILES.includes(f)).map(fresh));
	})());
});

self.addEventListener('activate', (event) => {
	event.waitUntil(caches.keys().then(async (keys) => {
		// Remove old caches. If there were any, this is a new build: take over the open game and
		// reload it, so it doesn't keep running the old one.
		const old = keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME && key !== ENGINE_CACHE && key !== CHUNK_CACHE);
		await Promise.all(old.map((key) => caches.delete(key)));
		await self.clients.claim();
		if ('navigationPreload' in self.registration) {
			await self.registration.navigationPreload.enable();
		}
		if (old.length > 0) {
			const windows = await self.clients.matchAll({ type: 'window' });
			windows.forEach((client) => client.navigate && client.navigate(client.url).catch(() => {}));
		}
	}));
});

/**
 * Ensures that the response has the correct COEP/COOP headers
 * @param {Response} response
 * @returns {Response}
 */
function ensureCrossOriginIsolationHeaders(response) {
	if (response.headers.get('Cross-Origin-Embedder-Policy') === 'require-corp'
		&& response.headers.get('Cross-Origin-Opener-Policy') === 'same-origin') {
		return response;
	}

	const crossOriginIsolatedHeaders = new Headers(response.headers);
	crossOriginIsolatedHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
	crossOriginIsolatedHeaders.set('Cross-Origin-Opener-Policy', 'same-origin');
	const newResponse = new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: crossOriginIsolatedHeaders,
	});

	return newResponse;
}

/**
 * Calls fetch and cache the result if it is cacheable
 * @param {FetchEvent} event
 * @param {Cache} cache
 * @param {boolean} isCacheable
 * @returns {Response}
 */
async function fetchAndCache(event, cache, isCacheable) {
	// Use the preloaded response, if it's there
	/** @type { Response } */
	let response = await event.preloadResponse;
	if (response == null) {
		// Or, go over network.
		response = await self.fetch(event.request.mode === 'navigate' ? event.request : new Request(event.request, { cache: 'no-cache' }));
	}

	if (ENSURE_CROSSORIGIN_ISOLATION_HEADERS) {
		response = ensureCrossOriginIsolationHeaders(response);
	}

	if (isCacheable && response.ok) {
		// And update the cache
		cache.put(event.request, response.clone());
	}

	return response;
}

self.addEventListener(
	'fetch',
	/**
	 * Triggered on fetch
	 * @param {FetchEvent} event
	 */
	(event) => {
		const isNavigate = event.request.mode === 'navigate';
		const url = event.request.url || '';
		const referrer = event.request.referrer || '';
		const base = referrer.slice(0, referrer.lastIndexOf('/') + 1);
		const local = url.startsWith(base) ? url.replace(base, '') : '';
		const isCacheable = FULL_CACHE.some((v) => v === local) || (base === referrer && base.endsWith(CACHED_FILES[0])) || isChunkFile(local);
		if (isNavigate || isCacheable) {
			event.respondWith((async () => {
				// Try to use cache first
				const cache = await openCaches();
				if (isNavigate) {
					// Check if we have full cache during HTML page request.
					/** @type {Response[]} */
					const fullCache = await Promise.all(FULL_CACHE.map((name) => cache.match(name)));
					const missing = fullCache.some((v) => v === undefined);
					if (missing) {
						try {
							// Try network if some cached file is missing (so we can display offline page in case).
							const response = await fetchAndCache(event, cache, isCacheable);
							return response;
						} catch (e) {
							// And return the hopefully always cached offline page in case of network failure.
							console.error('Network error: ', e); // eslint-disable-line no-console
							return caches.match(OFFLINE_URL);
						}
					}
				}
				let cached = await cache.match(event.request);
				if (cached != null) {
					if (ENSURE_CROSSORIGIN_ISOLATION_HEADERS) {
						cached = ensureCrossOriginIsolationHeaders(cached);
					}
					return cached;
				}
				// Try network if don't have it in cache.
				const response = await fetchAndCache(event, cache, isCacheable);
				return response;
			})());
		} else if (ENSURE_CROSSORIGIN_ISOLATION_HEADERS) {
			event.respondWith((async () => {
				let response = await fetch(event.request);
				response = ensureCrossOriginIsolationHeaders(response);
				return response;
			})());
		}
	}
);

self.addEventListener('message', (event) => {
	// No cross origin
	if (event.origin !== self.origin) {
		return;
	}
	const id = event.source.id || '';
	const msg = event.data || '';
	// Ensure it's one of our clients.
	event.waitUntil(self.clients.get(id).then(function (client) {
		if (!client) {
			return undefined; // Not a valid client.
		}
		if (msg === 'claim') {
			return self.skipWaiting().then(() => self.clients.claim());
		} else if (msg === 'clear') {
			return Promise.all([caches.delete(CACHE_NAME), caches.delete(ENGINE_CACHE), caches.delete(CHUNK_CACHE)]);
		} else if (msg === 'update') {
			return self.skipWaiting().then(() => self.clients.claim()).then(() => self.clients.matchAll()).then((all) => all.forEach((c) => c.navigate(c.url)));
		}
		return undefined;
	}));
});

