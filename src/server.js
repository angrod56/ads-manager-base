#!/usr/bin/env node
import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import {
  listAccounts, listCampaigns, listAdSets, listAds,
  getInsights, pauseEntity, activateEntity, setBudget,
  getActionValue, calcCPA, getRevenue, getRoas,
  getAdPreview, getAdCreative,
} from './campaigns.js';
import {
  verifySession, listUsers, saveUserToken, touchLastLogin, logActivity, setUserRole, deleteUser,
  saveHotmartToken, saveStripeToken, saveUserName, setUserPlan, supabase, supabaseAdmin,
} from './auth.js';
import { verifyHotmartToken, processHotmartEvent, getSales, getTotalEarned } from './hotmart.js';
import { verifyStripeSignature, processStripeEvent } from './stripe.js';
import { saveSubscription, sendPushToUser } from './push.js';
import { startDailyNotifications, sendDailyNoon, sendDailyEvening } from './notifications.js';
import { getCheckoutUrl, handleBillingWebhook } from './billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

// ── Caché en memoria para llamadas a Meta API (TTL: 10 min) ───────────────────
const _cache = new Map();
const CACHE_TTL     = 10 * 60 * 1000; // 10 minutos — endpoints de métricas
const CACHE_TTL_IMG =  5 * 60 * 1000; //  5 minutos — previews/creativos

