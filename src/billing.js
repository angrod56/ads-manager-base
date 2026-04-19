import { supabaseAdmin, setUserPlan } from './auth.js';

// Mapeo por offer_code (parámetro ?off= del link de Hotmart)
const OFFER_MAP = {
  [process.env.HOTMART_OFFER_BASIC  || 'dqv9dxqz']: 'basic',
  [process.env.HOTMART_OFFER_PRO    || 'n3dlwudm']: 'pro',
  [process.env.HOTMART_OFFER_AGENCY || '']:          'agency',
};

export const CHECKOUT_LINKS = {
  basic:  process.env.HOTMART_LINK_BASIC  || 'https://pay.hotmart.com/N105458310E?off=dqv9dxqz&checkoutMode=6',
  pro:    process.env.HOTMART_LINK_PRO    || 'https://pay.hotmart.com/N105458310E?off=n3dlwudm&checkoutMode=6',
  agency: process.env.HOTMART_LINK_AGENCY || null,
};

export function getCheckoutUrl(plan) {
  return CHECKOUT_LINKS[plan] || null;
}

async function findOrCreateUser(email, name) {
  // Buscar en profiles por email
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, email, status')
    .eq('email', email)
    .single();

  if (profile) return { userId: profile.id, isNew: false };

  // No existe → crear cuenta y enviar invitación para que establezca su contraseña
  const appUrl = process.env.APP_URL || 'https://ads-manager-base-production.up.railway.app';
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${appUrl}/?reset=1`,
    data: { name: name || null },
  });

  if (error) throw new Error(`No se pudo crear la cuenta: ${error.message}`);

  // Guardar nombre en profiles (el trigger de Supabase crea el perfil)
  if (name) {
    await supabaseAdmin
      .from('profiles')
      .update({ name })
      .eq('id', data.user.id);
  }

  return { userId: data.user.id, isNew: true };
}

async function setUserStatus(userId, status) {
  await supabaseAdmin
    .from('profiles')
    .update({ status })
    .eq('id', userId);
}

export async function handleBillingWebhook(payload) {
  const event     = payload.event;
  const product   = payload.data?.product;
  const purchase  = payload.data?.purchase;
  const buyer     = payload.data?.buyer;
  const offerCode = purchase?.offer_code || '';

  if (!product || !buyer?.email) return { ignored: true };

  const plan = OFFER_MAP[offerCode];
  if (!plan) return { ignored: true, reason: 'offer_not_mapped', offer: offerCode };

  const approved = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'].includes(event);
  const canceled = ['PURCHASE_CANCELED', 'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK'].includes(event);

  if (approved) {
    const { userId, isNew } = await findOrCreateUser(buyer.email, buyer.name);
    await setUserPlan(userId, plan);
    await setUserStatus(userId, 'active');
    return { ok: true, action: isNew ? 'account_created' : 'plan_assigned', userId, plan };
  }

  if (canceled) {
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('id').eq('email', buyer.email).single();
    if (profile) {
      await setUserStatus(profile.id, 'suspended');
    }
    return { ok: true, action: 'account_suspended', email: buyer.email };
  }

  return { ignored: true, event };
}
