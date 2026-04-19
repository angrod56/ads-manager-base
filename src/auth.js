import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL        = process.env.SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY   = process.env.SUPABASE_ANON_KEY?.replace(/\s/g, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.replace(/\s/g, '');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
  console.error('[ERROR] SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_KEY requeridos');
  process.exit(1);
}

console.log('[Supabase] URL:', SUPABASE_URL);
console.log('[Supabase] ANON_KEY length:', SUPABASE_ANON_KEY?.length, '| starts:', SUPABASE_ANON_KEY?.slice(0,20));
console.log('[Supabase] SERVICE_KEY length:', SUPABASE_SERVICE_KEY?.length, '| starts:', SUPABASE_SERVICE_KEY?.slice(0,20));

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
    .select('id, email, role, meta_token, meta_account_id')
    .eq('id', data.user.id)
    .single();

  return profile || null;
}

export async function listUsers() {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, role, meta_account_id, created_at, last_login')
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

export async function deleteUser(userId) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
}
