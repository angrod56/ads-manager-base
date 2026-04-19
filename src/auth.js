import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL?.trim();
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY?.trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[ERROR] SUPABASE_URL y SUPABASE_SERVICE_KEY requeridos en .env');
  process.exit(1);
}

// Cliente con service_role — bypasa RLS, solo para operaciones del servidor
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Verificar sesión desde el header Authorization: Bearer <jwt> ─────────────
export async function verifySession(req) {
  const auth = req.headers['authorization'] || '';
  const jwt  = auth.replace('Bearer ', '').trim();
  if (!jwt) return null;

  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return null;

  // Traer perfil con role y meta_token
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, role, meta_token, meta_account_id')
    .eq('id', data.user.id)
    .single();

  return profile || null;
}

// ── Obtener todos los usuarios (admin) ────────────────────────────────────────
export async function listUsers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, role, meta_account_id, created_at, last_login')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

// ── Actualizar meta_token y meta_account_id del usuario ───────────────────────
export async function saveUserToken(userId, metaToken, metaAccountId) {
  const { error } = await supabase
    .from('profiles')
    .update({ meta_token: metaToken, meta_account_id: metaAccountId || null })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

// ── Actualizar last_login ─────────────────────────────────────────────────────
export async function touchLastLogin(userId) {
  await supabase
    .from('profiles')
    .update({ last_login: new Date().toISOString() })
    .eq('id', userId);
}

// ── Cambiar role de un usuario (admin) ────────────────────────────────────────
export async function setUserRole(userId, role) {
  const { error } = await supabase
    .from('profiles')
    .update({ role })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

// ── Eliminar usuario (admin) ──────────────────────────────────────────────────
export async function deleteUser(userId) {
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) throw new Error(error.message);
}
