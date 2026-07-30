import type { Detection } from './detector.js';

export function shortenHome(path: string | undefined, home: string): string {
  if (!path) return '-';
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function describeDetection(detection: Detection): string {
  switch (detection.kind) {
    case 'none':
      return 'working / idle';
    case 'permission-prompt':
      return 'waiting on permission prompt';
    case 'limit-menu':
    case 'limit-idle': {
      const { resetAt } = detection;
      return resetAt
        ? `limit hit · resets ${pad2(resetAt.getHours())}:${pad2(resetAt.getMinutes())}`
        : 'limit hit';
    }
  }
}

export function formatTable(headers: string[], rows: string[][]): string[] {
  const all = [['#', ...headers], ...rows.map((row, i) => [String(i + 1), ...row])];
  const widths = all[0]!.map((_, col) => Math.max(...all.map((row) => (row[col] ?? '').length)));
  return all.map((row) =>
    row
      .map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!)))
      .join('  ')
      .replace(/\s+$/, '')
      .replace(/^/, '  '),
  );
}
