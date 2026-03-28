#!/usr/bin/env node
/**
 * analyze-countries.js
 * Agrupa gasto e conversiones por país y calcula CPA por país.
 *
 * Uso:
 *   node src/analyze-countries.js --account act_XXXXXXXXXX [--date last_30d] [--level ad]
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

const accountId = getFlag('account') || process.env.META_AD_ACCOUNT_ID;
const datePreset = getFlag('date') || 'last_30d';
const level      = getFlag('level') || 'campaign';
const since      = getFlag('since');
const until      = getFlag('until');
const limitTop   = parseInt(getFlag('top') || '20', 10);

if (!accountId) {
  console.error('\x1b[31mFalta --account act_XXXXXXXXXX o META_AD_ACCOUNT_ID en .env\x1b[0m');
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function analyzeCountries() {
  const timeLabel = since && until ? `${since} → ${until}` : datePreset;

  console.log(`\n${bold(cyan('━'.repeat(64)))}`);
  console.log(`  ${bold(cyan('ANÁLISIS POR PAÍS'))}`);
  console.log(`  ${dim(`Cuenta: ${accountId} | Período: ${timeLabel} | Nivel: ${level}`)}`);
  console.log(`${bold(cyan('━'.repeat(64)))}\n`);

  console.log(dim('Obteniendo datos con breakdown por país...'));

  const insights = await getInsights(accountId, {
    datePreset,
    since,
    until,
    level,
    breakdowns: 'country',
  });

  if (!insights.length) {
    console.log(yellow('Sin datos para el período seleccionado.'));
    return;
  }

  // ─── Agrupar por país ───────────────────────────────────────────────────

  const countryMap = {};

  for (const row of insights) {
    const country    = row.country || 'XX';
    const spend      = parseFloat(row.spend || 0);
    const impressions = parseInt(row.impressions || 0);
    const clicks     = parseInt(row.clicks || 0);
    const purchases  = getActionValue(row.actions, 'purchase');
    const leads      = getActionValue(row.actions, 'lead');
    const reach      = parseInt(row.reach || 0);

    if (!countryMap[country]) {
      countryMap[country] = { country, spend: 0, impressions: 0, clicks: 0, purchases: 0, leads: 0, reach: 0 };
    }

    countryMap[country].spend       += spend;
    countryMap[country].impressions += impressions;
    countryMap[country].clicks      += clicks;
    countryMap[country].purchases   += purchases;
    countryMap[country].leads       += leads;
    countryMap[country].reach       += reach;
  }

  // ─── Calcular métricas derivadas ────────────────────────────────────────

  const countries = Object.values(countryMap).map(c => ({
    ...c,
    cpa:       calcCPA(c.spend, c.purchases),
    cpalead:   calcCPA(c.spend, c.leads),
    ctr:       c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
    cpm:       c.impressions > 0 ? (c.spend / c.impressions) * 1000 : 0,
    roas:      null, // Requiere revenue data (revenue_value en actions)
  }));

  // ─── Ordenar por compras desc, luego por CPA asc ─────────────────────────

  const byPurchases = [...countries].sort((a, b) => {
    if (b.purchases !== a.purchases) return b.purchases - a.purchases;
    if (a.cpa && b.cpa) return a.cpa - b.cpa;
    return b.spend - a.spend;
  });

  const totalSpend     = countries.reduce((s, c) => s + c.spend, 0);
  const totalPurchases = countries.reduce((s, c) => s + c.purchases, 0);

  // ─── Tabla principal ────────────────────────────────────────────────────

  separator('RENDIMIENTO POR PAÍS (ordenado por compras)');

  const rows = byPurchases.slice(0, limitTop).map((c, i) => {
    const rank    = `#${i + 1}`;
    const spendShare = totalSpend > 0 ? (c.spend / totalSpend) * 100 : 0;
    const cpaTxt  = c.cpa ? currency(c.cpa) : dim('—');
    const purchTxt = c.purchases > 0 ? bold(green(number(c.purchases))) : dim('0');

    // Colorear CPA: verde si mejor que promedio, rojo si peor
    const avgCPA = calcCPA(totalSpend, totalPurchases);
    let cpaColored = cpaTxt;
    if (c.cpa && avgCPA) {
      cpaColored = c.cpa <= avgCPA ? green(currency(c.cpa)) : red(currency(c.cpa));
    }

    return [
      dim(col(rank, 4)),
      bold(col(c.country, 6)),
      colR(currency(c.spend)),
      colR(`${spendShare.toFixed(1)}%`),
      colR(number(c.impressions)),
      colR(number(c.clicks)),
      purchTxt,
      cpaColored,
      colR(percent(c.ctr)),
    ];
  });

  printTable(
    ['#', 'País', 'Gasto', '% Total', 'Impr.', 'Clics', 'Compras', 'CPA', 'CTR'],
    rows
  );

  // ─── Resumen global ─────────────────────────────────────────────────────

  separator('RESUMEN GLOBAL');
  const avgCPA = calcCPA(totalSpend, totalPurchases);

  console.log(`  Países con datos:  ${bold(String(countries.length))}`);
  console.log(`  Gasto total:       ${bold(currency(totalSpend))}`);
  console.log(`  Compras totales:   ${bold(number(totalPurchases))}`);
  console.log(`  CPA promedio:      ${bold(avgCPA ? currency(avgCPA) : dim('—'))}`);

  // ─── Top 3 mejores países ────────────────────────────────────────────────

  const withPurchases = countries.filter(c => c.purchases > 0 && c.cpa);
  const bestCPA = [...withPurchases].sort((a, b) => a.cpa - b.cpa).slice(0, 3);
  const worstCPA = [...withPurchases].sort((a, b) => b.cpa - a.cpa).slice(0, 3);

  if (bestCPA.length) {
    separator('TOP 3 MEJOR CPA');
    bestCPA.forEach((c, i) => {
      console.log(`  ${bold(green(`#${i + 1}`))} ${bold(c.country.padEnd(6))}  CPA: ${green(currency(c.cpa))}  Compras: ${green(number(c.purchases))}  Gasto: ${currency(c.spend)}`);
    });
  }

  if (worstCPA.length) {
    separator('TOP 3 PEOR CPA');
    worstCPA.forEach((c, i) => {
      console.log(`  ${bold(red(`#${i + 1}`))} ${bold(c.country.padEnd(6))}  CPA: ${red(currency(c.cpa))}  Compras: ${number(c.purchases)}  Gasto: ${currency(c.spend)}`);
    });
  }

  // ─── Países con gasto sin compras ────────────────────────────────────────

  const noConversions = countries.filter(c => c.spend > 0 && c.purchases === 0);
  if (noConversions.length) {
    separator(`PAÍSES CON GASTO SIN COMPRAS (${noConversions.length})`);
    noConversions
      .sort((a, b) => b.spend - a.spend)
      .forEach(c => {
        console.log(`  ${bold(yellow(c.country.padEnd(6)))}  Gasto: ${yellow(currency(c.spend))}  Impr: ${number(c.impressions)}`);
      });
    console.log(`\n  ${yellow('⚠ Considera pausar o revisar estos países si el gasto es significativo.')}`);
  }

  console.log();
}

analyzeCountries().catch(err => {
  console.error(`\n\x1b[31mERROR:\x1b[0m ${err.message}`);
  process.exit(1);
});
