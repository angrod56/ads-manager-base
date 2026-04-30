import cron from 'node-cron';
import { supabaseAdmin } from './auth.js';
import { sendPushToUser } from './push.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n) => '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function nextMilestone(amount) {
  const steps = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 50000, 100000];
  return steps.find(s => s > amount) ?? Math.ceil((amount + 1) / 10000) * 10000;
}

// "Hoy" en Bogotá (UTC-5): desde las 05:00 UTC hasta las 05:00 UTC del día siguiente
function getTodayRangeUTC() {
  const now = new Date();
  const bogotaMs  = now.getTime() - 5 * 60 * 60 * 1000;
  const bogotaDay = new Date(bogotaMs).toISOString().slice(0, 10);
  const since     = bogotaDay + 'T05:00:00.000Z';
  const until     = new Date(new Date(since).getTime() + 24 * 60 * 60 * 1000).toISOString();
  return { since, until };
}

async function getTodayCommission(userId) {
  const { since, until } = getTodayRangeUTC();
  const { data, error } = await supabaseAdmin
    .from('sales')
    .select('commission, amount')
    .eq('user_id', userId)
    .in('status', ['approved', 'complete'])
    .gte('sale_date', since)
    .lt('sale_date', until);
  if (error) return 0;
  return (data || []).reduce((sum, s) => sum + (s.commission || s.amount || 0), 0);
}

async function getUsersWithSubs() {
  const { data, error } = await supabaseAdmin
    .from('push_subscriptions')
    .select('user_id')
    .limit(500);
  if (error || !data) return [];
  return [...new Set(data.map(s => s.user_id))];
}

// ── Notificación del mediodía (12:00 PM Bogotá) ───────────────────────────────

async function sendNoonNotifications() {
  console.log('[Cron] Enviando notificaciones del mediodía…');
  const userIds = await getUsersWithSubs();

  for (const userId of userIds) {
    try {
      const total = await getTodayCommission(userId);
      let title, body;

      if (total === 0) {
        title = '☀️ Mediodía — ¡A vender!';
        body  = 'Aún no hay ventas registradas hoy. El día tiene mucho por delante, ¡impulsa tu oferta!';
      } else {
        title = '☀️ Reporte del mediodía';
        body  = `Ya hoy llevas ${fmt(total)} USD 💰\n¡Excelente ritmo, la tarde es tuya!`;
      }

      await sendPushToUser(userId, {
        title, body,
        icon: '/icon-192.svg',
        data: { type: 'daily_noon', total },
      });
    } catch (e) {
      console.error(`[Cron] Error noon user ${userId}:`, e.message);
    }
  }
}

// ── Notificación de la noche (8:00 PM Bogotá) ────────────────────────────────

async function sendEveningNotifications() {
  console.log('[Cron] Enviando notificaciones de la noche…');
  const userIds = await getUsersWithSubs();

  for (const userId of userIds) {
    try {
      const total = await getTodayCommission(userId);
      let title, body;

      if (total === 0) {
        title = '🌙 Cierre del día';
        body  = 'Hoy no hubo ventas registradas, pero mañana es una nueva oportunidad. ¡Vamos con todo!';
      } else {
        const next      = nextMilestone(total);
        const remaining = next - total;
        title = '🌙 ¡Vamos a seguir facturando!';
        body  = `Hoy cerrás con ${fmt(total)} USD 🔥\nTe faltan solo ${fmt(remaining)} para llegar a la meta de ${fmt(next)}. ¡Ya casi!`;
      }

      await sendPushToUser(userId, {
        title, body,
        icon: '/icon-192.svg',
        data: { type: 'daily_evening', total },
      });
    } catch (e) {
      console.error(`[Cron] Error evening user ${userId}:`, e.message);
    }
  }
}

// ── Iniciar crons ────────────────────────────────────────────────────────────

export { sendNoonNotifications as sendDailyNoon, sendEveningNotifications as sendDailyEvening };

export function startDailyNotifications() {
  // 12:00 PM hora Colombia (America/Bogota, UTC-5, sin DST)
  cron.schedule('0 12 * * *', sendNoonNotifications,    { timezone: 'America/Bogota' });
  // 8:00 PM hora Colombia
  cron.schedule('0 20 * * *', sendEveningNotifications, { timezone: 'America/Bogota' });
  console.log('[Cron] Notificaciones diarias programadas: 12:00 PM y 8:00 PM (America/Bogota)');
}
