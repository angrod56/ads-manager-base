#!/usr/bin/env node
/**
 * analyze-ads.js
 * Analiza ads individuales, detecta top performers, ordena por compras y CPA,
 * y señala qué ads pausar o escalar.
 *
 * Uso:
 *   node src/analyze-ads.js --account act_XXXXXXXXXX [--date last_30d] [--campaign ID]
 */
import 'dotenv/config';
import { getInsights, getActionValue, calcCPA } from './campaigns.js';
import {
  bold, dim, green, yellow, red, cyan, magenta,
  separator, currency, number, percent,
  col, colR, printTable,
} from './format.js';

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getFlag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

const accountId  = getFlag('account') || process.env.META_AD_ACCOUNT_ID;
const datePreset = getFlag('date') || 'last_30d';
const campaignId = getFlag('campaign');
const since      = getFlag('since');
const until      = getFlag('until');
const topN       = parseInt(getFlag('top') || '10', 10);

// Umbrales configurables para señales de escalar/pausar
const MIN_SPEND_TO_JUDGE = parseFloat(getFlag('min-spend') || '20');   // Gasto mínimo para evaluar CPA
const BAD_CPA_MULTIPLIER = parseFloat(getFlag('bad-cpa') || '2');      // CPA x veces el promedio = malo
const GOOD_CPA_MULTIPLIER = parseFloat(getFlag('good-cpa') || '0.7');  // CPA x veces el promedio = excelente
const MIN_PURCHASES_SCALE = parseInt(getFlag('min-purchases') || '3'); // Mín. compras para considerar escalar

