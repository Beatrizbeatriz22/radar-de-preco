// Service worker: recebe as notificações de preço mesmo com o app fechado.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { titulo: 'Radar de Preço', texto: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Radar de Preço', {
    body: d.texto || '',
    icon: 'icone.svg',
    badge: 'icone.svg',
    data: { produtoId: d.produtoId },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const alvo = new URL('./', self.registration.scope).href;
  e.waitUntil((async () => {
    const abertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of abertas) if (c.url.startsWith(alvo)) return c.focus();
    return self.clients.openWindow(alvo);
  })());
});
