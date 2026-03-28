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
      const purchases = getActionValue(ins.actions || [], 'purchase');
      const leads     = getActionValue(ins.actions || [], 'lead');
      const revenue   = getRevenue(ins.action_values || []);
      const roas      = getRoas(ins.purchase_roas || [], spend, revenue);
      return {
        ...c,
        spend,
        impressions: parseInt(ins.impressions || 0),
        clicks:      parseInt(ins.clicks || 0),
        purchases,
        leads,
        revenue,
        roas,
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
        spend:       a.spend + c.spend,
        impressions: a.impressions + c.impressions,
        clicks:      a.clicks + c.clicks,
        purchases:   a.purchases + c.purchases,
        leads:       a.leads + c.leads,
        revenue:     a.revenue + c.revenue,
      }),
      { spend: 0, impressions: 0, clicks: 0, purchases: 0, leads: 0, revenue: 0 }
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
