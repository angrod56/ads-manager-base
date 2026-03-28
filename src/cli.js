#!/usr/bin/env node
import 'dotenv/config';
import {
  listAccounts,
  listCampaigns,
  listAdSets,
  listAds,
  getInsights,
  pauseEntity,
  activateEntity,
  setBudget,
  getActionValue,
  calcCPA,
} from './campaigns.js';
import {
  bold, dim, green, yellow, red, cyan,
  separator, currency, number, percent,
  col, colR, statusColor, printTable,
} from './format.js';

// ─── Parser de args ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

const accountId = getFlag('account') || process.env.META_AD_ACCOUNT_ID;
const campaignId = getFlag('campaign');
const adsetId   = getFlag('adset');
const entityId  = getFlag('id');
const status    = getFlag('status') || 'ALL';
const datePreset = getFlag('date') || 'last_30d';
const level     = getFlag('level') || 'campaign';
const since     = getFlag('since');
const until     = getFlag('until');

// ─── Helpers de display ───────────────────────────────────────────────────────

function requireAccountId() {
  if (!accountId) {
    console.error(red('Falta --account act_XXXXXXXXXX o META_AD_ACCOUNT_ID en .env'));
    process.exit(1);
  }
}

function requireEntityId() {
  if (!entityId) {
    console.error(red('Falta --id ENTITY_ID'));
    process.exit(1);
  }
}

function header(title, subtitle = '') {
  console.log(`\n${bold(cyan('━'.repeat(64)))}`);
  console.log(`  ${bold(cyan(title))}`);
  if (subtitle) console.log(`  ${dim(subtitle)}`);
  console.log(`${bold(cyan('━'.repeat(64)))}\n`);
}

// ─── Comandos ─────────────────────────────────────────────────────────────────

async function cmdAccounts() {
  header('CUENTAS PUBLICITARIAS', '/me/adaccounts');
  const accounts = await listAccounts();

  if (!accounts.length) {
    console.log(yellow('No se encontraron cuentas.'));
    return;
  }

  const statusMap = { 1: green('ACTIVA'), 2: yellow('DESACTIVADA'), 3: dim('NO CONFIRMADA'), 7: red('PENDIENTE'), 9: red('CERRADA') };

  printTable(
    ['ID Cuenta', 'Nombre', 'Estado', 'Moneda', 'Zona Horaria', 'Gastado'],
    accounts.map(a => [
      dim(a.id),
      bold(col(a.name, 32)),
      statusMap[a.account_status] || dim(String(a.account_status)),
      a.currency || '—',
      col(a.timezone_name || '—', 22),
      currency(parseFloat(a.amount_spent || 0) / 100),
    ])
  );

  console.log(`\n${dim(`Total: ${accounts.length} cuenta(s)`)}`);
}

async function cmdCampaigns() {
  requireAccountId();
  header('CAMPAÑAS', `Cuenta: ${accountId} | Status: ${status} | Período: ${datePreset}`);

  const campaigns = await listCampaigns(accountId, status);

  if (!campaigns.length) {
    console.log(yellow('No se encontraron campañas.'));
    return;
  }

  printTable(
    ['ID', 'Nombre', 'Estado', 'Objetivo', 'Presup. Diario', 'Presup. Lifetime'],
    campaigns.map(c => [
      dim(col(c.id, 18)),
      bold(col(c.name, 35)),
      statusColor(c.effective_status),
      col(c.objective || '—', 20),
      c.daily_budget ? currency(parseFloat(c.daily_budget) / 100) : dim('—'),
      c.lifetime_budget ? currency(parseFloat(c.lifetime_budget) / 100) : dim('—'),
    ])
  );

  console.log(`\n${dim(`Total: ${campaigns.length} campaña(s)`)}`);
}