if (!accountId) {
  console.error('\x1b[31mFalta --account act_XXXXXXXXXX o META_AD_ACCOUNT_ID en .env\x1b[0m');
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function analyzeAds() {
  const parentId = campaignId || accountId;
  const timeLabel = since && until ? `${since} → ${until}` : datePreset;

  console.log(`\n${bold(cyan('━'.repeat(64)))}`);
  console.log(`  ${bold(cyan('ANÁLISIS DE ADS INDIVIDUALES'))}`);
  console.log(`  ${dim(`Parent: ${parentId} | Período: ${timeLabel}`)}`);
  console.log(`  ${dim(`Umbral CPA alto: x${BAD_CPA_MULTIPLIER}  |  Umbral CPA bueno: x${GOOD_CPA_MULTIPLIER}  |  Gasto mínimo: $${MIN_SPEND_TO_JUDGE}`)}`);
  console.log(`${bold(cyan('━'.repeat(64)))}\n`);

  console.log(dim('Obteniendo insights a nivel de ad...'));

  const insights = await getInsights(parentId, {
    datePreset,
    since,
    until,
    level: 'ad',
  });

  if (!insights.length) {
    console.log(yellow('Sin datos para el período seleccionado.'));
    return;
  }

  // ─── Construir dataset de ads ───────────────────────────────────────────

  const ads = insights.map(row => {
    const spend       = parseFloat(row.spend || 0);
    const impressions = parseInt(row.impressions || 0);
    const clicks      = parseInt(row.clicks || 0);
    const purchases   = getActionValue(row.actions, 'purchase');
    const leads       = getActionValue(row.actions, 'lead');
    const ctr         = parseFloat(row.ctr || 0);
    const cpc         = parseFloat(row.cpc || 0);
    const cpm         = parseFloat(row.cpm || 0);
    const cpa         = calcCPA(spend, purchases);
    const frequency   = parseFloat(row.frequency || 0);

    return {
      id:           row.ad_id,
      name:         row.ad_name || row.ad_id || '—',
      campaignName: row.campaign_name || '—',
      adsetName:    row.adset_name || '—',
      spend,
      impressions,
      clicks,
      purchases,
      leads,
      ctr,
      cpc,
      cpm,
      cpa,
      frequency,
    };
  });

  // Totales
  const totalSpend     = ads.reduce((s, a) => s + a.spend, 0);
  const totalPurchases = ads.reduce((s, a) => s + a.purchases, 0);
  const avgCPA         = calcCPA(totalSpend, totalPurchases);

  // ─── Ordenar por compras ────────────────────────────────────────────────

  const byPurchases = [...ads].sort((a, b) => b.purchases - a.purchases || a.cpa - b.cpa);

  separator(`TOP ${topN} ADS POR COMPRAS`);

  printTable(
    ['#', 'Ad Name', 'Gasto', 'Impr.', 'Clics', 'Compras', 'CPA', 'CTR', 'Frec.'],
    byPurchases.slice(0, topN).map((a, i) => {
      const cpaTxt = a.cpa
        ? (a.cpa <= (avgCPA || Infinity) * GOOD_CPA_MULTIPLIER ? green(currency(a.cpa))
          : a.cpa >= (avgCPA || 0) * BAD_CPA_MULTIPLIER ? red(currency(a.cpa))
          : currency(a.cpa))
        : dim('—');
      return [
        dim(`#${i + 1}`),
        bold(col(a.name, 30)),
        colR(currency(a.spend)),
        colR(number(a.impressions)),
        colR(number(a.clicks)),
        a.purchases > 0 ? bold(green(String(a.purchases))) : dim('0'),
        cpaTxt,
        colR(percent(a.ctr)),
        colR(a.frequency.toFixed(1)),
      ];
    })
  );

  // ─── Ordenar por CPA (solo ads con compras) ─────────────────────────────

  const withPurchases = ads.filter(a => a.purchases > 0 && a.cpa);
  const byCPA = [...withPurchases].sort((a, b) => a.cpa - b.cpa);

  if (byCPA.length > 1) {
    separator(`RANKING POR CPA (mejor → peor)`);
    printTable(
      ['#', 'Ad Name', 'CPA', 'Compras', 'Gasto', 'CTR'],
      byCPA.slice(0, topN).map((a, i) => {
        const isTop = i < 3;
        return [
          isTop ? bold(green(`#${i + 1}`)) : dim(`#${i + 1}`),
          isTop ? bold(green(col(a.name, 32))) : col(a.name, 32),
          isTop ? bold(green(currency(a.cpa))) : currency(a.cpa),
          isTop ? bold(green(String(a.purchases))) : String(a.purchases),
          colR(currency(a.spend)),
          colR(percent(a.ctr)),
        ];
      })
    );
  }

  // ─── Señales: escalar ────────────────────────────────────────────────────

  const toScale = ads.filter(a =>
    a.purchases >= MIN_PURCHASES_SCALE &&
    a.cpa &&
    avgCPA &&
    a.cpa <= avgCPA * GOOD_CPA_MULTIPLIER
  ).sort((a, b) => a.cpa - b.cpa);

  if (toScale.length) {
    separator(`⬆  CANDIDATOS A ESCALAR (CPA ≤ ${GOOD_CPA_MULTIPLIER}x del promedio)`);
    toScale.forEach(a => {
      const saving = avgCPA ? ((avgCPA - a.cpa) / avgCPA * 100).toFixed(1) : '—';
      console.log(`  ${bold(green('▲'))} ${bold(col(a.name, 38))}  CPA: ${bold(green(currency(a.cpa)))}  Compras: ${bold(green(String(a.purchases)))}  ${dim(`(${saving}% bajo el promedio)`)}`);
      console.log(`     ${dim(`ID: ${a.id} | Gasto: ${currency(a.spend)} | CTR: ${percent(a.ctr)}`)}`);
    });
  }

  // ─── Señales: pausar ─────────────────────────────────────────────────────

  const toPause = ads.filter(a => {
    const highCPA = a.cpa && avgCPA && a.cpa >= avgCPA * BAD_CPA_MULTIPLIER && a.spend >= MIN_SPEND_TO_JUDGE;
    const noConversion = a.spend >= MIN_SPEND_TO_JUDGE * 2 && a.purchases === 0;
    return highCPA || noConversion;
  }).sort((a, b) => (b.spend - a.spend));

  if (toPause.length) {
    separator(`⬇  CANDIDATOS A PAUSAR`);
    toPause.forEach(a => {
      const reason = a.purchases === 0
        ? red(`Sin compras con $${currency(a.spend)} gastado`)
        : red(`CPA ${currency(a.cpa)} = ${((a.cpa / avgCPA) * 100 - 100).toFixed(0)}% sobre el promedio`);
      console.log(`  ${bold(red('▼'))} ${bold(col(a.name, 38))}  ${reason}`);
      console.log(`     ${dim(`ID: ${a.id} | Gasto: ${currency(a.spend)} | Impr: ${number(a.impressions)} | CTR: ${percent(a.ctr)}`)}`);
    });
    console.log(`\n  ${dim('Para pausar: node src/cli.js pause --id AD_ID')}`);
  }

  // ─── Ads con frecuencia alta ──────────────────────────────────────────────

  const fatigue = ads.filter(a => a.frequency >= 3.5 && a.impressions > 500);
  if (fatigue.length) {
    separator('⚠  AD FATIGUE (frecuencia ≥ 3.5)');
    fatigue.sort((a, b) => b.frequency - a.frequency).forEach(a => {
      const color = a.frequency >= 5 ? red : yellow;
      console.log(`  ${color('●')} ${col(a.name, 38)}  Frec: ${bold(color(a.frequency.toFixed(1)))}  Impr: ${number(a.impressions)}  CTR: ${percent(a.ctr)}`);
    });
    console.log(`\n  ${dim('Considera refrescar el creativo o ampliar la audiencia.')}`);
  }

  // ─── Resumen ejecutivo ────────────────────────────────────────────────────

  separator('RESUMEN EJECUTIVO');
  console.log(`  Total ads analizados:  ${bold(String(ads.length))}`);
  console.log(`  Gasto total:           ${bold(currency(totalSpend))}`);
  console.log(`  Compras totales:       ${bold(number(totalPurchases))}`);
  console.log(`  CPA promedio:          ${bold(avgCPA ? currency(avgCPA) : dim('—'))}`);
  console.log(`  Ads con compras:       ${bold(String(withPurchases.length))} / ${ads.length}`);
  console.log(`  Candidatos a escalar:  ${bold(green(String(toScale.length)))}`);
  console.log(`  Candidatos a pausar:   ${bold(red(String(toPause.length)))}`);
  if (fatigue.length) console.log(`  Ads con fatiga:        ${bold(yellow(String(fatigue.length)))}`);
  console.log();
}

analyzeAds().catch(err => {
  console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`);
  process.exit(1);
});
