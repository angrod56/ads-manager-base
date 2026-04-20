const VERSION = 6;

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    clients.claim().then(() => {
      return self.clients.matchAll({ type: 'window' }).then(all => {
        all.forEach(c => c.postMessage({ type: 'SW_UPDATED' }));
      });
    })
  );
});

self.addEventListener('push', e => {
  const data = e.data?.json() || {};

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Notificar clientes abiertos para reproducir sonido inmediatamente
      clientList.forEach(c => c.postMessage({ type: 'SALE_SOUND' }));

      // Guardar flag en SW storage para que al abrir la app suene
      return self.registration.showNotification(data.title || '💰 Nueva venta', {
        body:     data.body || 'Tienes una nueva comisión',
        icon:     '/icon-192.svg',
        badge:    '/icon-192.svg',
        vibrate:  [200, 100, 200, 100, 400],
        tag:      'sale-notification',
        renotify: true,
        requireInteraction: false,
        data:     { ...data, pendingSound: true },
        actions:  [{ action: 'open', title: 'Ver venta' }],
      });
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Si la app ya está abierta, enfocarla y tocar sonido
      for (const client of clientList) {
        if (client.url.includes('/app')) {
          client.focus();
          client.postMessage({ type: 'SALE_SOUND' });
          return;
        }
      }
      // Si no está abierta, abrir /app con flag de sonido pendiente
      return self.clients.openWindow('/app?sale=1');
    })
  );
});