function cacheGet(key, ttl = CACHE_TTL) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { _cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { _cache.set(key, { ts: Date.now(), data }); }

async function cachedMeta(key, fn, ttl = CACHE_TTL) {
  const cached = cacheGet(key, ttl);
  if (cached) return cached;
  const data = await fn();
  cacheSet(key, data);
  return data;
}

const PLAN_LIMITS = {
  basic:  { metaAccounts: 5,  label: 'Básico' },
  pro:    { metaAccounts: 10, label: 'Pro' },
  agency: { metaAccounts: Infinity, label: 'Agencia' },
};

// ── Seguridad ─────────────────────────────────────────────────────────────────
const CORS_ORIGIN = process.env.APP_URL || 'https://app.ka2ia.com';
const SEC_HEADERS = {
  'X-Frame-Options':           'DENY',
  'X-Content-Type-Options':    'nosniff',
  'Referrer-Policy':           'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

function qs(url) {
  const i = url.indexOf('?');
  return i === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': CORS_ORIGIN, ...SEC_HEADERS });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 500) { json(res, { error: msg }, status); }

function serveFile(res, file, type, acceptEncoding = '') {
  try {
    const isHtml = type === 'text/html';
    const isNoCache = isHtml || file.endsWith('sw.js') || file.endsWith('manifest.json');
    const headers = { 'Content-Type': type + '; charset=utf-8', 'Vary': 'Accept-Encoding', ...(isHtml ? SEC_HEADERS : {}) };
    if (isNoCache) {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      headers['Pragma']  = 'no-cache';
      headers['Expires'] = '0';
    } else {
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    const content = fs.readFileSync(file);
    const canGzip = /\bgzip\b/.test(acceptEncoding) && content.length > 1024;
    if (canGzip) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(zlib.gzipSync(content, { level: 9 }));
    } else {
      res.writeHead(200, headers);
      res.end(content);
    }
  } catch { res.writeHead(404); res.end('Not found'); }
}

async function body(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

async function rawBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ── Rutas GET ─────────────────────────────────────────────────────────────────

// Helper: devuelve opciones de fecha para getInsights según los query params
function dateOpts(q, fallback = 'last_30d') {
  if (q.since && q.until) return { since: q.since, until: q.until };
  // 'custom' no es un date_preset válido de Meta — usar fallback si no hay since/until
  const preset = (!q.date || q.date === 'custom') ? fallback : q.date;
  return { datePreset: preset };
}

const SERVER_START = Date.now();

const GET = {

  '/r': async (res, q, _user, _body, req) => {
    const { u: userId, url, utm_campaign, utm_content, utm_term, utm_source = 'meta', utm_medium = 'paid' } = q;
    if (!userId || !url) { res.writeHead(400); return res.end('Parámetros inválidos'); }

    // Registrar click con los 3 niveles: campaña, conjunto y anuncio
    const rawIp = (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim();
    const ip = rawIp.split('.').slice(0, 3).join('.') + '.0';
    supabaseAdmin.from('utm_clicks').insert({
      user_id: userId, utm_campaign, utm_content, utm_term, utm_source, utm_medium,
      destination: url, ip,
    }).then(() => {}).catch(() => {});

    // Construir URL destino con params de tracking para Hotmart
    // src = campaña (Hotmart lo captura como tracking_source)
    // xcod = anuncio (Hotmart lo captura como tracking_code)
    // utm_term = conjunto — Hotmart no lo captura, pero queda en utm_clicks para cruce posterior
    try {
      const dest = new URL(decodeURIComponent(url));
      if (utm_campaign) dest.searchParams.set('src',  utm_campaign.slice(0, 50));
      if (utm_content)  dest.searchParams.set('xcod', utm_content.slice(0, 50));
      res.writeHead(302, { Location: dest.toString() });
    } catch {
      res.writeHead(302, { Location: decodeURIComponent(url) });
    }
    res.end();
  },

  '/api/version': async (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache, no-store', 'Access-Control-Allow-Origin': CORS_ORIGIN });
    res.end(JSON.stringify({ v: SERVER_START }));
  },

  '/api/config': async (res, _q, user) => {
    json(res, {
      // defaultAccount solo para admin — clientes no deben ver ni usar la cuenta del sistema
      defaultAccount:  user?.role === 'admin' ? (process.env.META_AD_ACCOUNT_ID || null) : null,
      vapidPublicKey:  process.env.VAPID_PUBLIC_KEY   || null,
      hasSystemToken:  !!process.env.META_ACCESS_TOKEN,
    });
  },

  '/api/push/status': async (res, q, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('id, endpoint, created_at')
      .eq('user_id', user.id);
    json(res, { count: subs?.length || 0, subs: subs || [] });
  },

  '/api/accounts': async (res, q, user) => {
    // Sin token propio: no exponer cuentas del sistema
    if (!q.token) return json(res, []);
    const cKey     = `accounts:${q.token.slice(-8)}`;
    const accounts = await cachedMeta(cKey, () => listAccounts(q.token));
    const isAdmin  = user?.role === 'admin';
    const plan     = user?.plan || 'basic';
    const limit    = isAdmin ? Infinity : (PLAN_LIMITS[plan]?.metaAccounts ?? 5);
    const limited  = limit === Infinity ? accounts : accounts.slice(0, limit);
    const planLimit = limit === Infinity ? null : limit;
    json(res, limited.map(a => ({ ...a, _planLimit: planLimit, _planTotal: accounts.length })));
  },

  '/api/campaigns': async (res, q, user) => {
    if (!q.account) return err(res, 'account requerido', 400);
    if (!q.token) return err(res, 'Token de Meta no configurado', 403);
    json(res, await listCampaigns(q.account, q.status || 'ALL', q.token));
  },

  '/api/adsets': async (res, q, user) => {
    if (!q.account) return err(res, 'account requerido', 400);
    if (!q.token) return err(res, 'Token de Meta no configurado', 403);
    json(res, await listAdSets(q.account, q.campaign || null, q.status || 'ALL', q.token));
  },

  '/api/ads': async (res, q, user) => {
    if (!q.account) return err(res, 'account requerido', 400);
    if (!q.token) return err(res, 'Token de Meta no configurado', 403);
    const parentId = q.adset || q.campaign || q.account;
    const type = q.adset ? 'adset' : q.campaign ? 'campaign' : 'account';
    json(res, await listAds(parentId, type, q.status || 'ALL', q.token));
  },

  '/api/insights': async (res, q) => {
    const entityId = q.id || q.account;
    if (!entityId) return err(res, 'account o id requerido', 400);
    const data = await getInsights(entityId, {
      datePreset: q.date || 'last_30d',
      since: q.since, until: q.until,
      level: q.level || 'ad',
      breakdowns: q.breakdowns,
    }, q.token);
    json(res, data);
  },

  // ── Proyecciones de lanzamiento ─────────────────────────────────────────────
  '/api/projections': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);

    const cKey = `proj:${q.account}:${q.date||''}:${q.since||''}:${q.until||''}`;
    const [campaigns, insights] = await cachedMeta(cKey, () => Promise.all([
      listCampaigns(q.account, 'ALL', q.token),
      getInsights(q.account, { ...dateOpts(q), level: 'campaign' }, q.token),
    ]));

    const iMap = {};
    for (const r of insights) iMap[r.campaign_id] = r;

    // Agrupar por lanzamiento
    const groups = {};
    for (const c of campaigns) {
      const key = c.name.split(' | ')[0].split(' // ')[0].trim();
      if (!groups[key]) groups[key] = { name: key, ids: [] };
      groups[key].ids.push(c.id);
    }

    const launches = Object.values(groups).map(g => {
      let spend = 0, purchases = 0, leads = 0, regs = 0, revenue = 0,
          clicks = 0, impressions = 0;

      for (const id of g.ids) {
        const ins = iMap[id] || {};
        spend       += parseFloat(ins.spend || 0);
        purchases   += getActionValue(ins.actions || [], 'purchase');
        leads       += getActionValue(ins.actions || [], 'lead');
        regs        += getActionValue(ins.actions || [], 'complete_registration') || 0;
        revenue     += getRevenue(ins.action_values || []);
        clicks      += parseInt(ins.clicks || 0);
        impressions += parseInt(ins.impressions || 0);
      }

      if (spend === 0) return null;

      const funnelType   = regs > 0 ? 'webinar' : leads > 0 ? 'leads' : 'direct';
      const conversions  = funnelType === 'webinar' ? regs : leads;
      const cpl          = conversions > 0 ? spend / conversions : null;
      const closeRate    = conversions > 0 && purchases > 0 ? purchases / conversions : null;
      const avgTicket    = purchases > 0 && revenue > 0 ? revenue / purchases : null;
      const roas         = spend > 0 && revenue > 0 ? revenue / spend : null;
      const ctr          = impressions > 0 ? (clicks / impressions) * 100 : 0;

      const cpm            = impressions > 0 ? (spend / impressions) * 1000 : null;
      const cpc            = clicks > 0 ? spend / clicks : null;
      // LP conversion rate: % of clicks that become leads/regs
      const lpConvRate     = conversions > 0 && clicks > 0 ? conversions / clicks : null;

      return {
        name: g.name, funnelType,
        spend, purchases, conversions, revenue,
        clicks, impressions,
        cpl, closeRate, avgTicket, roas, ctr, cpm, cpc,
        lpConvRate,  // decimal: conversions / clicks
      };
    }).filter(Boolean).sort((a, b) => b.spend - a.spend);

    json(res, launches);
  },

  // Endpoint principal del dashboard — campañas + métricas merged
  '/api/overview': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);

    const cKey = `overview:${q.account}:${q.date||''}:${q.since||''}:${q.until||''}`;
    const [campaigns, insights] = await cachedMeta(cKey, () => Promise.all([
      listCampaigns(q.account, 'ALL', q.token),
      getInsights(q.account, { ...dateOpts(q), level: 'campaign' }, q.token),
    ]));

    const iMap = {};
    for (const row of insights) iMap[row.campaign_id] = row;

    const enriched = campaigns.map(c => {
      const ins       = iMap[c.id] || {};
      const spend     = parseFloat(ins.spend || 0);
      const purchases     = getActionValue(ins.actions || [], 'purchase');
      // complete_registration = evento de pixel configurado por el usuario (coincide con Ads Manager)
      // lead = auto-tracked por Meta, puede inflar el número — NO usar para CPL
      const registrations    = getActionValue(ins.actions || [], 'complete_registration') || 0;
      const lpViews          = getActionValue(ins.actions || [], 'landing_page_view') || 0;
      const initiateCheckout = getActionValue(ins.actions || [], 'initiate_checkout') || 0;
      const addToCart        = getActionValue(ins.actions || [], 'add_to_cart') || 0;
      const videoViews       = getActionValue(ins.actions || [], 'video_view') || 0;
      const revenue       = getRevenue(ins.action_values || []);
      const roas          = getRoas(ins.purchase_roas || [], spend, revenue);
      const cpl           = calcCPA(spend, registrations);
      return {
        ...c,
        spend,
        impressions:   parseInt(ins.impressions || 0),
        clicks:        parseInt(ins.clicks || 0),
        purchases,
        registrations,
        lpViews,
        initiateCheckout,
        addToCart,
        videoViews,
        regConv: lpViews > 0 ? registrations / lpViews : null,
        revenue,
        roas,
        cpl,
        cpa:       calcCPA(spend, purchases),
        costPerCheckout: calcCPA(spend, initiateCheckout),
        costPerLpView:   calcCPA(spend, lpViews),
        ctr:       parseFloat(ins.ctr || 0),
        cpm:       parseFloat(ins.cpm || 0),
        cpc:       parseFloat(ins.cpc || 0),
        frequency: parseFloat(ins.frequency || 0),
        reach:     parseInt(ins.reach || 0),
      };
    }).sort((a, b) => b.spend - a.spend);

    const totals = enriched.reduce(
      (a, c) => ({
        spend:         a.spend + c.spend,
        impressions:   a.impressions + c.impressions,
        clicks:        a.clicks + c.clicks,
        purchases:     a.purchases + c.purchases,
        registrations: a.registrations + c.registrations,
        revenue:       a.revenue + c.revenue,
      }),
      { spend: 0, impressions: 0, clicks: 0, purchases: 0, registrations: 0, revenue: 0 }
    );
    totals.cpa  = calcCPA(totals.spend, totals.purchases);
    totals.roas = totals.spend > 0 && totals.revenue > 0 ? totals.revenue / totals.spend : null;
    totals.ctr  = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
    totals.cpm  = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;

    // Período anterior para comparación
    let prevTotals = null;
    if (q.compare === '1') {
      const now   = new Date();
      const days  = q.date === 'last_7d' ? 7 : q.date === 'last_3d' ? 3 : 30;
      const until = new Date(now); until.setDate(until.getDate() - days);
      const since = new Date(until); since.setDate(since.getDate() - days);
      const fmt   = d => d.toISOString().slice(0, 10);
      const prevIns = await getInsights(q.account, { since: fmt(since), until: fmt(until), level: 'campaign' }, q.token);
      prevTotals = prevIns.reduce(
        (a, r) => ({
          spend:       a.spend + parseFloat(r.spend || 0),
          purchases:   a.purchases + getActionValue(r.actions || [], 'purchase'),
          registrations: a.registrations + (getActionValue(r.actions || [], 'complete_registration') || 0),
          revenue:     a.revenue + getRevenue(r.action_values || []),
          impressions: a.impressions + parseInt(r.impressions || 0),
          clicks:      a.clicks + parseInt(r.clicks || 0),
        }),
        { spend: 0, purchases: 0, registrations: 0, revenue: 0, impressions: 0, clicks: 0 }
      );
      prevTotals.roas = prevTotals.spend > 0 && prevTotals.revenue > 0 ? prevTotals.revenue / prevTotals.spend : null;
      prevTotals.ctr  = prevTotals.impressions > 0 ? (prevTotals.clicks / prevTotals.impressions) * 100 : 0;
      prevTotals.cpa  = calcCPA(prevTotals.spend, prevTotals.purchases);
    }

    json(res, { campaigns: enriched, totals, prevTotals });
  },

  // Tendencia diaria: spend + revenue por día
  '/api/daily-trend': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);
    const cKey = `daily-trend:${q.account}:${q.date||''}:${q.since||''}:${q.until||''}`;
    const rows = await cachedMeta(cKey, () =>
      getInsights(q.account, { ...dateOpts(q, 'last_7d'), level: 'account', timeIncrement: '1' }, q.token)
    );
    const daily = rows
      .map(r => ({
        date:    r.date_start,
        spend:   parseFloat(r.spend || 0),
        revenue: getRevenue(r.action_values || []),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    json(res, daily);
  },

  // Ad Sets con métricas para una campaña
  '/api/adset-metrics': async (res, q) => {
    if (!q.campaign) return err(res, 'campaign requerido', 400);
    const [adsets, insights] = await Promise.all([
      listAdSets(q.account || q.campaign, q.campaign, 'ALL', q.token),
      getInsights(q.campaign, { ...dateOpts(q), level: 'adset' }, q.token),
    ]);
    const iMap = {};
    for (const r of insights) iMap[r.adset_id] = r;
    const enriched = adsets.map(s => {
      const ins   = iMap[s.id] || {};
      const spend = parseFloat(ins.spend || 0);
      const regs  = getActionValue(ins.actions || [], 'complete_registration') || 0;
      const purchases = getActionValue(ins.actions || [], 'purchase');
      const revenue   = getRevenue(ins.action_values || []);
      return {
        id: s.id, name: s.name,
        status: s.effective_status || s.status,
        daily_budget: s.daily_budget,
        lifetime_budget: s.lifetime_budget,
        optimization_goal: s.optimization_goal,
        spend,
        impressions: parseInt(ins.impressions || 0),
        clicks:      parseInt(ins.clicks || 0),
        purchases, regs, revenue,
        roas:  getRoas(ins.purchase_roas || [], spend, revenue),
        cpa:   calcCPA(spend, purchases),
        cpl:   calcCPA(spend, regs),
        ctr:   parseFloat(ins.ctr || 0),
        cpm:   parseFloat(ins.cpm || 0),
        frequency: parseFloat(ins.frequency || 0),
        reach: parseInt(ins.reach || 0),
      };
    }).sort((a, b) => b.spend - a.spend);
    json(res, enriched);
  },

  // Insights a nivel ad para drill-down de campaña
  '/api/campaign-ads': async (res, q) => {
    if (!q.campaign) return err(res, 'campaign requerido', 400);
    const data = await getInsights(q.campaign, { ...dateOpts(q), level: 'ad' }, q.token);
    json(res, data.map(row => {
      const spend     = parseFloat(row.spend || 0);
      const purchases = getActionValue(row.actions || [], 'purchase');
      const revenue   = getRevenue(row.action_values || []);
      const roas      = getRoas(row.purchase_roas || [], spend, revenue);
      return {
        id:          row.ad_id,
        name:        row.ad_name || row.ad_id,
        spend,
        impressions: parseInt(row.impressions || 0),
        clicks:      parseInt(row.clicks || 0),
        purchases,
        revenue,
        roas,
        cpa:         calcCPA(spend, purchases),
        ctr:         parseFloat(row.ctr || 0),
        cpm:         parseFloat(row.cpm || 0),
        frequency:   parseFloat(row.frequency || 0),
      };
    }).sort((a, b) => b.spend - a.spend));
  },

  // Top N ads por rendimiento con preview iframe de Meta
  '/api/top-ads': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);

    const format = q.format || 'MOBILE_FEED_STANDARD';
    const limit  = parseInt(q.limit || '5');
    const cKey   = `top-ads:${q.account}:${q.date||''}:${q.since||''}:${q.until||''}:${format}:${limit}`;

    const withPreviews = await cachedMeta(cKey, async () => {
      const insights = await getInsights(q.account, { ...dateOpts(q), level: 'ad' }, q.token);

      const mapped = insights.map(row => {
        const spend     = parseFloat(row.spend || 0);
        const purchases = getActionValue(row.actions || [], 'purchase');
        const revenue   = getRevenue(row.action_values || []);
        const roas      = getRoas(row.purchase_roas || [], spend, revenue);
        return {
          id:           row.ad_id,
          name:         row.ad_name || row.ad_id,
          campaignId:   row.campaign_id,
          campaignName: row.campaign_name || '—',
          adsetName:    row.adset_name   || '—',
          spend, purchases, revenue, roas,
          cpa:          calcCPA(spend, purchases),
          ctr:          parseFloat(row.ctr || 0),
          cpm:          parseFloat(row.cpm || 0),
          impressions:  parseInt(row.impressions || 0),
          clicks:       parseInt(row.clicks || 0),
          frequency:    parseFloat(row.frequency || 0),
        };
      }).sort((a, b) =>
        b.purchases - a.purchases ||
        b.revenue   - a.revenue   ||
        b.spend     - a.spend
      ).slice(0, limit);

      // Preview + creativo en paralelo para cada ad (cacheado con TTL de imagen)
      return Promise.all(mapped.map(async ad => {
        const imgKey = `ad-creative:${ad.id}:${format}`;
        const cached = cacheGet(imgKey, CACHE_TTL_IMG);
        if (cached) return { ...ad, ...cached };

        const [preview, creative] = await Promise.allSettled([
          getAdPreview(ad.id, format, q.token),
          getAdCreative(ad.id, q.token),
        ]);
        const imgs = {
          preview:    preview.status   === 'fulfilled' ? preview.value   : null,
          thumbnail:  creative.status  === 'fulfilled' ? creative.value?.thumbnail_url || null : null,
          imageUrl:   creative.status  === 'fulfilled' ? creative.value?.image_url     || null : null,
          objectType: creative.status  === 'fulfilled' ? creative.value?.object_type   || null : null,
        };
        if (imgs.preview || imgs.thumbnail) cacheSet(imgKey, imgs);
        return { ...ad, ...imgs };
      }));
    }, CACHE_TTL_IMG);

    json(res, withPreviews);
  },

  // ── Helpers de lanzamientos ──────────────────────────────────────────────────

  // Extrae el nombre del lanzamiento del nombre de campaña
  // Ej: "SANT G2 | Conversiones 2" → "SANT G2"
  //     "WEBINAR 21 - DICIEMBRE 13 DE 2024 // FB" → "WEBINAR 21 - DICIEMBRE 13 DE 2024"

  // ── Endpoint lanzamientos agrupados ──────────────────────────────────────────
  '/api/launches': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);

    const cKey = `launches:${q.account}:${q.date||''}:${q.since||''}:${q.until||''}`;
    const [campaigns, insights] = await cachedMeta(cKey, () => Promise.all([
      listCampaigns(q.account, 'ALL', q.token),
      getInsights(q.account, { ...dateOpts(q), level: 'campaign' }, q.token),
    ]));

    const iMap = {};
    for (const r of insights) iMap[r.campaign_id] = r;

    // Agrupar campañas por nombre de lanzamiento
    const groups = {};
    for (const c of campaigns) {
      const key = c.name.split(' | ')[0].split(' // ')[0].trim();
      if (!groups[key]) groups[key] = { name: key, ids: [], statuses: [] };
      groups[key].ids.push(c.id);
      groups[key].statuses.push(c.effective_status || c.status);
    }

    const launches = Object.values(groups).map(g => {
      let spend = 0, impressions = 0, clicks = 0, purchases = 0,
          leads = 0, regs = 0, revenue = 0, reach = 0, lpViews = 0;

      for (const id of g.ids) {
        const ins = iMap[id] || {};
        spend       += parseFloat(ins.spend || 0);
        impressions += parseInt(ins.impressions || 0);
        clicks      += parseInt(ins.clicks || 0);
        purchases   += getActionValue(ins.actions || [], 'purchase');
        leads       += getActionValue(ins.actions || [], 'lead');
        regs        += getActionValue(ins.actions || [], 'complete_registration') || 0;
        revenue     += getRevenue(ins.action_values || []);
        reach       += parseInt(ins.reach || 0);
        lpViews     += getActionValue(ins.actions || [], 'landing_page_view');
      }

      if (spend === 0) return null;

      // Detectar tipo de embudo
      const funnelType = regs > 0 ? 'webinar' : leads > 0 ? 'leads' : 'direct';
      const isActive   = g.statuses.some(s => s === 'ACTIVE');

      // Métricas derivadas
      const ctr     = impressions > 0 ? (clicks / impressions) * 100 : 0;
      const lpRate  = clicks > 0 && lpViews > 0 ? (lpViews / clicks) * 100 : null;
      const regRate = lpViews > 0 && regs > 0 ? (regs / lpViews) * 100 : null;
      const cpl     = leads > 0 ? spend / leads : regs > 0 ? spend / regs : null;
      const cpa     = purchases > 0 ? spend / purchases : null;
      const roas    = spend > 0 && revenue > 0 ? revenue / spend : null;
      const closeRate = (leads > 0 || regs > 0) && purchases > 0
        ? (purchases / (leads || regs)) * 100 : null;

      // Etapas del embudo
      let funnel = [];
      if (funnelType === 'webinar') {
        funnel = [
          { stage: 'Impresiones', value: impressions, rate: null },
          { stage: 'Clics',       value: clicks,      rate: ctr     ? ctr.toFixed(1)     + '%' : null, label: 'CTR' },
          ...(lpViews > 0 ? [{ stage: 'Visitas LP', value: lpViews, rate: lpRate ? lpRate.toFixed(1) + '%' : null, label: 'Conv. LP' }] : []),
          { stage: 'Registros',   value: regs,        rate: regRate ? regRate.toFixed(1)  + '%' : null, label: 'Tasa reg.' },
          { stage: 'Ventas',      value: purchases,   rate: closeRate ? closeRate.toFixed(1) + '%' : null, label: 'Cierre' },
        ];
      } else if (funnelType === 'leads') {
        funnel = [
          { stage: 'Impresiones', value: impressions, rate: null },
          { stage: 'Clics',       value: clicks,      rate: ctr    ? ctr.toFixed(1)    + '%' : null, label: 'CTR' },
          { stage: 'Leads',       value: leads,       rate: lpRate ? lpRate.toFixed(1) + '%' : null, label: 'Conv. LP' },
          { stage: 'Ventas',      value: purchases,   rate: closeRate ? closeRate.toFixed(1) + '%' : null, label: 'Cierre' },
        ];
      } else {
        funnel = [
          { stage: 'Impresiones', value: impressions, rate: null },
          { stage: 'Clics',       value: clicks,      rate: ctr ? ctr.toFixed(1) + '%' : null, label: 'CTR' },
          { stage: 'Compras',     value: purchases,   rate: null },
          { stage: 'Revenue',     value: revenue > 0 ? '$' + revenue.toFixed(0) : 0, rate: roas ? roas.toFixed(2) + 'x' : null, label: 'ROAS' },
        ];
      }

      // Alertas automáticas basadas en skills
      const alerts = [];
      if (ctr < 1)
        alerts.push({ type: 'error',   msg: `CTR ${ctr.toFixed(2)}% — el creativo no está enganchando, revisar ángulo del anuncio` });
      else if (ctr < 2)
        alerts.push({ type: 'warning', msg: `CTR ${ctr.toFixed(2)}% en zona límite (< 2%), probar nuevo creativo` });

      if (funnelType === 'webinar') {
        if (regRate !== null && regRate < 15)
          alerts.push({ type: 'error',   msg: `Tasa de registro ${regRate.toFixed(1)}% baja — revisar landing page de registro` });
        if (cpl !== null && cpl > 4)
          alerts.push({ type: 'error',   msg: `CPL $${cpl.toFixed(2)} supera el máximo de $4 USD — evaluar pausa` });
        else if (cpl !== null && cpl > 2)
          alerts.push({ type: 'warning', msg: `CPL $${cpl.toFixed(2)} en zona límite ($2–$4 USD)` });
        else if (cpl !== null && cpl <= 2)
          alerts.push({ type: 'success', msg: `CPL $${cpl.toFixed(2)} excelente — considerar escalar presupuesto` });
      } else if (funnelType === 'leads') {
        if (cpl !== null && cpl > 4)
          alerts.push({ type: 'error',   msg: `CPL $${cpl.toFixed(2)} supera máximo de $4 USD` });
        else if (cpl !== null && cpl <= 2)
          alerts.push({ type: 'success', msg: `CPL $${cpl.toFixed(2)} ideal — candidato a escalar` });
      } else {
        if (roas !== null && roas < 1)
          alerts.push({ type: 'error',   msg: `ROAS ${roas.toFixed(2)}x — perdiendo dinero, evaluar pausa inmediata` });
        else if (roas !== null && roas < 1.2)
          alerts.push({ type: 'warning', msg: `ROAS ${roas.toFixed(2)}x por debajo del mínimo de 1.2x` });
        else if (roas !== null && roas >= 1.2)
          alerts.push({ type: 'success', msg: `ROAS ${roas.toFixed(2)}x sobre el mínimo — candidato a escalar` });
        if (cpa !== null && cpa > 50)
          alerts.push({ type: 'warning', msg: `CPA $${cpa.toFixed(2)} elevado — verificar precio del producto vs costo` });
      }
      if (closeRate !== null && closeRate < 1)
        alerts.push({ type: 'warning', msg: `Tasa de cierre ${closeRate.toFixed(1)}% muy baja — revisar proceso de venta post-lead` });

      if (alerts.length === 0)
        alerts.push({ type: 'info', msg: 'Sin alertas críticas en este período' });

      const frequency   = reach > 0 ? impressions / reach : null;
      const cpm         = impressions > 0 ? (spend / impressions) * 1000 : null;
      const avgTicket   = purchases > 0 && revenue > 0 ? revenue / purchases : null;
      const revPerLead  = (leads > 0 || regs > 0) && revenue > 0 ? revenue / (leads || regs) : null;

      return {
        name: g.name, funnelType, isActive,
        campaigns: g.ids.length,
        spend, impressions, clicks, purchases, leads, regs, revenue, reach, lpViews,
        ctr, cpl, cpa, roas, closeRate, lpRate, regRate,
        frequency, cpm, avgTicket, revPerLead,
        funnel, alerts,
      };
    }).filter(Boolean).sort((a, b) => b.spend - a.spend);

    json(res, launches);
  },

  // ── Tendencia diaria de un lanzamiento ───────────────────────────────────────
  '/api/launch-trend': async (res, q) => {
    if (!q.account || !q.launch) return err(res, 'account y launch requeridos', 400);

    const campaigns = await listCampaigns(q.account, 'ALL', q.token);
    const ids = campaigns
      .filter(c => c.name.split(' | ')[0].split(' // ')[0].trim() === q.launch)
      .map(c => c.id);

    if (!ids.length) return json(res, []);

    const allInsights = await Promise.all(
      ids.map(id => getInsights(id, { ...dateOpts(q), level: 'campaign', timeIncrement: '1' }, q.token))
    );

    const byDate = {};
    for (const rows of allInsights) {
      for (const r of rows) {
        const d = r.date_start;
        if (!byDate[d]) byDate[d] = { date: d, spend: 0, clicks: 0, impressions: 0, purchases: 0, leads: 0, regs: 0, revenue: 0 };
        byDate[d].spend       += parseFloat(r.spend || 0);
        byDate[d].impressions += parseInt(r.impressions || 0);
        byDate[d].clicks      += parseInt(r.clicks || 0);
        byDate[d].purchases   += getActionValue(r.actions || [], 'purchase');
        byDate[d].leads       += getActionValue(r.actions || [], 'lead');
        byDate[d].regs        += getActionValue(r.actions || [], 'complete_registration') || 0;
        byDate[d].revenue     += getRevenue(r.action_values || []);
      }
    }

    json(res, Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date)));
  },

  // Recomendaciones automáticas basadas en skills
  '/api/recommendations': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);

    const date7  = q.date || 'last_7d';
    const date3  = 'last_3d';
    const cKey   = `reco:${q.account}:${date7}`;

    const [campaigns7, insights7, insights3] = await cachedMeta(cKey, () => Promise.all([
      listCampaigns(q.account, 'ALL', q.token),
      getInsights(q.account, { datePreset: date7, level: 'campaign' }, q.token),
      getInsights(q.account, { datePreset: date3, level: 'campaign' }, q.token),
    ]));

    const map7 = {}, map3 = {};
    for (const r of insights7) map7[r.campaign_id] = r;
    for (const r of insights3) map3[r.campaign_id] = r;

    const pausar = [], escalar = [], revisar = [], bien = [];

    for (const c of campaigns7) {
      const i7 = map7[c.id] || {};
      const i3 = map3[c.id] || {};
      const spend7    = parseFloat(i7.spend || 0);
      if (spend7 === 0) continue;

      const purchases = getActionValue(i7.actions || [], 'purchase');
      const regs      = getActionValue(i7.actions || [], 'complete_registration') || 0;
      const revenue   = getRevenue(i7.action_values || []);
      const roas      = getRoas(i7.purchase_roas || [], spend7, revenue);
      const ctr       = parseFloat(i7.ctr || 0);
      const freq      = parseFloat(i7.frequency || 0);
      const cpl       = regs > 0 ? spend7 / regs : null;
      const isLeads   = regs > 0 && purchases === 0;
      const isConv    = purchases > 0 || (!isLeads && revenue > 0);
      const name      = c.name;

      // ── REGLAS DE PAUSA ──────────────────────────────────────────
      if (isLeads) {
        if (cpl !== null && cpl > 4)
          pausar.push({ name, reason: `CPL $${cpl.toFixed(2)} USD supera el máximo de $4 USD`, metric: `CPL: $${cpl.toFixed(2)}` });
        else if (spend7 >= 8 && regs === 0)
          pausar.push({ name, reason: `Gastó $${spend7.toFixed(2)} sin generar registros`, metric: `Gasto: $${spend7.toFixed(2)}` });
      } else {
        if (roas !== null && roas < 1.0 && spend7 > 30)
          pausar.push({ name, reason: `ROAS de ${roas.toFixed(2)}x está por debajo de 1.0x`, metric: `ROAS: ${roas.toFixed(2)}x` });
        else if (purchases === 0 && spend7 >= 60)
          pausar.push({ name, reason: `Gastó $${spend7.toFixed(2)} sin ninguna compra`, metric: `Gasto: $${spend7.toFixed(2)}` });
        else if (ctr < 1 && spend7 > 20)
          pausar.push({ name, reason: `CTR de ${ctr.toFixed(2)}% es muy bajo (< 1%)`, metric: `CTR: ${ctr.toFixed(2)}%` });
      }

      // ── REGLAS DE ESCALAR ────────────────────────────────────────
      if (isLeads && cpl !== null && cpl >= 1 && cpl <= 2)
        escalar.push({ name, reason: `CPL excelente de $${cpl.toFixed(2)} USD`, metric: `CPL: $${cpl.toFixed(2)}` });
      else if (isConv && roas !== null && roas >= 1.2)
        escalar.push({ name, reason: `ROAS de ${roas.toFixed(2)}x está por encima del mínimo`, metric: `ROAS: ${roas.toFixed(2)}x` });

      // ── REGLAS DE REVISAR ────────────────────────────────────────
      if (freq > 2.5)
        revisar.push({ name, reason: `Frecuencia alta de ${freq.toFixed(1)} — audiencia posiblemente saturada`, metric: `Freq: ${freq.toFixed(1)}` });
      if (roas !== null && roas >= 1.0 && roas < 1.2)
        revisar.push({ name, reason: `ROAS de ${roas.toFixed(2)}x está en zona límite (1.0–1.2x)`, metric: `ROAS: ${roas.toFixed(2)}x` });
      if (isLeads && cpl !== null && cpl > 2 && cpl <= 4)
        revisar.push({ name, reason: `CPL de $${cpl.toFixed(2)} está en zona límite ($2–$4)`, metric: `CPL: $${cpl.toFixed(2)}` });

      // ── LO QUE ESTÁ BIEN ─────────────────────────────────────────
      if (isConv && roas !== null && roas >= 1.2 && ctr >= 2)
        bien.push({ name, reason: `ROAS ${roas.toFixed(2)}x y CTR ${ctr.toFixed(2)}% — rendimiento sólido`, metric: `ROAS: ${roas.toFixed(2)}x · CTR: ${ctr.toFixed(2)}%` });
      else if (isLeads && cpl !== null && cpl <= 2)
        bien.push({ name, reason: `CPL $${cpl.toFixed(2)} dentro del rango ideal ($1–$2)`, metric: `CPL: $${cpl.toFixed(2)}` });
    }

    json(res, { pausar, escalar, revisar, bien, period: date7 });
  },

  // Análisis por país para una cuenta
  '/api/demographics': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);
    const opts = { since: q.since, until: q.until, level: 'account', timeIncrement: 1 };
    const [ageData, genderData] = await Promise.all([
      getInsights(q.account, { ...opts, breakdowns: 'age' },    q.token),
      getInsights(q.account, { ...opts, breakdowns: 'gender' }, q.token),
    ]);
    function actionVal(actions, type) {
      return parseFloat(actions?.find(a => a.action_type === type)?.value || 0);
    }
    const age = ageData.map(r => ({
      date:         r.date_start,
      age_group:    r.age,
      purchases:    actionVal(r.actions, 'purchase'),
      registrations: actionVal(r.actions, 'complete_registration') || actionVal(r.actions, 'lead'),
      spend:        parseFloat(r.spend || 0),
    }));
    const gender = genderData.map(r => ({
      date:         r.date_start,
      gender:       r.gender,
      purchases:    actionVal(r.actions, 'purchase'),
      registrations: actionVal(r.actions, 'complete_registration') || actionVal(r.actions, 'lead'),
      spend:        parseFloat(r.spend || 0),
    }));
    json(res, { age, gender });
  },

  '/api/countries': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);
    const cKey = `countries:${q.account}:${q.date||''}:${q.since||''}:${q.until||''}`;
    const data = await cachedMeta(cKey, () => getInsights(q.account, {
      ...dateOpts(q),
      level: q.level || 'campaign',
      breakdowns: 'country',
    }, q.token));
    const map = {};
    for (const row of data) {
      const c = row.country || 'XX';
      if (!map[c]) map[c] = { country: c, spend: 0, impressions: 0, clicks: 0, purchases: 0, revenue: 0 };
      map[c].spend       += parseFloat(row.spend || 0);
      map[c].impressions += parseInt(row.impressions || 0);
      map[c].clicks      += parseInt(row.clicks || 0);
      map[c].purchases   += getActionValue(row.actions || [], 'purchase');
      map[c].revenue     += getRevenue(row.action_values || []);
    }
    json(res, Object.values(map).map(c => ({
      ...c,
      cpa:  calcCPA(c.spend, c.purchases),
      roas: c.spend > 0 && c.revenue > 0 ? c.revenue / c.spend : null,
      ctr:  c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
    })).sort((a, b) => b.purchases - a.purchases || b.spend - a.spend));
  },

  // ── Auth: perfil del usuario actual ─────────────────────────────────────────
  '/api/auth/me': async (res, q, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    json(res, user);
  },

  // ── Ventas Hotmart ───────────────────────────────────────────────────────────
  '/api/sales': async (res, q, user) => {
    if (!user) return err(res, 'No autorizado', 401);

    const tzH  = parseFloat(q.tz || '0') || 0;
    const tzMs = tzH * 3600000;

    // Convertir preset de fecha (today, last_7d, last_30d…) a since/until explícitos
    let since = q.since, until = q.until;
    if (!since && q.date) {
      const now      = new Date(Date.now() + tzMs); // hora local: UTC + offset
      const todayStr = now.toISOString().slice(0, 10);
      const daysBack = n => {
        const d = new Date(now); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10);
      };
      const firstOfMonth = () => { const d = new Date(now); d.setDate(1); return d.toISOString().slice(0, 10); };
      const firstOfYear  = () => { const d = new Date(now); d.setMonth(0, 1); return d.toISOString().slice(0, 10); };
      const map = {
        today:      { since: todayStr,       until: todayStr },
        yesterday:  { since: daysBack(1),    until: daysBack(1) },
        last_7d:    { since: daysBack(6),    until: todayStr },
        last_30d:   { since: daysBack(29),   until: todayStr },
        last_month: { since: (() => { const d = new Date(now); d.setDate(1); d.setMonth(d.getMonth()-1); return d.toISOString().slice(0,10); })(),
                      until: (() => { const d = new Date(now); d.setDate(0); return d.toISOString().slice(0,10); })() },
        this_month: { since: firstOfMonth(), until: todayStr },
        this_year:  { since: firstOfYear(),  until: todayStr },
      };
      const mapped = map[q.date];
      if (mapped) { since = mapped.since; until = mapped.until; }
    }

    const sinceUtc = since ? new Date(new Date(since + 'T00:00:00Z').getTime() - tzMs).toISOString() : undefined;
    const untilUtc = until ? new Date(new Date(until + 'T23:59:59Z').getTime() - tzMs).toISOString() : undefined;

    const [sales, totalEarned] = await Promise.all([
      getSales(user.id, sinceUtc, untilUtc),
      getTotalEarned(user.id),
    ]);

    const approved  = sales.filter(s => s.status === 'approved' || s.status === 'complete');
    // Solo refunded y chargeback son dinero real devuelto; canceled puede no haber sido cobrado nunca
    const refunded  = sales.filter(s => s.status === 'refunded' || s.status === 'chargeback');
    const canceled  = sales.filter(s => s.status === 'canceled');
    const pending   = sales.filter(s => s.status === 'pending');

    // Usar solo commission (comisión real en USD); amount puede estar en COP
    const revenue    = approved.reduce((a, s) => a + (s.commission || 0), 0);
    const refunds    = refunded.reduce((a, s) => a + (s.commission || 0), 0);
    const netRevenue = revenue - refunds;
    const avgTicket  = approved.length ? revenue / approved.length : 0;

    json(res, {
      sales,
      summary: {
        total:      approved.length,
        revenue,
        refunds,
        netRevenue,
        avgTicket,
        pending:    pending.length,
        refunded:   refunded.length,
        canceled:   canceled.length,
        totalEarned,
      },
    });
  },

  // ── Admin: lista de usuarios ─────────────────────────────────────────────────
  '/api/admin/users': async (res, q, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    json(res, await listUsers());
  },

  // ── Admin: actividad reciente (todas las acciones) ───────────────────────────
  '/api/admin/activity': async (res, q, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { data, error } = await supabaseAdmin
      .from('user_activity')
      .select('user_id, action, created_at')
      .order('created_at', { ascending: false })
      .limit(parseInt(q.limit || '100'));
    if (error) return err(res, error.message);
    json(res, data || []);
  },

  // ── Admin: buscar venta (todos los usuarios) por txid o buyer ────────────────
  '/api/admin/find-sale': async (res, q, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    if (!q.txid && !q.buyer) return err(res, 'txid o buyer requerido', 400);
    let query = supabaseAdmin.from('sales').select('*');
    if (q.txid)  query = query.ilike('id', `%${q.txid}%`);
    if (q.buyer) query = query.or(`buyer_name.ilike.%${q.buyer}%,buyer_email.ilike.%${q.buyer}%`);
    const { data } = await query.order('sale_date', { ascending: false }).limit(20);
    json(res, { found: !!(data?.length), sales: data || [] });
  },


  // ── Announcements: obtener activos ───────────────────────────────────────────
  '/api/announcements': async (res, _q, _user) => {
    const { data } = await supabaseAdmin
      .from('announcements')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });
    json(res, data || []);
  },

  // ── UTM: estadísticas de atribución ──────────────────────────────────────────
  '/api/utm/stats': async (res, q, user) => {
    if (!user) return err(res, 'No autorizado', 401);

    const tzH  = parseFloat(q.tz || '0') || 0;
    const tzMs = tzH * 3600000;
    const sinceUtc = q.since ? new Date(new Date(q.since + 'T00:00:00Z').getTime() - tzMs).toISOString() : undefined;
    const untilUtc = q.until ? new Date(new Date(q.until + 'T23:59:59Z').getTime() - tzMs).toISOString() : undefined;

    // group: campaign (default) | adset (utm_term) | content (utm_content/ad)
    const group = q.group === 'content' ? 'utm_content'
                : q.group === 'adset'   ? 'utm_term'
                : 'utm_campaign';

    let clicksQ = supabaseAdmin
      .from('utm_clicks')
      .select('utm_campaign, utm_content, utm_term, clicked_at')
      .eq('user_id', user.id);
    if (sinceUtc) clicksQ = clicksQ.gte('clicked_at', sinceUtc);
    if (untilUtc) clicksQ = clicksQ.lte('clicked_at', untilUtc);

    let salesQ = supabaseAdmin
      .from('sales')
      .select('utm_campaign, utm_content, commission, amount, status, sale_date')
      .eq('user_id', user.id)
      .eq('status', 'approved');
    if (sinceUtc) salesQ = salesQ.gte('sale_date', sinceUtc);
    if (untilUtc) salesQ = salesQ.lte('sale_date', untilUtc);

    const [{ data: clicks }, { data: sales }] = await Promise.all([clicksQ, salesQ]);

    const map = {};
    // Para adset: solo clics tienen utm_term — agrupamos clics por term y cruzamos ventas
    // por campaña+anuncio para heredar el term del click más reciente que coincida
    const clickIndex = {};  // utm_campaign|utm_content → utm_term
    for (const c of clicks || []) {
      if (c.utm_term && c.utm_campaign) {
        const ck = `${c.utm_campaign}|${c.utm_content || ''}`;
        if (!clickIndex[ck]) clickIndex[ck] = c.utm_term;
      }
    }

    const keyFn = (r, fromClicks = false) => {
      if (group === 'utm_term') {
        if (fromClicks) return r.utm_term || '(sin conjunto)';
        // Para ventas, cruzar por campaña+anuncio para recuperar el adset
        const ck = `${r.utm_campaign || ''}|${r.utm_content || ''}`;
        return clickIndex[ck] || '(sin conjunto)';
      }
      return (group === 'utm_content' ? r.utm_content : r.utm_campaign) || '(sin tracking)';
    };

    for (const c of clicks || []) {
      const k = keyFn(c, true);
      if (!map[k]) map[k] = { label: k, clicks: 0, sales: 0, revenue: 0 };
      map[k].clicks++;
    }
    for (const s of sales || []) {
      const k = keyFn(s, false);
      if (!map[k]) map[k] = { label: k, clicks: 0, sales: 0, revenue: 0 };
      map[k].sales++;
      map[k].revenue += s.commission || s.amount || 0;
    }

    const rows = Object.values(map).map(r => ({
      ...r,
      conversion: r.clicks > 0 ? (r.sales / r.clicks) * 100 : null,
      revenuePerClick: r.clicks > 0 ? r.revenue / r.clicks : null,
    })).sort((a, b) => b.revenue - a.revenue);

    json(res, { rows, group });
  },

  // ── Tutoriales: obtener videos configurados ───────────────────────────────────
  '/api/tutorials': async (res, _q, _user) => {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'tutorials')
      .maybeSingle();
    json(res, { videos: data?.value || {} });
  },
};

