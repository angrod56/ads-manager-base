// ─── Utilidades de formato para consola ──────────────────────────────────────

export const RESET  = '\x1b[0m';
export const BOLD   = '\x1b[1m';
export const DIM    = '\x1b[2m';
export const GREEN  = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const RED    = '\x1b[31m';
export const CYAN   = '\x1b[36m';
export const BLUE   = '\x1b[34m';
export const MAGENTA = '\x1b[35m';
export const WHITE  = '\x1b[37m';

export function bold(str)    { return `${BOLD}${str}${RESET}`; }
export function dim(str)     { return `${DIM}${str}${RESET}`; }
export function green(str)   { return `${GREEN}${str}${RESET}`; }
export function yellow(str)  { return `${YELLOW}${str}${RESET}`; }
export function red(str)     { return `${RED}${str}${RESET}`; }
export function cyan(str)    { return `${CYAN}${str}${RESET}`; }
export function blue(str)    { return `${BLUE}${str}${RESET}`; }
export function magenta(str) { return `${MAGENTA}${str}${RESET}`; }

/** Separa secciones con una línea decorativa */
export function separator(label = '') {
  const line = '─'.repeat(60);
  if (label) {
    const pad = Math.max(0, 60 - label.length - 4);
    console.log(`\n${CYAN}── ${BOLD}${label}${RESET}${CYAN} ${'─'.repeat(pad)}${RESET}`);
  } else {
    console.log(`${DIM}${line}${RESET}`);
  }
}

/** Formatea número a moneda */
export function currency(value, symbol = '$') {
  const n = parseFloat(value) || 0;
  return `${symbol}${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Formatea número con separadores de miles */
export function number(value) {
  const n = parseFloat(value) || 0;
  return n.toLocaleString('en-US');
}

/** Formatea porcentaje */
export function percent(value, decimals = 2) {
  const n = parseFloat(value) || 0;
  return `${n.toFixed(decimals)}%`;
}

/** Alinea texto en columna izquierda con padding */
export function col(str, width = 30) {
  const s = String(str ?? '');
  return s.length >= width ? s.slice(0, width - 1) + '…' : s.padEnd(width);
}

/** Alinea texto a la derecha */
export function colR(str, width = 12) {
  const s = String(str ?? '');
  return s.length >= width ? s.slice(0, width - 1) + '…' : s.padStart(width);
}

/** Colorea estado de entidad */
export function statusColor(status) {
  switch (status?.toUpperCase()) {
    case 'ACTIVE':   return green(status);
    case 'PAUSED':   return yellow(status);
    case 'ARCHIVED': return dim(status);
    case 'DELETED':  return red(status);
    default:         return dim(status || 'UNKNOWN');
  }
}

/** Convierte centavos a dólares si el valor parece estar en centavos */
export function budgetDisplay(val) {
  if (!val) return dim('—');
  const n = parseFloat(val);
  return currency(n / 100);
}

/** Imprime tabla simple con headers */
export function printTable(headers, rows) {
  const widths = headers.map((h, i) => {
    const maxRow = Math.max(...rows.map(r => String(r[i] ?? '').replace(/\x1b\[[0-9;]*m/g, '').length));
    return Math.max(h.length, maxRow);
  });

  const headerLine = headers.map((h, i) => bold(h.padEnd(widths[i]))).join('  ');
  const divider = widths.map(w => '─'.repeat(w)).join('  ');

  console.log(headerLine);
  console.log(dim(divider));
  for (const row of rows) {
    console.log(row.map((cell, i) => {
      const raw = String(cell ?? '');
      const visible = raw.replace(/\x1b\[[0-9;]*m/g, '');
      const pad = widths[i] - visible.length;
      return raw + ' '.repeat(Math.max(0, pad));
    }).join('  '));
  }
}
