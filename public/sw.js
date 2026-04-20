const VERSION = 3;

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    clients.claim().then(() => {
      // Notificar a todos los clientes que hay nueva versión
      return self.clients.matchAll({ type: 'window' }).then(all => {
        all.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
      });
    })
  );
});

self.addEventListener('push', e => {
  const data = e.data?.json() || {};

  // Avisar a clientes abiertos para reproducir sonido
  const notifyClients = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => clients.forEach(c => c.postMessage({ type: 'SALE_SOUND' })));

  e.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Nueva venta', {
        body:     data.body || '',
        icon:     '/icon-192.svg',
        badge:    '/icon-192.svg',
        vibrate:  [100, 50, 100, 50, 300],
        tag:      'sale-notification',
        renotify: true,
        requireInteraction: false,
        data,
      }),
      notifyClients,
    ])
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
