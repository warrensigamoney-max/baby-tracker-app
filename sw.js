// Keeps the app itself on the phone so it opens with no signal. Only the app's
// own files and its fonts are cached; Supabase requests (sign-in, data,
// realtime) always go to the network and are never stored here.
//
//   the page (navigations) -> network first, cached copy when offline
//   /assets/* (hashed)      -> cache first; they never change once built
//   icons, manifest, fonts  -> cached copy straight away, refreshed in the background

const CACHE = 'baby-tracker-v1'
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com']
const NETWORK_TIMEOUT_MS = 4000

const scope = new URL(self.registration.scope)
const INDEX = new URL('./', scope).href

/** The hashed script and stylesheet a copy of index.html points at. */
function assetsIn(html) {
  return [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => new URL(m[1], scope).href)
}

/** Stores a fresh index.html with its assets, and drops assets from older builds. */
async function cacheBuild(response) {
  const cache = await caches.open(CACHE)
  const html = await response.clone().text()
  const assets = assetsIn(html)
  await cache.put(INDEX, response.clone())
  await Promise.all(assets.map(async (url) => (await cache.match(url)) || cache.add(url).catch(() => {})))
  // Drop older builds of these files. Files loaded later on (the WHO growth
  // data) are not in index.html, so they are kept until a newer one replaces them.
  const current = new Map(assets.map((url) => [family(url), url]))
  for (const request of await cache.keys()) {
    const url = request.url
    if (url.includes('/assets/') && current.has(family(url)) && current.get(family(url)) !== url) await cache.delete(request)
  }
}

/** "…/assets/vendor-CJgbuttF.js" → "vendor.js": the same file across builds. */
function family(url) {
  const name = url.split('/').pop() ?? ''
  return name.replace(/-[\w-]{6,}(\.\w+)$/, '$1')
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch(INDEX, { cache: 'no-cache' })
      if (response.ok) await cacheBuild(response)
      const cache = await caches.open(CACHE)
      await cache.addAll(['manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png'].map((f) => new URL(f, scope).href)).catch(() => {})
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Other apps share this github.io origin: only clear this app's old caches.
      for (const name of await caches.keys()) if (name.startsWith('baby-tracker-') && name !== CACHE) await caches.delete(name)
      await self.clients.claim()
    })(),
  )
})

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
}

async function networkFirstPage(request) {
  try {
    const response = await Promise.race([fetch(request, { cache: 'no-cache' }), timeout(NETWORK_TIMEOUT_MS)])
    if (response.ok) cacheBuild(response.clone()).catch(() => {})
    return response
  } catch {
    const cached = await caches.match(INDEX)
    return cached || new Response('Offline, and the app has not been saved on this phone yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } })
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
    // A newer build of a file loaded on demand replaces the older one.
    for (const old of await cache.keys()) {
      if (old.url !== request.url && old.url.includes('/assets/') && family(old.url) === family(request.url)) await cache.delete(old)
    }
  }
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const fresh = fetch(request)
    .then((response) => {
      if (response.ok || response.type === 'opaque') cache.put(request, response.clone())
      return response
    })
    .catch(() => cached)
  return cached || fresh
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // The app checking for a newer build of itself: always the network, never stored.
  if (url.searchParams.has('fresh')) return

  if (request.mode === 'navigate' && url.href.startsWith(scope.href)) {
    event.respondWith(networkFirstPage(request))
  } else if (url.href.startsWith(scope.href) && url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(request))
  } else if (url.href.startsWith(scope.href) || FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request))
  }
  // Anything else (Supabase) is left alone.
})

// ---- Reminders ----------------------------------------------------------------
// The send-reminders function pushes {title, body, url, tag}; one tag per
// reminder, so a repeat replaces the old notification instead of stacking.

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Baby Tracker', {
      body: data.body || '',
      tag: data.tag,
      icon: new URL('icon-192.png', scope).href,
      badge: new URL('icon-192.png', scope).href,
      data: { url: data.url || INDEX },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || INDEX
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const app = open.find((c) => c.url.startsWith(scope.href))
      if (app) {
        await app.focus()
        if ('navigate' in app) await app.navigate(url).catch(() => {})
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
