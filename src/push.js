import webpush from 'web-push';
import { supabaseAdmin } from './auth.js';

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export async function saveSubscription(userId, subscription) {
  const endpoint = subscription?.endpoint;
  if (!endpoint) throw new Error('Suscripción inválida');

  // Buscar si ya existe por endpoint
  const { data: existing } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('endpoint', endpoint)
    .maybeSingle();

  if (existing) {
    // Actualizar keys por si cambiaron
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .update({ subscription })
      .eq('id', existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .insert({ user_id: userId, endpoint, subscription });
    if (error) throw new Error(error.message);
  }
  console.log(`[Push] Suscripción guardada para user ${userId}`);
}

export async function sendPushToUser(userId, payload) {
  const { data: subs, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, subscription')
    .eq('user_id', userId);

  if (error) { console.error('[Push] Error al obtener subs:', error.message); return; }
  if (!subs?.length) { console.warn(`[Push] Sin suscripciones para user ${userId}`); return; }

  console.log(`[Push] Enviando a ${subs.length} dispositivo(s) de user ${userId}`);

  const results = await Promise.allSettled(
    subs.map(s => webpush.sendNotification(s.subscription, JSON.stringify(payload)))
  );

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') console.log(`[Push] ✓ Enviado a sub ${subs[i].id}`);
    else console.error(`[Push] ✗ Error sub ${subs[i].id}:`, r.reason?.message);
  });

  // Eliminar suscripciones expiradas
  const expiredIds = subs
    .filter((_, i) => {
      const r = results[i];
      return r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode);
    })
    .map(s => s.id);

  if (expiredIds.length) {
    await supabaseAdmin.from('push_subscriptions').delete().in('id', expiredIds);
    console.log(`[Push] Eliminadas ${expiredIds.length} suscripciones expiradas`);
  }
}
