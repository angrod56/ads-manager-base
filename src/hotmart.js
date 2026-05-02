import { supabaseAdmin } from './auth.js';

const HOTMART_TOKEN = process.env.HOTMART_TOKEN;

// ── Verificar token del webhook ───────────────────────────────────────────────
export function verifyHotmartToken(req) {
  const token = req.headers['x-hotmart-hottok'] || req.headers['hottok'];
  return token === HOTMART_TOKEN;
}

// ── Procesar evento del webhook ───────────────────────────────────────────────
export async function processHotmartEvent(payload, userId, userEmail = null) {
  const event = payload.event;
  const data  = payload.data;

  if (!data?.purchase || !data?.product) return { ignored: true };

  const purchase    = data.purchase;
  const product     = data.product;
  const buyer       = data.buyer || {};
  const commissions = data.commissions || [];

  const status = mapStatus(event);

  // Identificar la comisión que pertenece a este usuario
  // Hotmart incluye user.email en cada entrada de commissions — usar para match exacto.
  // Si no hay match (email desconocido) y hay una sola entrada no-MARKETPLACE, usarla.
  // Fallback a suma solo si no hay otra opción (log para diagnóstico).
  const nonMarket = commissions.filter(c => c.source !== 'MARKETPLACE');
  let commission = null;

  if (userEmail) {
    const mine = nonMarket.find(c => c.user?.email === userEmail);
    if (mine) {
      commission = mine.value;
    } else if (nonMarket.length === 1) {
      commission = nonMarket[0].value;
    }
  } else if (nonMarket.length === 1) {
    commission = nonMarket[0].value;
  }

  if (commission === null) {
    // No se pudo identificar comisión individual — loggear y sumar todas
    console.log('[Hotmart] comisiones sin match exacto, userEmail:', userEmail,
      '| fuentes:', nonMarket.map(c => `${c.source}:${c.value}(${c.user?.email})`).join(', '));
    commission = nonMarket.reduce((sum, c) => sum + (c.value || 0), 0);
  }

  commission = commission || purchase.price?.value || 0;

  const trackingSource = purchase.tracking_source || null;
  const trackingCode   = purchase.tracking_code   || purchase.xod || null;

  const sale = {
    id:              purchase.transaction || `${Date.now()}`,
    user_id:         userId,
    product_name:    product.name || '—',
    product_id:      String(product.id || ''),
    buyer_email:     buyer.email || null,
    buyer_name:      buyer.name  || null,
    amount:          purchase.price?.value || 0,
    currency:        'USD',
    commission,
    status,
    payment_type:    purchase.payment?.type || null,
    hotmart_event:   event,
    sale_date:       (() => {
      if (!purchase.approved_date) return new Date().toISOString();
      const d = new Date(purchase.approved_date);
      // Si approved_date tiene más de 48h de antigüedad (webhooks de prueba con fecha vieja)
      // usar fecha actual para que aparezca en el filtro "Hoy"
      return (Date.now() - d.getTime()) < 48 * 60 * 60 * 1000
        ? d.toISOString()
        : new Date().toISOString();
    })(),
    tracking_source: trackingSource,
    utm_campaign:    trackingSource || null,
    utm_content:     trackingCode   || null,
    utm_source:      trackingSource ? 'meta' : null,
    utm_medium:      trackingSource ? 'paid' : null,
  };

  // El ID compuesto garantiza unicidad por usuario aunque el transaction ID sea igual
  // (ej: productor y coproductor reciben webhooks del mismo HP...).
  // Si ya existe un registro con el plain txid de OTRO usuario, usamos sufijo.
  const compositeId = `${sale.id}_${userId.slice(0, 8)}`;

  // Buscar registro existente para ESTE usuario (plain o composite)
  const { data: existing } = await supabaseAdmin
    .from('sales').select('id, sale_date')
    .or(`id.eq.${sale.id},id.eq.${compositeId}`)
    .eq('user_id', userId)
    .maybeSingle();

  // Solo estos eventos pueden crear un registro nuevo.
  // COMPLETE/CANCELED/REFUNDED/CHARGEBACK solo actualizan — si no existe el registro
  // es un webhook de prueba o un evento fuera de orden, se ignora silenciosamente.
  const CAN_CREATE = ['PURCHASE_APPROVED', 'PURCHASE_BILLET_PRINTED'];

  if (existing) {
    // Solo actualizar estado y comisión — preservar fecha original de aprobación
    const { error } = await supabaseAdmin
      .from('sales')
      .update({ status: sale.status, hotmart_event: sale.hotmart_event, commission: sale.commission })
      .eq('id', existing.id)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
  } else if (CAN_CREATE.includes(event)) {
    // Intentar insertar con el ID original; si hay conflicto (otro usuario ya lo tiene)
    // reintentar con el ID compuesto para garantizar unicidad en la tabla.
    const { error } = await supabaseAdmin.from('sales').insert(sale);
    if (error?.code === '23505') {
      sale.id = compositeId;
      const { error: error2 } = await supabaseAdmin.from('sales').insert(sale);
      if (error2) throw new Error(error2.message);
    } else if (error) {
      throw new Error(error.message);
    }
  }

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
  if (until) query = query.lte('sale_date', until.includes('T') ? until : until + 'T23:59:59Z');

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Total histórico de comisiones aprobadas (para gamificación) ───────────────
export async function getTotalEarned(userId) {
  const { data, error } = await supabaseAdmin
    .from('sales')
    .select('commission, amount, status')
    .eq('user_id', userId)
    .in('status', ['approved', 'complete']);
  if (error) throw new Error(error.message);
  return (data || []).reduce((sum, s) => sum + (s.commission || s.amount || 0), 0);
}

function mapStatus(event) {
  const map = {
    'PURCHASE_APPROVED':       'approved',
    'PURCHASE_COMPLETE':       'complete',
    'PURCHASE_CANCELED':       'canceled',
    'PURCHASE_REFUNDED':       'refunded',
    'PURCHASE_CHARGEBACK':     'chargeback',
    'PURCHASE_BILLET_PRINTED': 'pending',
  };
  return map[event] || event;
}
