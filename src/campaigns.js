import { apiRequest, paginateAll } from './api.js';

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
  'action_values',
  'purchase_roas',
].join(',');

export async function listAccounts(token = null) {
  return paginateAll('/me/adaccounts', {
    fields: 'id,name,account_status,currency,timezone_name,spend_cap,amount_spent,balance',
  }, token);
}

export async function listCampaigns(accountId, status = 'ALL', token = null) {
  const params = { fields: CAMPAIGN_FIELDS, limit: 100 };
  if (status !== 'ALL') params.effective_status = JSON.stringify([status]);
  return paginateAll(`/${accountId}/campaigns`, params, token);
}

export async function listAdSets(accountId, campaignId = null, status = 'ALL', token = null) {
  const endpoint = campaignId ? `/${campaignId}/adsets` : `/${accountId}/adsets`;
  const params = { fields: ADSET_FIELDS, limit: 100 };
  if (status !== 'ALL') params.effective_status = JSON.stringify([status]);
  return paginateAll(endpoint, params, token);
}

export async function listAds(parentId, type = 'account', status = 'ALL', token = null) {
  const params = { fields: AD_FIELDS, limit: 100 };
  if (status !== 'ALL') params.effective_status = JSON.stringify([status]);
  return paginateAll(`/${parentId}/ads`, params, token);
}

export async function getInsights(entityId, options = {}, token = null) {
  const {
    datePreset = 'last_30d',
    since,
    until,
    level = 'campaign',
    breakdowns,
    timeIncrement,
  } = options;

  const params = { fields: INSIGHT_FIELDS, level, limit: 500 };

  if (since && until) {
    params.time_range = JSON.stringify({ since, until });
  } else {
    params.date_preset = datePreset;
  }

  if (breakdowns)    params.breakdowns     = breakdowns;
  if (timeIncrement) params.time_increment = timeIncrement;

  return paginateAll(`/${entityId}/insights`, params, token);
}

export async function pauseEntity(entityId, token = null) {
  return apiRequest(`/${entityId}`, {}, 'POST', { status: 'PAUSED' }, token);
}

export async function activateEntity(entityId, token = null) {
  return apiRequest(`/${entityId}`, {}, 'POST', { status: 'ACTIVE' }, token);
}

export async function setBudget(entityId, amount, budgetType = 'daily_budget', token = null) {
  if (!['daily_budget', 'lifetime_budget'].includes(budgetType)) {
    throw new Error("budgetType debe ser 'daily_budget' o 'lifetime_budget'");
  }
  return apiRequest(`/${entityId}`, {}, 'POST', { [budgetType]: String(amount) }, token);
}

export async function getAdPreview(adId, format = 'MOBILE_FEED_STANDARD', token = null) {
  const data = await apiRequest(`/${adId}/previews`, { ad_format: format }, 'GET', null, token);
  return data.data?.[0]?.body || null;
}

export async function getAdCreative(adId, token = null) {
  const data = await apiRequest(`/${adId}`, {
    fields: 'creative{id,name,thumbnail_url,image_url,effective_object_story_id,object_type}',
  }, 'GET', null, token);
  return data.creative || null;
}

export function getActionValue(actions = [], type = 'purchase') {
  const action = actions.find(a => a.action_type === type);
  return action ? parseFloat(action.value) : 0;
}

export function calcCPA(spend, conversions) {
  if (!conversions || conversions === 0) return null;
  return parseFloat(spend) / conversions;
}

export function getRevenue(actionValues = [], type = 'purchase') {
  const item = actionValues.find(a => a.action_type === type)
    || actionValues.find(a => a.action_type === 'omni_purchase');
  return item ? parseFloat(item.value) : 0;
}

export function getRoas(purchaseRoas = [], spend = 0, revenue = 0) {
  if (purchaseRoas && purchaseRoas.length) {
    const item = purchaseRoas.find(r => r.action_type === 'omni_purchase') || purchaseRoas[0];
    if (item) return parseFloat(item.value);
  }
  if (revenue > 0 && spend > 0) return revenue / spend;
  return null;
}
