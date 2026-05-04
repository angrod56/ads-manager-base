import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL        = process.env.SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY   = process.env.SUPABASE_ANON_KEY?.replace(/\s/g, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.replace(/\s/g, '');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error('[ERROR] SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_KEY requeridos');
  process.exit(1);
}

// Cliente anon — para signUp / signIn (operaciones de usuario)
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Cliente admin (service_role) — bypasa RLS, para gestión de perfiles
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Verificar sesión desde el header Authorization: Bearer <jwt> ─────────────
export async function verifySession(req) {
  const auth = req.headers['authorization'] || '';
  const jwt  = auth.replace('Bearer ', '').trim();
  if (!jwt) return null;

  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return null;

  // Traer perfil con role y meta_token (service_role bypasa RLS)
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, email, name, role, plan, status, meta_token, meta_account_id, hotmart_token, hotmart_role, hotmart_email, stripe_webhook_secret')
    .eq('id', data.user.id)
    .single();

  if (!profile) return null;
  // Bloquear acceso si la cuenta está suspendida (pago cancelado)
  if (profile.status === 'suspended' && profile.role !== 'admin') return null;

  // Segunda capa: aunque la DB diga admin, verificar contra whitelist de emails
  if (profile.role === 'admin') {
    const whitelist = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (whitelist.length > 0 && !whitelist.includes(profile.email.toLowerCase())) {
      profile.role = 'user'; // silenciosamente degradado — no permite explotar roles en DB
    }
  }

  return profile;
}

export async function saveUserName(userId, name) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ name: name || null })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function setUserPlan(userId, plan) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ plan: plan || 'basic' })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function listUsers() {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, name, role, plan, meta_account_id, created_at, last_login')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

export async function saveUserToken(userId, metaToken, metaAccountId) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ meta_token: metaToken, meta_account_id: metaAccountId || null })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function touchLastLogin(userId) {
  await supabaseAdmin
    .from('profiles')
    .update({ last_login: new Date().toISOString() })
    .eq('id', userId);
}

export async function setUserRole(userId, role) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ role })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function saveHotmartRole(userId, hotmartRole) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ hotmart_role: hotmartRole || 'PRODUCER' })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function saveStripeToken(userId, webhookSecret) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({ stripe_webhook_secret: webhookSecret || null })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function saveHotmartToken(userId, hotmartToken, hotmartEmail = null) {
  const updates = { hotmart_token: hotmartToken || null };
  if (hotmartEmail !== null) updates.hotmart_email = hotmartEmail.trim().toLowerCase() || null;
  const { error } = await supabaseAdmin
    .from('profiles')
    .update(updates)
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function deleteUser(userId) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
}
