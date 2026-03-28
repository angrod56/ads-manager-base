import { apiRequest, paginateAll } from './api.js';

// ─── Campos estándar por entidad ────────────────────────────────────────────

const CAMPAIGN_FIELDS = [
  'id', 'name', 'status', 'effective_status',
  'objective', 'daily_budget', 'lifetime_budget',
  'budget_remaining', 'start_time', 'stop_time',
  'created_time', 'updated_time',
].join(',');

const ADSET_FIELDS = [
  'id', 'name', 'status', 'effective_status',
  'campaign_id', 'daily_budget', 'lifetime_budget',
  'budget_remaining', 'targeting', 'bid_amount',
  'billing_event', 'optimization_goal',
  'start_time', 'end_time', 'created_time',
].join(',');

const AD_FIELDS = [
  'id', 'name', 'status', 'effective_status',
  'campaign_id', 'adset_id',
  'creative', 'created_time', 'updated_time',
].join(',');

const INSIGHT_FIELDS = [
  'campaign_id', 'campaign_name',
  'adset_id', 'adset_name',
  'ad_id', 'ad_name',
  'impressions', 'clicks', 'spend',
  'reach', 'frequency', 'cpm', 'cpc', 'ctr',
  'actions', 'cost_per_action_type',
  'action_values',   // valor monetario de conversiones
  'purchase_roas',   // ROAS calculado por Meta
].join(',');

// ─── Cuentas publicitarias ───────────────────────────────────────────────────

/**
 * Lista todas las cuentas publicitarias del usuario.
 */
export async function listAccounts() {
  const data = await paginateAll('/me/adaccounts', {
    fields: 'id,name,account_status,currency,timezone_name,spend_cap,amount_spent,balance',
  });
  return data;
}

// ─── Campañas ────────────────────────────────────────────────────────────────

/**
 * Lista campañas de una cuenta.
 * @param {string} accountId - Formato: act_XXXXXXXXXX
 * @param {string} status    - 'ACTIVE' | 'PAUSED' | 'ALL' (default)
 */
export async function listCampaigns(accountId, status = 'ALL') {
  const params = { fields: CAMPAIGN_FIELDS, limit: 100 };
  if (status !== 'ALL') params.effective_status = JSON.stringify([status]);
  return paginateAll(`/${accountId}/campaigns`, params);
}

// ─── Ad Sets ─────────────────────────────────────────────────────────────────

/**
 * Lista ad sets de una cuenta o de una campaña específica.
 * @param {string} accountId  - act_XXXXXXXXXX
 * @param {string} campaignId - ID de campaña (opcional)
 * @param {string} status     - 'ACTIVE' | 'PAUSED' | 'ALL'
 */
export async function listAdSets(accountId, campaignId = null, status = 'ALL') {
  const endpoint = campaignId
    ? `/${campaignId}/adsets`
    : `/${accountId}/adsets`;

  const params = { fields: ADSET_FIELDS, limit: 100 };
  if (status !== 'ALL') params.effective_status = JSON.stringify([status]);
  return paginateAll(endpoint, params);
}

// ─── Ads ─────────────────────────────────────────────────────────────────────

/**
 * Lista ads de una cuenta, campaña o ad set.
 * @param {string} parentId - act_XXXXXXXXXX | campaign_id | adset_id
 * @param {string} type     - 'account' | 'campaign' | 'adset'
 * @param {string} status   - 'ACTIVE' | 'PAUSED' | 'ALL'
 */
export async function listAds(parentId, type = 'account', status = 'ALL') {
  const endpoint = type === 'adset'
    ? `/${parentId}/ads`
    : type === 'campaign'
      ? `/${parentId}/ads`
      : `/${parentId}/ads`;

  const params = { fields: AD_FIELDS, limit: 100 };
  if (status !== 'ALL') params.effective_status = JSON.stringify([status]);
  return paginateAll(endpoint, params);
}

// ─── Insights ────────────────────────────────────────────────────────────────

/**
 * Consulta insights (métricas) de una entidad.
 * @param {string} entityId   - act_XXXXXXXXXX | campaign_id | adset_id | ad_id
 * @param {Object} options
 * @param {string} options.datePreset  - 'last_7d' | 'last_30d' | 'last_month' | 'this_month' | 'yesterday' | 'today'
 * @param {string} options.since       - fecha ISO 'YYYY-MM-DD' (sobreescribe datePreset)
 * @param {string} options.until       - fecha ISO 'YYYY-MM-DD'
 * @param {string} options.level       - 'account' | 'campaign' | 'adset' | 'ad'
 * @param {string} options.breakdowns  - 'country' | 'age' | 'gender' | etc.
 */
