import { supabaseAdmin } from './auth.js';

const HOTMART_TOKEN = process.env.HOTMART_TOKEN;

// ── Verificar token del webhook ───────────────────────────────────────────────
export function verifyHotmartToken(req) {
  const token = req.headers['x-hotmart-hottok'] || req.headers['hottok'];
  return token === HOTMART_TOKEN;
}

// ── Procesar evento del webhook ───────────────────────────────────────────────
export async function processHotmartEvent(payload, userId) {
  const event = payload.event;
  const data  = payload.data;

  if (!data?.purchase || !data?.product) return { ignored: true };

  const purchase    = data.purchase;
  const product     = data.product;
  const buyer       = data.buyer || {};
  const commissions = data.commissions || [];

  const status = mapStatus(event);

  // Excluir MARKETPLACE (tarifa de Hotmart) — solo sumar comisiones del usuario
  const userCommissions = commissions.filter(c => c.source !== 'MARKETPLACE');
  const commission = userCommissions.reduce((sum, c) => sum + (c.value || 0), 0)
    || purchase.price?.value
    || 0;

  const sale = {
    id:           purchase.transaction || `${Date.now()}`,
    user_id:      userId,
    product_name: product.name || '—',
    product_id:   String(product.id || ''),
    buyer_email:  buyer.email || null,
    buyer_name:   buyer.name  || null,
    amount:       purchase.price?.value || 0,
    currency:     'USD',
    commission,
    status,
    payment_type: purchase.payment?.type || null,
    hotmart_event: event,
    sale_date:    purchase.approved_date
      ? new Date(purchase.approved_date).toISOString()
      : new Date().toISOString(),
  };

  const { error } = await supabaseAdmin
    .from('sales')
    .upsert(sale, { onConflict: 'id' });

  if (error) throw new Error(error.message);
  return { ok: true, sale, commission };
}

// ── Obtener ventas de un usuario ──────────────────────────────────────────────
export async function getSales(userId, since, until) {
  let query = supabaseAdmin
    .from('sales')
    .select('*')
    .eq('user_id', userId)
    .order('sale_date', { ascending: false });

  if (since) query = query.gte('sale_date', since);
  if (until) query = query.lte('sale_date', until + 'T23:59:59Z');

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

function mapStatus(event) {
  const map = {
    'PURCHASE_APPROVED':   'approved',
    'PURCHASE_COMPLETE':   'approved',
    'PURCHASE_CANCELED':   'canceled',
    'PURCHASE_REFUNDED':   'refunded',
    'PURCHASE_CHARGEBACK': 'chargeback',
    'PURCHASE_BILLET_PRINTED': 'pending',
  };
  return map[event] || event;
}
