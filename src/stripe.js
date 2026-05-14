import crypto from 'crypto';
import { supabaseAdmin } from './auth.js';

// ── Verificar firma del webhook de Stripe ─────────────────────────────────────
export function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  try {
    const parts     = signatureHeader.split(',');
    const tPart     = parts.find(p => p.startsWith('t='));
    if (!tPart) return false;
    const timestamp = tPart.slice(2);
    const v1sigs    = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
    if (!v1sigs.length) return false;

    const signed   = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');

    return v1sigs.some(sig => {
      try {
        return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
      } catch { return false; }
    });
  } catch { return false; }
}

// ── Procesar evento de Stripe ─────────────────────────────────────────────────
export async function processStripeEvent(event, userId) {
  const type = event.type;
  const obj  = event.data?.object;
  if (!obj) return { ignored: true };

  const status = mapStripeStatus(type);
  if (!status) return { ignored: true };

  let saleId, amount, currency, buyerEmail, buyerName, productName, paymentType;

  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    // Usar payment_intent ID como ID canónico — evita duplicado con payment_intent.succeeded
    saleId      = obj.payment_intent || obj.id;
    amount      = (obj.amount_total || 0) / 100;
    currency    = (obj.currency || 'usd').toUpperCase();
    buyerEmail  = obj.customer_details?.email || obj.customer_email || null;
    buyerName   = obj.customer_details?.name  || null;
    productName = obj.metadata?.product_name  || obj.description || 'Stripe Checkout';
    paymentType = obj.payment_method_types?.[0] || 'card';

  } else if (type === 'payment_intent.succeeded') {
    // checkout.session.completed ya crea el registro con este mismo ID — solo actualiza si existe
    saleId      = obj.id;
    amount      = (obj.amount_received || obj.amount || 0) / 100;
    currency    = (obj.currency || 'usd').toUpperCase();
    buyerEmail  = obj.receipt_email || obj.metadata?.buyer_email || null;
    buyerName   = obj.shipping?.name || obj.metadata?.buyer_name || null;
    productName = obj.description || obj.metadata?.product_name || 'Stripe Payment';
    paymentType = obj.payment_method_types?.[0] || 'card';

  } else if (type === 'invoice.payment_succeeded') {
    saleId      = obj.payment_intent || obj.id;
    amount      = (obj.amount_paid || 0) / 100;
    currency    = (obj.currency || 'usd').toUpperCase();
    buyerEmail  = obj.customer_email || null;
    productName = obj.lines?.data?.[0]?.description || 'Stripe Subscription';
    paymentType = 'subscription';

  } else if (type === 'charge.refunded' || type === 'charge.dispute.created') {
    saleId      = obj.payment_intent || obj.id;
    amount      = (obj.amount_refunded || obj.amount || 0) / 100;
    currency    = (obj.currency || 'usd').toUpperCase();
    buyerEmail  = obj.billing_details?.email || obj.receipt_email || null;
    buyerName   = obj.billing_details?.name  || null;
    productName = obj.description || 'Stripe';
    paymentType = 'card';

  } else {
    return { ignored: true };
  }

  if (!amount || amount <= 0) return { ignored: true };

  const sale = {
    id:            `stripe_${saleId}`,
    user_id:       userId,
    product_name:  productName,
    product_id:    '',
    buyer_email:   buyerEmail,
    buyer_name:    buyerName,
    amount,
    currency,
    commission:    currency === 'USD' ? amount : 0,
    status,
    payment_type:  paymentType,
    hotmart_event: `stripe:${type}`,
    sale_date:     new Date().toISOString(),
  };

  const { data: existing } = await supabaseAdmin
    .from('sales')
    .select('id, status, buyer_name, buyer_email, product_name')
    .eq('id', sale.id)
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    // Actualizar estado; rellenar datos del comprador si el registro previo los tenía vacíos
    const updates = { status: sale.status, hotmart_event: sale.hotmart_event };
    if (!existing.buyer_name  && sale.buyer_name)  updates.buyer_name  = sale.buyer_name;
    if (!existing.buyer_email && sale.buyer_email) updates.buyer_email = sale.buyer_email;
    if (existing.product_name === 'Stripe Payment' && sale.product_name !== 'Stripe Payment')
      updates.product_name = sale.product_name;
    const { error } = await supabaseAdmin
      .from('sales').update(updates).eq('id', existing.id).eq('user_id', userId);
    if (error) throw new Error(error.message);
  } else if (status === 'approved') {
    const { error } = await supabaseAdmin.from('sales').insert(sale);
    if (error) throw new Error(error.message);
  } else {
    return { ignored: true };
  }

  return { ok: true, sale };
}

function mapStripeStatus(type) {
  return {
    'checkout.session.completed':              'approved',
    'checkout.session.async_payment_succeeded':'approved',
    'payment_intent.succeeded':                'approved',
    'invoice.payment_succeeded':               'approved',
    'charge.refunded':                         'refunded',
    'charge.dispute.created':                  'chargeback',
    'payment_intent.payment_failed':           'canceled',
    'checkout.session.async_payment_failed':   'canceled',
  }[type] || null;
}
