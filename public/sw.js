const VERSION = 12;

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

// Requerido por Chrome en Android para mostrar el prompt de instalación PWA
// Usa Response.error() como fallback para que Safari no genere FetchEvent errors
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => Response.error()));
});

self.addEventListener('push', e => {
  const data = e.data?.json() || {};

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const isCancel = data.type === 'cancel';
      clientList.forEach(c => c.postMessage({ type: isCancel ? 'CANCEL_SOUND' : 'SALE_SOUND' }));

      const isIOS = /iphone|ipad|ipod/i.test(self.navigator?.userAgent || '');
      return self.registration.showNotification(data.title || '💰 Nueva venta', {
        body:    data.body || 'Tienes una nueva comisión',
        icon:    '/brand/icon-192.png',
        badge:   '/brand/icon-192.png',
        tag:     isCancel ? 'cancel-notification' : 'sale-notification',
        renotify: true,
        data:    { ...data, pendingSound: true },
        ...(isIOS ? {} : {
          vibrate: isCancel ? [400, 200, 400] : [200, 100, 200, 100, 400],
          actions: [{ action: 'open', title: isCancel ? 'Ver detalle' : 'Ver venta' }],
        }),
      });
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('/app')) {
          client.focus();
          client.postMessage({ type: 'SALE_SOUND' });
          return;
        }
      }
      return self.clients.openWindow('/app?sale=1');
    })
  );
});
