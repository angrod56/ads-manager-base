#!/usr/bin/env node
import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listAccounts, listCampaigns, listAdSets, listAds,
  getInsights, pauseEntity, activateEntity, setBudget,
  getActionValue, calcCPA, getRevenue, getRoas,
  getAdPreview, getAdCreative,
} from './campaigns.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

// ── Helpers HTTP ──────────────────────────────────────────────────────────────

function qs(url) {
  const i = url.indexOf('?');
  return i === -1 ? {} : Object.fromEntries(new URLSearchParams(url.slice(i + 1)));
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function err(res, msg, status = 500) { json(res, { error: msg }, status); }

function serveFile(res, file, type) {
  try {
    res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(404); res.end('Not found'); }
}

async function body(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

// ── Rutas GET ─────────────────────────────────────────────────────────────────

const GET = {

  '/api/config': async (res) => {
    json(res, { defaultAccount: process.env.META_AD_ACCOUNT_ID || null });
  },

  '/api/accounts': async (res) => {
    json(res, await listAccounts());
  },

  '/api/campaigns': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);
    json(res, await listCampaigns(q.account, q.status || 'ALL'));
  },

  '/api/adsets': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);
    json(res, await listAdSets(q.account, q.campaign || null, q.status || 'ALL'));
  },

  '/api/ads': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);
    const parentId = q.adset || q.campaign || q.account;
    const type = q.adset ? 'adset' : q.campaign ? 'campaign' : 'account';
    json(res, await listAds(parentId, type, q.status || 'ALL'));
  },

  '/api/insights': async (res, q) => {
    const entityId = q.id || q.account;
    if (!entityId) return err(res, 'account o id requerido', 400);
    const data = await getInsights(entityId, {
      datePreset: q.date || 'last_30d',
      since: q.since, until: q.until,
      level: q.level || 'ad',
      breakdowns: q.breakdowns,
    });
    json(res, data);
  },

  // Endpoint principal del dashboard — campañas + métricas merged
  '/api/overview': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);

    const [campaigns, insights] = await Promise.all([
      listCampaigns(q.account, 'ALL'),
      getInsights(q.account, { datePreset: q.date || 'last_30d', level: 'campaign' }),
    ]);

    const iMap = {};
    for (const row of insights) iMap[row.campaign_id] = row;

    const enriched = campaigns.map(c => {
      const ins       = iMap[c.id] || {};
      const spend     = parseFloat(ins.spend || 0);
      const purchases     = getActionValue(ins.actions || [], 'purchase');
      // complete_registration = evento de pixel configurado por el usuario (coincide con Ads Manager)
      // lead = auto-tracked por Meta, puede inflar el número — NO usar para CPL
      const registrations = getActionValue(ins.actions || [], 'complete_registration') || 0;
      const revenue       = getRevenue(ins.action_values || []);
      const roas          = getRoas(ins.purchase_roas || [], spend, revenue);
      const cpl           = calcCPA(spend, registrations);
      return {
        ...c,
        spend,
        impressions: parseInt(ins.impressions || 0),
        clicks:      parseInt(ins.clicks || 0),
        purchases,
        registrations,
        revenue,
        roas,
        cpl,
        cpa:       calcCPA(spend, purchases),
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

    json(res, { campaigns: enriched, totals });
  },

  // Insights a nivel ad para drill-down de campaña
  '/api/campaign-ads': async (res, q) => {
    if (!q.campaign) return err(res, 'campaign requerido', 400);
    const data = await getInsights(q.campaign, {
      datePreset: q.date || 'last_30d',
      level: 'ad',
    });
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

    const insights = await getInsights(q.account, {
      datePreset: q.date || 'last_30d',
      level: 'ad',
    });

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
    ).slice(0, parseInt(q.limit || '5'));

    const format = q.format || 'MOBILE_FEED_STANDARD';

    // Preview + creativo en paralelo para cada ad
    const withPreviews = await Promise.all(mapped.map(async ad => {
      const [preview, creative] = await Promise.allSettled([
        getAdPreview(ad.id, format),
        getAdCreative(ad.id),
      ]);
      return {
        ...ad,
        preview:   preview.status   === 'fulfilled' ? preview.value   : null,
        thumbnail: creative.status  === 'fulfilled' ? creative.value?.thumbnail_url || null : null,
        imageUrl:  creative.status  === 'fulfilled' ? creative.value?.image_url     || null : null,
        objectType: creative.status === 'fulfilled' ? creative.value?.object_type   || null : null,
      };
    }));

    json(res, withPreviews);
  },

  // ── Helpers de lanzamientos ──────────────────────────────────────────────────

  // Extrae el nombre del lanzamiento del nombre de campaña
  // Ej: "SANT G2 | Conversiones 2" → "SANT G2"
  //     "WEBINAR 21 - DICIEMBRE 13 DE 2024 // FB" → "WEBINAR 21 - DICIEMBRE 13 DE 2024"

  // ── Endpoint lanzamientos agrupados ──────────────────────────────────────────
  '/api/launches': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);
    const date = q.date || 'last_30d';

    const [campaigns, insights] = await Promise.all([
      listCampaigns(q.account, 'ALL'),
      getInsights(q.account, { datePreset: date, level: 'campaign' }),
    ]);

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
          { stage: 'Impresiones',  value: impressions, rate: null },
          { stage: 'Clics',        value: clicks,      rate: ctr ? ctr.toFixed(1) + '%' : null,    label: 'CTR' },
          { stage: 'Registros',    value: regs,        rate: regRate ? regRate.toFixed(1) + '%' : null, label: 'Tasa reg.' },
          { stage: 'Ventas',       value: purchases,   rate: closeRate ? closeRate.toFixed(1) + '%' : null, label: 'Cierre' },
        ];
      } else if (funnelType === 'leads') {
        funnel = [
          { stage: 'Impresiones',  value: impressions, rate: null },
          { stage: 'Clics',        value: clicks,      rate: ctr ? ctr.toFixed(1) + '%' : null,    label: 'CTR' },
          { stage: 'Leads',        value: leads,       rate: lpRate ? lpRate.toFixed(1) + '%' : null, label: 'Conv. LP' },
          { stage: 'Ventas',       value: purchases,   rate: closeRate ? closeRate.toFixed(1) + '%' : null, label: 'Cierre' },
        ];
      } else {
        funnel = [
          { stage: 'Impresiones',  value: impressions, rate: null },
          { stage: 'Clics',        value: clicks,      rate: ctr ? ctr.toFixed(1) + '%' : null,    label: 'CTR' },
          { stage: 'Compras',      value: purchases,   rate: null },
          { stage: 'Revenue',      value: revenue > 0 ? '$' + revenue.toFixed(0) : 0, rate: roas ? roas.toFixed(2) + 'x' : null, label: 'ROAS' },
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

      return {
        name: g.name, funnelType, isActive,
        campaigns: g.ids.length,
        spend, impressions, clicks, purchases, leads, regs, revenue, reach,
        ctr, cpl, cpa, roas, closeRate,
        funnel, alerts,
      };
    }).filter(Boolean).sort((a, b) => b.spend - a.spend);

    json(res, launches);
  },

  // ── Tendencia diaria de un lanzamiento ───────────────────────────────────────
  '/api/launch-trend': async (res, q) => {
    if (!q.account || !q.launch) return err(res, 'account y launch requeridos', 400);
    const date = q.date || 'last_30d';

    const campaigns = await listCampaigns(q.account, 'ALL');
    const ids = campaigns
      .filter(c => c.name.split(' | ')[0].split(' // ')[0].trim() === q.launch)
      .map(c => c.id);

    if (!ids.length) return json(res, []);

    const allInsights = await Promise.all(
      ids.map(id => getInsights(id, { datePreset: date, level: 'campaign', timeIncrement: '1' }))
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

    const [campaigns7, insights7, insights3] = await Promise.all([
      listCampaigns(q.account, 'ALL'),
      getInsights(q.account, { datePreset: date7, level: 'campaign' }),
      getInsights(q.account, { datePreset: date3, level: 'campaign' }),
    ]);

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
  '/api/countries': async (res, q) => {
    if (!q.account) return err(res, 'account requerido', 400);
    const data = await getInsights(q.account, {
      datePreset: q.date || 'last_30d',
      level: q.level || 'campaign',
      breakdowns: 'country',
    });
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
};

// ── Rutas POST ────────────────────────────────────────────────────────────────

const POST = {
  '/api/pause': async (res, req) => {
    const { id } = await body(req);
    if (!id) return err(res, 'id requerido', 400);
    json(res, await pauseEntity(id));
  },
  '/api/activate': async (res, req) => {
    const { id } = await body(req);
    if (!id) return err(res, 'id requerido', 400);
    json(res, await activateEntity(id));
  },
  '/api/budget': async (res, req) => {
    const { id, amount, type = 'daily_budget' } = await body(req);
    if (!id || !amount) return err(res, 'id y amount requeridos', 400);
    json(res, await setBudget(id, parseInt(amount), type));
  },
};

// ── Servidor ──────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const url  = req.url || '/';
  const path2 = url.split('?')[0];
  const q    = qs(url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (path2 === '/' || path2 === '/index.html')
    return serveFile(res, path.join(PUBLIC, 'index.html'), 'text/html');

  try {
    if (req.method === 'GET' && GET[path2]) return await GET[path2](res, q);
    if (req.method === 'POST' && POST[path2]) return await POST[path2](res, req);
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
});
