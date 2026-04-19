import webpush from 'web-push';
import { supabaseAdmin } from './auth.js';

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

export async function saveSubscription(userId, subscription) {
  const { error } = await supabaseAdmin
    .from('push_subscriptions')
    .upsert({ user_id: userId, subscription }, { onConflict: 'user_id,subscription' });
  if (error) throw new Error(error.message);
}

export async function sendPushToUser(userId, payload) {
  const { data: subs } = await supabaseAdmin
    .from('push_subscriptions')
    .select('id, subscription')
    .eq('user_id', userId);

  if (!subs?.length) return;

  const results = await Promise.allSettled(
    subs.map(s => webpush.sendNotification(s.subscription, JSON.stringify(payload)))
  );

  // Eliminar suscripciones expiradas
  const expiredIds = subs
    .filter((_, i) => {
      const r = results[i];
      return r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode);
    })
    .map(s => s.id);

  if (expiredIds.length) {
    await supabaseAdmin.from('push_subscriptions').delete().in('id', expiredIds);
  }
}