export async function getInsights(entityId, options = {}) {
  const {
    datePreset = 'last_30d',
    since,
    until,
    level = 'campaign',
    breakdowns,
  } = options;

  const params = {
    fields: INSIGHT_FIELDS,
    level,
    limit: 500,
  };

  if (since && until) {
    params.time_range = JSON.stringify({ since, until });
  } else {
    params.date_preset = datePreset;
  }

  if (breakdowns) params.breakdowns = breakdowns;

  return paginateAll(`/${entityId}/insights`, params);
}

// ─── Pausar / Activar ────────────────────────────────────────────────────────

/**
 * Pausa una campaña, ad set o ad.
 * @param {string} entityId - ID de la entidad
 */
export async function pauseEntity(entityId) {
  return apiRequest(`/${entityId}`, {}, 'POST', { status: 'PAUSED' });
}

/**
 * Activa una campaña, ad set o ad.
 * @param {string} entityId - ID de la entidad
 */
export async function activateEntity(entityId) {
  return apiRequest(`/${entityId}`, {}, 'POST', { status: 'ACTIVE' });
}

// ─── Presupuesto ─────────────────────────────────────────────────────────────

/**
 * Cambia el presupuesto diario o lifetime de una campaña o ad set.
 * @param {string} entityId      - ID de la campaña o ad set
 * @param {number} amount        - Monto en centavos (ej: 1000 = $10.00 USD)
 * @param {string} budgetType    - 'daily_budget' | 'lifetime_budget'
 */
export async function setBudget(entityId, amount, budgetType = 'daily_budget') {
  if (!['daily_budget', 'lifetime_budget'].includes(budgetType)) {
    throw new Error("budgetType debe ser 'daily_budget' o 'lifetime_budget'");
  }
  return apiRequest(`/${entityId}`, {}, 'POST', { [budgetType]: String(amount) });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extrae el valor de una acción específica del array actions de insights.
 * @param {Array} actions   - Array de { action_type, value }
 * @param {string} type     - Ej: 'purchase', 'lead', 'link_click'
 */
export function getActionValue(actions = [], type = 'purchase') {
  const action = actions.find(a => a.action_type === type);
  return action ? parseFloat(action.value) : 0;
}

/**
 * Calcula CPA dado el spend y las conversiones.
 */
export function calcCPA(spend, conversions) {
  if (!conversions || conversions === 0) return null;
  return parseFloat(spend) / conversions;
}

/**
 * Extrae el valor de revenue del array action_values.
 * @param {Array} actionValues - Array de { action_type, value }
 * @param {string} type        - 'purchase' | 'omni_purchase'
 */
export function getRevenue(actionValues = [], type = 'purchase') {
  const item = actionValues.find(a => a.action_type === type)
    || actionValues.find(a => a.action_type === 'omni_purchase');
  return item ? parseFloat(item.value) : 0;
}

/**
 * Extrae el ROAS del array purchase_roas devuelto por Meta.
 * Fallback: calcula revenue / spend si hay revenue.
 * @param {Array}  purchaseRoas - Array de { action_type, value }
 * @param {number} spend
 * @param {number} revenue
 */
export function getRoas(purchaseRoas = [], spend = 0, revenue = 0) {
  if (purchaseRoas && purchaseRoas.length) {
    const item = purchaseRoas.find(r => r.action_type === 'omni_purchase') || purchaseRoas[0];
    if (item) return parseFloat(item.value);
  }
  if (revenue > 0 && spend > 0) return revenue / spend;
  return null;
}

/**
 * Obtiene el iframe de preview de un ad directamente de Meta.
 * @param {string} adId   - ID del ad
 * @param {string} format - MOBILE_FEED_STANDARD | INSTAGRAM_STANDARD | INSTAGRAM_STORY | DESKTOP_FEED_STANDARD
 */
export async function getAdPreview(adId, format = 'MOBILE_FEED_STANDARD') {
  const data = await apiRequest(`/${adId}/previews`, { ad_format: format });
  return data.data?.[0]?.body || null;
}

/**
 * Obtiene thumbnail y datos del creativo de un ad.
 * @param {string} adId
 */
export async function getAdCreative(adId) {
  const data = await apiRequest(`/${adId}`, {
    fields: 'creative{id,name,thumbnail_url,image_url,effective_object_story_id,object_type}',
  });
  return data.creative || null;
}