// ── Rutas POST ────────────────────────────────────────────────────────────────

const POST = {
  // ── Admin: editar comisión/estado de una venta ─────────────────────────────
  '/api/admin/update-sale': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { id, userId, commission, status } = await body(req);
    if (!id || !userId) return err(res, 'id y userId requeridos', 400);
    const updates = {};
    if (commission !== undefined) updates.commission = parseFloat(commission);
    if (status)     updates.status     = status;
    if (!Object.keys(updates).length) return err(res, 'Nada que actualizar', 400);
    const { error } = await supabaseAdmin.from('sales').update(updates).eq('id', id).eq('user_id', userId);
    if (error) return err(res, error.message);
    json(res, { ok: true });
  },

  // ── Admin: eliminar venta ──────────────────────────────────────────────────
  '/api/admin/delete-sale': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { id, userId } = await body(req);
    if (!id || !userId) return err(res, 'id y userId requeridos', 400);
    const { error } = await supabaseAdmin.from('sales').delete().eq('id', id).eq('user_id', userId);
    if (error) return err(res, error.message);
    json(res, { ok: true });
  },

  // ── Ventas: eliminar venta propia (duplicados manuales) ───────────────────────
  '/api/sales/delete': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { id } = await body(req);
    if (!id) return err(res, 'id requerido', 400);
    // Solo puede eliminar sus propias ventas
    const { error } = await supabaseAdmin.from('sales').delete().eq('id', id).eq('user_id', user.id);
    if (error) return err(res, error.message);
    json(res, { ok: true });
  },

  // ── Admin: copiar venta a otro usuario ─────────────────────────────────────
  '/api/admin/copy-sale': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { originalId, targetUserId, commission } = await body(req);
    if (!originalId || !targetUserId) return err(res, 'originalId y targetUserId requeridos', 400);
    const { data: src } = await supabaseAdmin.from('sales').select('*').eq('id', originalId).maybeSingle();
    if (!src) return err(res, 'Venta original no encontrada', 404);
    const newId = `${src.id.split('_')[0]}_${targetUserId.slice(0, 8)}`;
    const copy = {
      ...src,
      id:         newId,
      user_id:    targetUserId,
      commission: commission !== undefined ? parseFloat(commission) : src.commission,
    };
    const { error } = await supabaseAdmin.from('sales').upsert(copy, { onConflict: 'id' });
    if (error) return err(res, error.message);
    json(res, { ok: true, id: newId });
  },

  '/api/pause': async (res, req, user, q) => {
    const { id, token: bt } = await body(req);
    const token = bt || q?.token;
    if (!id) return err(res, 'id requerido', 400);
    json(res, await pauseEntity(id, token));
  },
  '/api/activate': async (res, req, user, q) => {
    const { id, token: bt } = await body(req);
    const token = bt || q?.token;
    if (!id) return err(res, 'id requerido', 400);
    json(res, await activateEntity(id, token));
  },
  '/api/budget': async (res, req, user, q) => {
    const { id, amount, type = 'daily_budget', token: bt } = await body(req);
    const token = bt || q?.token;
    if (!id || !amount) return err(res, 'id y amount requeridos', 400);
    json(res, await setBudget(id, parseInt(amount), type, token));
  },
  '/api/bulk-action': async (res, req, user, q) => {
    const { ids, action, token: bt } = await body(req);
    const token = bt || q?.token;
    if (!ids?.length || !action) return err(res, 'ids y action requeridos', 400);
    const results = await Promise.allSettled(
      ids.map(id => action === 'pause' ? pauseEntity(id, token) : activateEntity(id, token))
    );
    const ok   = results.filter(r => r.status === 'fulfilled').length;
    const fail = results.filter(r => r.status === 'rejected').length;
    json(res, { ok, fail, total: ids.length });
  },

  // ── Auth: login ──────────────────────────────────────────────────────────────
  '/api/auth/login': async (res, req) => {
    const { email, password } = await body(req);
    if (!email || !password) return err(res, 'email y password requeridos', 400);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return err(res, error.message, 401);
    await touchLastLogin(data.user.id);
    logActivity(data.user.id, 'login').catch(() => {});
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('*').eq('id', data.user.id).single();
    json(res, { session: data.session, user: profile });
  },

  // ── Auth: registro ───────────────────────────────────────────────────────────
  '/api/auth/register': async (res, req) => {
    const { email, password, name } = await body(req);
    if (!email || !password) return err(res, 'email y password requeridos', 400);
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) { console.error('[register error]', error); return err(res, error.message, 400); }
    if (!data.session) return err(res, 'Confirma tu email antes de continuar', 400);
    if (name) await saveUserName(data.user.id, name);
    json(res, { session: data.session, user: { id: data.user.id, email, name: name || null } });
  },

  // ── Auth: refresh token ──────────────────────────────────────────────────────
  '/api/auth/refresh': async (res, req) => {
    const { refreshToken } = await body(req);
    if (!refreshToken) return err(res, 'refreshToken requerido', 400);
    const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data.session) return err(res, 'Sesión inválida', 401);
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('*').eq('id', data.user.id).single();
    json(res, { session: data.session, user: profile });
  },

  // ── Auth: olvidé contraseña ──────────────────────────────────────────────────
  '/api/auth/forgot-password': async (res, req) => {
    const { email } = await body(req);
    if (!email) return err(res, 'email requerido', 400);
    const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl}/app?reset=1`,
    });
    if (error) return err(res, error.message, 400);
    json(res, { ok: true });
  },

  // ── Auth: establecer nueva contraseña (con recovery token) ───────────────────
  '/api/auth/set-password': async (res, req) => {
    const { token, password } = await body(req);
    if (!token || !password) return err(res, 'token y password requeridos', 400);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return err(res, 'Token inválido o expirado', 401);
    const { error: upErr } = await supabaseAdmin.auth.admin.updateUserById(data.user.id, { password });
    if (upErr) return err(res, upErr.message, 400);
    json(res, { ok: true });
  },

  // ── Billing: obtener link de pago Hotmart ────────────────────────────────────
  '/api/billing/checkout': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { plan } = await body(req);
    const baseUrl = getCheckoutUrl(plan);
    if (!baseUrl) return err(res, 'Link de pago no configurado para este plan', 503);
    const appUrl = process.env.APP_URL || 'https://app.ka2ia.com';
    const url = `${baseUrl}&redirectUrl=${encodeURIComponent(`${appUrl}/app?upgraded=1`)}`;
    json(res, { url });
  },

  // ── Auth: guardar cuenta seleccionada en el perfil ──────────────────────────
  '/api/auth/save-account': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { accountId } = await body(req);
    if (!accountId) return err(res, 'accountId requerido', 400);
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({ meta_account_id: accountId })
      .eq('id', user.id);
    if (error) return err(res, error.message);
    json(res, { ok: true });
  },

  // ── Auth: guardar token de Meta ──────────────────────────────────────────────
  '/api/auth/save-token': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { metaToken, metaAccountId } = await body(req);
    if (!metaToken) return err(res, 'metaToken requerido', 400);
    await saveUserToken(user.id, metaToken, metaAccountId);
    json(res, { ok: true });
  },

  '/api/auth/clear-token': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    await saveUserToken(user.id, null, null);
    json(res, { ok: true });
  },

  // ── Admin: cambiar role ──────────────────────────────────────────────────────
  '/api/admin/set-role': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { userId, role } = await body(req);
    if (!userId || !role) return err(res, 'userId y role requeridos', 400);
    await setUserRole(userId, role);
    json(res, { ok: true });
  },

  // ── Admin: cambiar plan ──────────────────────────────────────────────────────
  '/api/admin/set-plan': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { userId, plan } = await body(req);
    if (!userId || !plan) return err(res, 'userId y plan requeridos', 400);
    await setUserPlan(userId, plan);
    json(res, { ok: true });
  },

  // ── Admin: eliminar usuario ───────────────────────────────────────────────────
  '/api/admin/delete-user': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { userId } = await body(req);
    if (!userId) return err(res, 'userId requerido', 400);
    await deleteUser(userId);
    json(res, { ok: true });
  },

  // ── Admin: registrar venta manual ─────────────────────────────────────────────
  '/api/admin/manual-sale': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const b = await body(req);
    const { txid, userId, product, buyer, commission, saleDate } = b;
    if (!txid || !userId || !commission) return err(res, 'txid, userId y commission son requeridos', 400);
    const sale = {
      id:           txid,
      user_id:      userId,
      product_name: product || '—',
      buyer_name:   buyer  || null,
      amount:       parseFloat(commission),
      commission:   parseFloat(commission),
      currency:     'USD',
      status:       'approved',
      hotmart_event:'PURCHASE_APPROVED',
      sale_date:    saleDate ? new Date(saleDate).toISOString() : new Date().toISOString(),
    };
    const { error } = await supabaseAdmin.from('sales').upsert(sale, { onConflict: 'id' });
    if (error) return err(res, error.message);
    json(res, { ok: true, sale });
  },

  // ── Admin: guardar videos de tutoriales ──────────────────────────────────────
  '/api/admin/tutorials': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { videos } = await body(req);
    if (!videos || typeof videos !== 'object') return err(res, 'videos requerido', 400);
    const { error } = await supabaseAdmin
      .from('app_settings')
      .upsert({ key: 'tutorials', value: videos }, { onConflict: 'key' });
    if (error) return err(res, error.message);
    json(res, { ok: true });
  },

  // ── Admin: crear announcement ─────────────────────────────────────────────
  '/api/admin/announcements': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const payload = await body(req);
    if (payload._delete) {
      await supabaseAdmin.from('announcements').delete().eq('id', payload.id);
      return json(res, { ok: true });
    }
    const { message, type, emoji } = payload;
    if (!message) return err(res, 'message requerido', 400);
    const { data, error } = await supabaseAdmin
      .from('announcements')
      .insert({ message, type: type || 'info', emoji: emoji || '📢', active: true })
      .select().single();
    if (error) return err(res, error.message);
    json(res, data);
  },

  // ── Admin: toggle announcement activo/inactivo ────────────────────────────
  '/api/admin/announcements/toggle': async (res, req, user) => {
    if (!user || user.role !== 'admin') return err(res, 'No autorizado', 403);
    const { id, active } = await body(req);
    await supabaseAdmin.from('announcements').update({ active }).eq('id', id);
    json(res, { ok: true });
  },

  // ── Auth: actualizar nombre ──────────────────────────────────────────────────
  '/api/auth/save-name': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { name } = await body(req);
    if (!name) return err(res, 'name requerido', 400);
    await saveUserName(user.id, name);
    json(res, { ok: true });
  },

  // ── Actividad: registrar acción del usuario ──────────────────────────────────
  '/api/activity': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { action } = await body(req);
    if (!action) return err(res, 'action requerido', 400);
    logActivity(user.id, action).catch(() => {});
    json(res, { ok: true });
  },

  // ── Push: guardar suscripción ────────────────────────────────────────────────
  '/api/push/subscribe': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { subscription } = await body(req);
    if (!subscription) return err(res, 'subscription requerida', 400);
    await saveSubscription(user.id, subscription);
    json(res, { ok: true });
  },

  // ── Push: notificación de prueba ─────────────────────────────────────────────
  '/api/push/test': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    await sendPushToUser(user.id, {
      title: '🔔 Prueba de notificación',
      body:  '✅ Las notificaciones están funcionando correctamente',
      icon:  '/icon-192.svg',
    });
    json(res, { ok: true });
  },

  // ── Push: disparar manualmente el resumen diario (solo admin) ───────────────
  '/api/push/daily-test': async (res, req, user) => {
    if (user?.role !== 'admin') return err(res, 'No autorizado', 401);
    const { period = 'noon' } = await body(req);
    if (period === 'evening') await sendDailyEvening();
    else                      await sendDailyNoon();
    json(res, { ok: true, period });
  },

  // ── Stripe: guardar Webhook Secret del usuario ──────────────────────────────
  '/api/stripe/save-token': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const isAdmin = user.role === 'admin';
    const allowed = isAdmin || user.plan === 'pro' || user.plan === 'agency';
    if (!allowed) return err(res, 'Disponible solo en Plan Pro o Agencia', 403);
    const { stripeWebhookSecret } = await body(req);
    if (!stripeWebhookSecret) return err(res, 'stripeWebhookSecret requerido', 400);
    await saveStripeToken(user.id, stripeWebhookSecret);
    json(res, { ok: true });
  },

  // ── Hotmart: guardar Hottok del usuario ─────────────────────────────────────
  '/api/hotmart/save-token': async (res, req, user) => {
    if (!user) return err(res, 'No autorizado', 401);
    const { hottok, hotmart_email } = await body(req);
    if (!hottok) return err(res, 'hottok requerido', 400);
    await saveHotmartToken(user.id, hottok, hotmart_email ?? null);
    json(res, { ok: true });
  },

  // ── Webhook Stripe ───────────────────────────────────────────────────────────
  '/webhook/stripe': async (res, req, user, q) => {
    const ownerId   = q?.user_id || null;
    const sigHeader = req.headers['stripe-signature'] || '';

    if (!ownerId) return err(res, 'user_id requerido en la URL', 400);

    // Buscar perfil del usuario para obtener su webhook secret
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('id, role, plan, stripe_webhook_secret')
      .eq('id', ownerId)
      .single();

    if (!profile) return err(res, 'Usuario no encontrado', 404);

    // Solo admin, pro y agency pueden recibir webhooks de Stripe
    const isAdmin = profile.role === 'admin';
    if (!isAdmin && profile.plan !== 'pro' && profile.plan !== 'agency')
      return err(res, 'Plan no compatible con Stripe', 403);

    // Usar secret del usuario o del admin como fallback
    const secret = profile.stripe_webhook_secret || (isAdmin ? process.env.STRIPE_WEBHOOK_SECRET : null);
    if (!secret) return err(res, 'Stripe no configurado para este usuario', 503);

    const rawBuf = await rawBody(req);
    const rawStr = rawBuf.toString('utf8');

    if (!verifyStripeSignature(rawStr, sigHeader, secret)) {
      console.log(`[Stripe] ✗ Firma inválida para user ${ownerId}`);
      return err(res, 'Firma inválida', 401);
    }

    let event;
    try { event = JSON.parse(rawStr); } catch { return err(res, 'JSON inválido', 400); }

    console.log(`[Stripe] Evento: ${event.type} | user: ${ownerId}`);
    const result = await processStripeEvent(event, ownerId);
    console.log(`[Stripe] Resultado:`, JSON.stringify({ ok: result.ok, ignored: result.ignored, status: result.sale?.status }));

    if (result.ok && result.sale) {
      const sale  = result.sale;
      const fmt   = new Intl.NumberFormat('en-US', { style: 'currency', currency: sale.currency || 'USD' });
      const buyer = sale.buyer_name || sale.buyer_email || 'Cliente';
      const comm  = fmt.format(sale.commission || sale.amount || 0);

      if (sale.status === 'approved') {
        sendPushToUser(ownerId, {
          type:  'sale',
          title: '💳 Venta realizada en Stripe',
          body:  `🛍 ${sale.product_name}\n👤 ${buyer}\n💵 ${comm}`,
          icon:  '/icon-192.svg',
          data:  { type: 'sale', product: sale.product_name, buyer, commission: comm },
        }).catch(e => console.error('[Push Stripe]', e.message));
      } else if (sale.status === 'refunded' || sale.status === 'chargeback') {
        const label = sale.status === 'chargeback' ? 'Disputa Stripe' : 'Reembolso Stripe';
        sendPushToUser(ownerId, {
          type:  'cancel',
          title: `⚠️ ${label}`,
          body:  `🛍 ${sale.product_name}\n👤 ${buyer}\n💸 ${comm}`,
          icon:  '/icon-192.svg',
          data:  { type: 'cancel', product: sale.product_name, buyer, amount: comm },
        }).catch(e => console.error('[Push Stripe]', e.message));
      }
    }

    json(res, result);
  },

  // ── Webhook Hotmart ──────────────────────────────────────────────────────────
  '/webhook/hotmart': async (res, req, user, q) => {
    const incomingToken = req.headers['x-hotmart-hottok'] || req.headers['hottok'] || '';
    let ownerId = q?.user_id || null;

    console.log(`[Hotmart] Webhook recibido | user_id=${ownerId || 'none'} | token_len=${incomingToken.length} | token_preview=${incomingToken.slice(0,8)}...`);

    let userEmail = null;

    if (ownerId) {
      // Verificar contra el token del usuario específico
      const { data: profile } = await supabaseAdmin
        .from('profiles').select('id, hotmart_token, email, hotmart_email').eq('id', ownerId).single();
      if (!profile) {
        console.log(`[Hotmart] ✗ user_id ${ownerId} no encontrado en profiles`);
        return err(res, 'Usuario no encontrado', 404);
      }
      // Usar hotmart_email si está configurado, si no caer al email de la cuenta
      userEmail = profile.hotmart_email || profile.email || null;
      const expectedToken = profile.hotmart_token || process.env.HOTMART_TOKEN;
      console.log(`[Hotmart] token_match=${incomingToken === expectedToken} | has_own_token=${!!profile.hotmart_token}`);
      if (incomingToken !== expectedToken) {
        console.log(`[Hotmart] ✗ Token inválido para user ${ownerId}`);
        return err(res, 'Token inválido', 401);
      }
    } else {
      // Fallback al admin: verificar con token global
      if (!verifyHotmartToken(req)) {
        console.log(`[Hotmart] ✗ Token inválido (fallback admin)`);
        return err(res, 'Token inválido', 401);
      }
      const { data: profiles } = await supabaseAdmin
        .from('profiles').select('id, email').eq('role', 'admin').limit(1);
      ownerId = profiles?.[0]?.id || null;
      userEmail = profiles?.[0]?.email || null;
    }

    if (!ownerId) return err(res, 'No hay usuario configurado', 500);

    const payload = await body(req);
    const txid = payload?.data?.purchase?.transaction || '?';
    console.log('[Hotmart] Evento:', payload?.event, '| tx:', txid, '| owner:', ownerId, '| email:', userEmail);
    const result = await processHotmartEvent(payload, ownerId, userEmail);
    console.log('[Hotmart] Resultado:', JSON.stringify({
      ok: result.ok, ignored: result.ignored,
      txid, status: result.sale?.status, commission: result.commission,
      user_id: ownerId,
    }));

    // Notificación push según estado de la venta
    if (result.ok && result.sale) {
      const sale   = result.sale;
      const fmt    = new Intl.NumberFormat('en-US', { style: 'currency', currency: sale.currency || 'USD' });
      const buyer  = sale.buyer_name || sale.buyer_email || 'Cliente';
      const comm   = fmt.format(result.commission || sale.amount || 0);
      const CANCEL = ['canceled', 'refunded', 'chargeback'];

      if (sale.status === 'approved' || sale.status === 'complete') {
        sendPushToUser(ownerId, {
          type:  'sale',
          title: `💰 Venta realizada en Hotmart`,
          body:  `🛍 ${sale.product_name}\n👤 ${buyer}\n💵 Tu comisión: ${comm}`,
          icon:  '/icon-192.svg',
          data:  { type: 'sale', product: sale.product_name, buyer, commission: comm },
        }).catch(e => console.error('[Push]', e.message));
      } else if (CANCEL.includes(sale.status)) {
        const label = sale.status === 'chargeback' ? 'Chargeback' : sale.status === 'refunded' ? 'Reembolso' : 'Cancelación';
        sendPushToUser(ownerId, {
          type:  'cancel',
          title: `⚠️ ${label} en Hotmart`,
          body:  `🛍 ${sale.product_name}\n👤 ${buyer}\n💸 ${comm}`,
          icon:  '/icon-192.svg',
          data:  { type: 'cancel', product: sale.product_name, buyer, amount: comm },
        }).catch(e => console.error('[Push]', e.message));
      }
    }

    json(res, result);
  },
};

// ── Servidor ──────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const url  = req.url || '/';
  const path2 = url.split('?')[0];
  const q    = qs(url);
  const ae   = req.headers['accept-encoding'] || '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': CORS_ORIGIN, 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' });
    return res.end();
  }

  if (path2 === '/')
    return serveFile(res, path.join(PUBLIC, 'landing.html'), 'text/html', ae);
  if (path2 === '/app' || path2 === '/index.html')
    return serveFile(res, path.join(PUBLIC, 'index.html'), 'text/html', ae);

  // Archivos estáticos públicos (enumerados)
  const staticFiles = {
    '/sw.js':               ['text/javascript',  'sw.js'],
    '/manifest.json':       ['application/json', 'manifest.json'],
    '/globals.css':         ['text/css',         'globals.css'],
    '/logo.svg':            ['image/svg+xml',    'logo.svg'],
    '/icon-192.svg':        ['image/svg+xml',    'icon-192.svg'],
    '/icon-512.svg':        ['image/svg+xml',    'icon-512.svg'],
    '/cash-register.wav':   ['audio/wav',        'cash-register.wav'],
    '/cash-register.mp3':   ['audio/mpeg',       'cash-register.mp3'],
  };
  if (staticFiles[path2]) {
    const [mime, file] = staticFiles[path2];
    return serveFile(res, path.join(PUBLIC, file), mime, ae);
  }

  // Archivos estáticos del directorio /brand/ (íconos, SVGs, fuentes)
  const STATIC_EXT = { png:'image/png', svg:'image/svg+xml', webp:'image/webp', ico:'image/x-icon', css:'text/css', woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf' };
  const staticMatch = path2.match(/^\/(brand|fonts)\/[\w.-]+\.(png|svg|webp|ico|css|woff2?|ttf)$/);
  if (staticMatch) {
    const ext = path2.split('.').pop();
    return serveFile(res, path.join(PUBLIC, path2), STATIC_EXT[ext] || 'application/octet-stream', ae);
  }

  // Rutas públicas (no requieren sesión)
  const PUBLIC_ROUTES = [
    '/api/auth/login', '/api/auth/register', '/api/auth/refresh',
    '/api/auth/forgot-password', '/api/auth/set-password',
    '/api/config', '/api/announcements', '/webhook/hotmart', '/webhook/hotmart-billing', '/webhook/stripe', '/r',
  ];

  // Webhook Hotmart billing (compras de planes)
  if (req.method === 'POST' && path2 === '/webhook/hotmart-billing') {
    const token = req.headers['x-hotmart-hottok'] || req.headers['hottok'];
    if (token !== process.env.HOTMART_TOKEN) return err(res, 'Token inválido', 401);
    try {
      const payload = await body(req);
      const result  = await handleBillingWebhook(payload);
      return json(res, result);
    } catch(e) {
      console.error('[Hotmart billing]', e.message);
      return err(res, e.message, 500);
    }
  }

  try {
    // Verificar sesión para rutas privadas
    let user = null;
    if (!PUBLIC_ROUTES.includes(path2)) {
      user = await verifySession(req);
      // Resolver token: explícito en query > token personal > ENV solo si no hay token propio
      if (!q.token) {
        if (user?.meta_token) {
          q.token = user.meta_token;
        } else if (user?.role === 'admin') {
          q.token = process.env.META_ACCESS_TOKEN || null;
        }
        // usuarios sin token ni admin → api.js lanzará error controlado
      }
    }

    if (req.method === 'GET' && GET[path2]) return await GET[path2](res, q, user, null, req);
    if (req.method === 'POST' && POST[path2]) return await POST[path2](res, req, user, q);
  } catch (e) {
    console.error(`[Error] ${path2}:`, e.message);
    return err(res, e.message);
  }

  res.writeHead(404); res.end('Not found');

}).listen(PORT, () => {
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  🎯  Meta Ads Dashboard`);
  console.log(`  →   http://localhost:${PORT}`);
  console.log(`${'─'.repeat(48)}\n`);
  startDailyNotifications();
});

// Evitar que el proceso muera por rechazos no capturados
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});
