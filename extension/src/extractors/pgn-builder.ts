/** Writing PGN from a site's game data (used by the page-data extractors). */

export interface BuiltMove {
  san: string;
  /** Clock left after the move, in seconds. */
  clockSeconds?: number | null;
}

/**
 * `[%clk H:MM:SS]`: whole seconds rounded to the nearest, as Lichess exports it (checked
 * against its export of the recorded games); to the nearest tenth when asked.
 */
export function formatClock(seconds: number, tenths = false): string {
  const total = Math.max(0, seconds);
  const whole = tenths ? Math.floor(Math.round(total * 10) / 10) : Math.round(total);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const base = `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!tenths) return base;
  const t = Math.floor(Math.round(total * 10) % 10);
  return t === 0 ? base : `${base}.${t}`;
}

function escapeHeader(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * PGN text: the headers in the given order (empty values left out), then the moves with
 * move numbers and `{ [%clk …] }` comments, then the result.
 */
export function buildPgn(
  headers: ReadonlyArray<readonly [string, string | number | null | undefined]>,
  moves: readonly BuiltMove[],
  result: string,
  options: { startsWithBlack?: boolean; firstMoveNumber?: number; clockTenths?: boolean } = {},
): string {
  const lines = headers
    .filter(([, v]) => v !== null && v !== undefined && String(v) !== '')
    .map(([k, v]) => `[${k} "${escapeHeader(String(v))}"]`);
  const parts: string[] = [];
  let number = options.firstMoveNumber ?? 1;
  let white = !options.startsWithBlack;
  let afterComment = false;
  moves.forEach((move, i) => {
    if (white) parts.push(`${number}. ${move.san}`);
    // A Black move carries its number when it opens the game or follows a comment
    else parts.push(i === 0 || afterComment ? `${number}... ${move.san}` : move.san);
    afterComment = move.clockSeconds !== undefined && move.clockSeconds !== null;
    if (afterComment) {
      parts.push(`{ [%clk ${formatClock(move.clockSeconds!, options.clockTenths)}] }`);
    }
    if (!white) number++;
    white = !white;
  });
  parts.push(result);
  return `${lines.join('\n')}\n\n${parts.join(' ')}\n`;
}

/** "2026.10.04" and "05:33:38" (UTC) from ms since the epoch. */
export function utcDateTime(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  };
}
