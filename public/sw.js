self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Nueva venta', {
      body:    data.body || '',
      icon:    '/icon-192.svg',
      badge:   '/icon-192.svg',
      vibrate: [200, 100, 200, 100, 200],
      tag:     'sale-notification',
      renotify: true,
      requireInteraction: false,
      data,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