async function cmdAdSets() {
  requireAccountId();
  header('AD SETS', `Cuenta: ${accountId} | Campaña: ${campaignId || 'todas'} | Status: ${status}`);

  const adsets = await listAdSets(accountId, campaignId, status);

  if (!adsets.length) {
    console.log(yellow('No se encontraron ad sets.'));
    return;
  }

  printTable(
    ['ID', 'Nombre', 'Estado', 'Objetivo Opt.', 'Presup. Diario', 'Billing'],
    adsets.map(s => [
      dim(col(s.id, 18)),
      bold(col(s.name, 32)),
      statusColor(s.effective_status),
      col(s.optimization_goal || '—', 20),
      s.daily_budget ? currency(parseFloat(s.daily_budget) / 100) : dim('—'),
      col(s.billing_event || '—', 14),
    ])
  );

  console.log(`\n${dim(`Total: ${adsets.length} ad set(s)`)}`);
}

async function cmdAds() {
  requireAccountId();
  const parentId = adsetId || campaignId || accountId;
  const type = adsetId ? 'adset' : campaignId ? 'campaign' : 'account';
  header('ADS', `Parent: ${parentId} (${type}) | Status: ${status}`);

  const ads = await listAds(parentId, type, status);

  if (!ads.length) {
    console.log(yellow('No se encontraron ads.'));
    return;
  }

  printTable(
    ['ID', 'Nombre', 'Estado', 'Ad Set ID', 'Creado'],
    ads.map(a => [
      dim(col(a.id, 18)),
      bold(col(a.name, 35)),
      statusColor(a.effective_status),
      dim(col(a.adset_id, 18)),
      dim(a.created_time ? a.created_time.slice(0, 10) : '—'),
    ])
  );

  console.log(`\n${dim(`Total: ${ads.length} ad(s)`)}`);
}

async function cmdInsights() {
  if (!entityId) requireAccountId();
  const parentId = entityId || accountId;
  const timeLabel = since && until ? `${since} → ${until}` : datePreset;
  header('INSIGHTS', `Entidad: ${parentId} | Nivel: ${level} | Período: ${timeLabel}`);

  const insights = await getInsights(parentId, { datePreset, since, until, level });

  if (!insights.length) {
    console.log(yellow('Sin datos para el período seleccionado.'));
    return;
  }

  // Totales generales
  let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalPurchases = 0;

  const rows = insights.map(row => {
    const spend       = parseFloat(row.spend || 0);
    const impressions = parseInt(row.impressions || 0);
    const clicks      = parseInt(row.clicks || 0);
    const purchases   = getActionValue(row.actions, 'purchase');
    const cpa         = calcCPA(spend, purchases);
    const ctr         = parseFloat(row.ctr || 0);

    totalSpend       += spend;
    totalImpressions += impressions;
    totalClicks      += clicks;
    totalPurchases   += purchases;

    const name = row.ad_name || row.adset_name || row.campaign_name || row.account_id || '—';

    return [
      col(name, 32),
      colR(currency(spend)),
      colR(number(impressions)),
      colR(number(clicks)),
      colR(purchases ? number(purchases) : dim('0')),
      colR(cpa ? currency(cpa) : dim('—')),
      colR(percent(ctr)),
    ];
  });

  printTable(
    ['Nombre', 'Gasto', 'Impresiones', 'Clics', 'Compras', 'CPA', 'CTR'],
    rows
  );

  separator('TOTALES');
  const avgCPA = calcCPA(totalSpend, totalPurchases);
  console.log(`  Gasto total:    ${bold(currency(totalSpend))}`);
  console.log(`  Impresiones:    ${number(totalImpressions)}`);
  console.log(`  Clics:          ${number(totalClicks)}`);
  console.log(`  Compras:        ${bold(number(totalPurchases))}`);
  console.log(`  CPA promedio:   ${bold(avgCPA ? currency(avgCPA) : dim('—'))}`);
  console.log();
}

async function cmdPause() {
  requireEntityId();
  console.log(`\n${yellow('Pausando')} ${bold(entityId)}...`);
  const result = await pauseEntity(entityId);
  if (result.success) {
    console.log(green(`✓ Entidad ${entityId} pausada correctamente.`));
  } else {
    console.log(yellow('Respuesta:'), result);
  }
}

