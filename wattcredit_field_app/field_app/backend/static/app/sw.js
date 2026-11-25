// Wakes open pages when Chrome fires Background Sync. The SW cannot read the encrypted outbox (the key lives only
// in the page, derived from the PIN), so it asks a page to flush. A fully closed app cannot sync: the native
// Android build with WorkManager removes that limit.
self.addEventListener('sync', e => {
  if (e.tag === 'flush-outbox') e.waitUntil(self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage('flush-outbox'))));
});
