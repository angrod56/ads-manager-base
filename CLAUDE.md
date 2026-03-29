# Instrucciones para Claude

Este es el proyecto **Meta Ads Manager** de Angel Rodriguez.

## Skills de Análisis

Cada vez que el usuario pida un análisis de ads, campañas o cuenta publicitaria, DEBES leer y aplicar los siguientes archivos antes de responder:

- `skills/criterios.md` — métricas y umbrales de evaluación
- `skills/procesos.md` — cuándo pausar, escalar o duplicar
- `skills/analisis.md` — plantillas y formato de respuesta

## Reglas Generales

- Siempre analizar los últimos **7 días** como período principal y **3 días** como validación
- El ROAS mínimo aceptable es **1.2x**
- El CTR mínimo aceptable es **2%**
- El CPL máximo para campañas de leads es **$4 USD**
- Pausar ads que gasten **2x el CPA objetivo** sin resultados
- No tocar presupuesto sin esperar **3 días** después del último cambio
- Siempre terminar el análisis con recomendaciones concretas: 🟢 bien / 🔴 pausar / 🔵 acción