async function cmdActivate() {
  requireEntityId();
  console.log(`\n${green('Activando')} ${bold(entityId)}...`);
  const result = await activateEntity(entityId);
  if (result.success) {
    console.log(green(`✓ Entidad ${entityId} activada correctamente.`));
  } else {
    console.log(yellow('Respuesta:'), result);
  }
}

async function cmdBudget() {
  requireEntityId();
  const amount = getFlag('amount');
  const type   = getFlag('type') || 'daily_budget';

  if (!amount) {
    console.error(red('Falta --amount MONTO_EN_CENTAVOS  (ej: 1000 = $10.00)'));
    process.exit(1);
  }

  console.log(`\nActualizando presupuesto de ${bold(entityId)}...`);
  console.log(`  Tipo:   ${bold(type)}`);
  console.log(`  Monto:  ${bold(currency(parseFloat(amount) / 100))}`);

  const result = await setBudget(entityId, parseInt(amount), type);
  if (result.success) {
    console.log(green(`\n✓ Presupuesto actualizado correctamente.`));
  } else {
    console.log(yellow('Respuesta:'), result);
  }
}

function cmdHelp() {
  header('META ADS MANAGER CLI', 'Gestión de campañas desde terminal');

  const commands = [
    ['accounts',  '', 'Lista todas las cuentas publicitarias'],
    ['campaigns', '--account act_XXX [--status ACTIVE|PAUSED|ALL]', 'Lista campañas'],
    ['adsets',    '--account act_XXX [--campaign ID] [--status]', 'Lista ad sets'],
    ['ads',       '--account act_XXX [--campaign ID | --adset ID]', 'Lista ads'],
    ['insights',  '--account act_XXX [--level campaign|ad] [--date last_7d]', 'Métricas y resultados'],
    ['pause',     '--id ENTITY_ID', 'Pausa campaña, ad set o ad'],
    ['activate',  '--id ENTITY_ID', 'Activa campaña, ad set o ad'],
    ['budget',    '--id ENTITY_ID --amount CENTAVOS [--type daily_budget]', 'Cambia presupuesto'],
    ['analyze-countries', '(ver src/analyze-countries.js)', 'Análisis por país'],
    ['analyze-ads',       '(ver src/analyze-ads.js)', 'Análisis de ads individuales'],
  ];

  console.log(`${bold('COMANDOS DISPONIBLES')}\n`);
  for (const [cmd, flags, desc] of commands) {
    console.log(`  ${bold(cyan(col(cmd, 18)))} ${dim(col(flags, 45))} ${desc}`);
  }

  console.log(`\n${bold('EJEMPLOS')}\n`);
  console.log(`  ${dim('# Ver cuentas')}`);
  console.log(`  node src/cli.js accounts\n`);
  console.log(`  ${dim('# Ver campañas activas')}`);
  console.log(`  node src/cli.js campaigns --account act_123 --status ACTIVE\n`);
  console.log(`  ${dim('# Insights últimos 7 días a nivel ad')}`);
  console.log(`  node src/cli.js insights --account act_123 --level ad --date last_7d\n`);
  console.log(`  ${dim('# Pausar campaña')}`);
  console.log(`  node src/cli.js pause --id 123456789\n`);
  console.log(`  ${dim('# Cambiar presupuesto diario a $20')}`);
  console.log(`  node src/cli.js budget --id 123456789 --amount 2000 --type daily_budget\n`);
}

// ─── Router principal ─────────────────────────────────────────────────────────

const router = {
  accounts:  cmdAccounts,
  campaigns: cmdCampaigns,
  adsets:    cmdAdSets,
  ads:       cmdAds,
  insights:  cmdInsights,
  pause:     cmdPause,
  activate:  cmdActivate,
  budget:    cmdBudget,
  help:      cmdHelp,
};

if (!command || !(command in router)) {
  cmdHelp();
  process.exit(0);
}

router[command]().catch(err => {
  console.error(`\n${red('ERROR:')} ${err.message}`);
  if (hasFlag('debug')) console.error(err);
  process.exit(1);
});
