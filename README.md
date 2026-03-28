# Meta Ads Manager CLI

Gestión completa de campañas de Meta Ads desde la terminal.

## Requisitos

- Node.js 18+
- Token de acceso de Meta (Marketing API)

## Instalación

```bash
npm install
```

## Configuración

Edita el archivo `.env`:

```env
META_ACCESS_TOKEN=tu_token_aqui
META_API_VERSION=v21.0
META_AD_ACCOUNT_ID=act_XXXXXXXXXX   # opcional, evita escribirlo en cada comando
```

Para obtener tu token:
1. Ve a [Meta for Developers](https://developers.facebook.com/)
2. Abre el Graph API Explorer
3. Selecciona tu app y genera un token con permisos: `ads_read`, `ads_management`

---

## Comandos disponibles

### Ver cuentas publicitarias
```bash
node src/cli.js accounts
```

### Ver campañas
```bash
node src/cli.js campaigns --account act_XXXXXXXXXX
node src/cli.js campaigns --account act_XXXXXXXXXX --status ACTIVE
node src/cli.js campaigns --account act_XXXXXXXXXX --status PAUSED
```

### Ver ad sets
```bash
node src/cli.js adsets --account act_XXXXXXXXXX
node src/cli.js adsets --account act_XXXXXXXXXX --campaign CAMPAIGN_ID
node src/cli.js adsets --account act_XXXXXXXXXX --status ACTIVE
```

### Ver ads
```bash
node src/cli.js ads --account act_XXXXXXXXXX
node src/cli.js ads --account act_XXXXXXXXXX --campaign CAMPAIGN_ID
node src/cli.js ads --account act_XXXXXXXXXX --adset ADSET_ID
```

### Ver insights (métricas)
```bash
# Nivel campaña, últimos 30 días (default)
node src/cli.js insights --account act_XXXXXXXXXX

# Nivel ad, últimos 7 días
node src/cli.js insights --account act_XXXXXXXXXX --level ad --date last_7d

# Rango de fechas personalizado
node src/cli.js insights --account act_XXXXXXXXXX --level campaign --since 2024-01-01 --until 2024-01-31

# Insights de una campaña o ad set específico
node src/cli.js insights --id CAMPAIGN_ID --level adset
```

**Opciones de `--date`:**
- `today`, `yesterday`
- `last_7d`, `last_14d`, `last_30d`
- `last_month`, `this_month`
- `last_quarter`, `this_year`

**Opciones de `--level`:**
- `account`, `campaign`, `adset`, `ad`

### Pausar entidad
```bash
node src/cli.js pause --id ENTITY_ID
```

### Activar entidad
```bash
node src/cli.js activate --id ENTITY_ID
```

### Cambiar presupuesto
```bash
# Presupuesto diario a $20.00 (monto en centavos)
node src/cli.js budget --id ENTITY_ID --amount 2000 --type daily_budget

# Presupuesto lifetime a $500.00
node src/cli.js budget --id ENTITY_ID --amount 50000 --type lifetime_budget
```

> **Nota:** Los montos se expresan en centavos: `2000` = $20.00 USD

---

## Scripts de análisis

### Análisis por país
Agrupa gasto, compras y CPA por país. Identifica países eficientes e ineficientes.

```bash
node src/analyze-countries.js --account act_XXXXXXXXXX
node src/analyze-countries.js --account act_XXXXXXXXXX --date last_7d
node src/analyze-countries.js --account act_XXXXXXXXXX --since 2024-01-01 --until 2024-01-31
node src/analyze-countries.js --account act_XXXXXXXXXX --top 15
```

**Salida:**
- Tabla con gasto, compras, CPA, CTR por país
- Top 3 mejor CPA
- Top 3 peor CPA
- Países con gasto sin conversiones

### Análisis de ads individuales
Evalúa cada ad y genera señales de acción.

```bash
node src/analyze-ads.js --account act_XXXXXXXXXX
node src/analyze-ads.js --account act_XXXXXXXXXX --date last_7d
node src/analyze-ads.js --account act_XXXXXXXXXX --campaign CAMPAIGN_ID

# Personalizar umbrales
node src/analyze-ads.js --account act_XXXXXXXXXX \
  --min-spend 30 \        # gasto mínimo para evaluar ($)
  --bad-cpa 2.5 \         # CPA x veces promedio = malo
  --good-cpa 0.6 \        # CPA x veces promedio = excelente
  --min-purchases 5       # mín. compras para escalar
```

**Salida:**
- Top N ads por compras
- Ranking por CPA
- Candidatos a escalar (CPA excelente)
- Candidatos a pausar (CPA alto o sin conversiones)
- Ads con ad fatigue (frecuencia alta)
- Resumen ejecutivo

---

## Estructura del proyecto

```
ads-manager/
├── src/
│   ├── api.js                # Cliente HTTP base (Meta Marketing API)
│   ├── campaigns.js          # Funciones de la API (listar, pausar, etc.)
│   ├── cli.js                # CLI principal con router de comandos
│   ├── format.js             # Utilidades de formato para consola
│   ├── analyze-countries.js  # Análisis de rendimiento por país
│   └── analyze-ads.js        # Análisis de ads individuales
├── .env                      # Credenciales (no subir a git)
├── .gitignore
├── package.json
└── README.md
```

---

## Debug

Agrega `--debug` a cualquier comando para ver el stack trace completo en caso de error:

```bash
node src/cli.js campaigns --account act_XXX --debug
```

---

## Permisos requeridos del token

| Permiso | Para qué |
|---|---|
| `ads_read` | Listar campañas, insights, cuentas |
| `ads_management` | Pausar, activar, cambiar presupuesto |
| `business_management` | Acceso a cuentas de Business Manager |

---

## Notas sobre la API

- Los presupuestos en Meta API siempre están en **centavos** de la moneda de la cuenta
- Los insights tienen un delay de ~2 horas (datos de "hoy" son aproximados)
- El rate limit es de ~200 llamadas por hora por token
- La versión de API recomendada es `v21.0`
