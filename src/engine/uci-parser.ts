import type { Color } from '../core/rules';

export interface UciScore {
  type: 'cp' | 'mate';
  value: number;
  bound?: 'upperbound' | 'lowerbound';
}

export interface UciIdMessage {
  type: 'id';
  field: string;
  value: string;
}

export type UciOptionType = 'check' | 'spin' | 'combo' | 'button' | 'string';

export interface UciOptionMessage {
  type: 'option';
  name: string;
  optionType: UciOptionType;
  defaultValue?: string | number | boolean;
  min?: number;
  max?: number;
  vars?: string[];
}

export interface UciOkMessage {
  type: 'uciok';
}

export interface UciReadyOkMessage {
  type: 'readyok';
}

export interface UciInfoStringMessage {
  type: 'info_string';
  message: string;
}

export interface UciInfoSearchMessage {
  type: 'info';
  depth?: number;
  seldepth?: number;
  multipv?: number;
  score?: UciScore;
  wdl?: [number, number, number];
  nodes?: number;
  nps?: number;
  hashfull?: number;
  tbhits?: number;
  timeMs?: number;
  currmove?: string;
  currmovenumber?: number;
  pv: string[];
  string?: string;
}

export interface UciBestMoveMessage {
  type: 'bestmove';
  bestMove: string | null;
  ponder: string | null;
}

export interface UciPerftDivideMessage {
  type: 'perft_divide';
  move: string;
  nodes: number;
}

export interface UciPerftTotalMessage {
  type: 'perft_total';
  nodes: number;
}

export interface UciUnknownMessage {
  type: 'unknown';
  raw: string;
}

export type UciParsedMessage =
  | UciIdMessage
  | UciOptionMessage
  | UciOkMessage
  | UciReadyOkMessage
  | UciInfoStringMessage
  | UciInfoSearchMessage
  | UciBestMoveMessage
  | UciPerftDivideMessage
  | UciPerftTotalMessage
  | UciUnknownMessage;

const INFO_KEYS = new Set([
  'depth',
  'seldepth',
  'time',
  'nodes',
  'pv',
  'multipv',
  'score',
  'currmove',
  'currmovenumber',
  'hashfull',
  'nps',
  'tbhits',
  'sbhits',
  'cpuload',
  'string',
  'refutation',
  'currline',
  'wdl',
]);

/**
 * Convert a UCI score (cp or mate) into a numeric centipawn equivalent for sorting/comparison.
 * Forced mates are mapped near ±10000 cp so shorter mates always rank higher than longer mates.
 */
export function scoreToCentipawns(score: UciScore): number {
  if (score.type === 'cp') {
    return score.value;
  }
  if (score.value > 0) {
    return 10000 - Math.min(99, score.value) * 10;
  }
  if (score.value < 0) {
    return -10000 + Math.min(99, Math.abs(score.value)) * 10;
  }
  return 0;
}

/**
 * Converts a side-to-move UCI score into White's perspective.
 */
export function scoreForWhite(score: UciScore, sideToMove: Color): UciScore {
  if (sideToMove === 'w') {
    return { ...score };
  }
  const invertedValue = score.value === 0 ? 0 : -score.value;
  const invertedBound =
    score.bound === 'upperbound' ? 'lowerbound' : score.bound === 'lowerbound' ? 'upperbound' : undefined;
  return {
    type: score.type,
    value: invertedValue,
    ...(invertedBound ? { bound: invertedBound } : {}),
  };
}

/**
 * Formats a UCI score as a human-readable string (e.g. "+0.34", "-1.25", "#3", "#-2").
 */
export function formatScore(score: UciScore): string {
  if (score.type === 'mate') {
    return `#${score.value}`;
  }
  const pawns = score.value / 100;
  const sign = pawns > 0 ? '+' : '';
  return `${sign}${pawns.toFixed(2)}`;
}

/**
 * Parses a single line of Stockfish UCI output.
 */
export function parseUciLine(rawLine: string): UciParsedMessage | null {
  const line = rawLine.trim();
  if (!line) {
    return null;
  }

  if (line === 'uciok') {
    return { type: 'uciok' };
  }

  if (line === 'readyok') {
    return { type: 'readyok' };
  }

  // id name ... / id author ...
  if (line.startsWith('id ')) {
    const rest = line.slice(3).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) {
      return { type: 'id', field: rest, value: '' };
    }
    return {
      type: 'id',
      field: rest.slice(0, spaceIdx).trim(),
      value: rest.slice(spaceIdx + 1).trim(),
    };
  }

  // option name <name> type <type> [default <val>] [min <min>] [max <max>] [var <v>...]
  if (line.startsWith('option ')) {
    return parseOptionLine(line);
  }

  // bestmove <move> [ponder <move>]
  if (line.startsWith('bestmove ')) {
    const tokens = line.split(/\s+/);
    const rawBest = tokens[1] ?? '(none)';
    const bestMove = rawBest === '(none)' || rawBest === '0000' || rawBest === 'null' ? null : rawBest;
    let ponder: string | null = null;
    const ponderIdx = tokens.indexOf('ponder');
    if (ponderIdx !== -1 && tokens[ponderIdx + 1]) {
      const rawPonder = tokens[ponderIdx + 1]!;
      if (rawPonder !== '(none)' && rawPonder !== '0000') {
        ponder = rawPonder;
      }
    }
    return {
      type: 'bestmove',
      bestMove,
      ponder,
    };
  }

  // info ...
  if (line.startsWith('info ')) {
    return parseInfoLine(line);
  }

  // Perft total line: "Nodes searched: 8902"
  const perftTotalMatch = line.match(/^Nodes searched:\s*(\d+)$/i);
  if (perftTotalMatch) {
    return {
      type: 'perft_total',
      nodes: Number(perftTotalMatch[1]),
    };
  }

  // Perft divide line: "e2e4: 600" or "e7e8q: 44"
  const perftDivideMatch = line.match(/^([a-h][1-8][a-h][1-8][qrbnQRBN]?):\s*(\d+)$/);
  if (perftDivideMatch) {
    return {
      type: 'perft_divide',
      move: perftDivideMatch[1]!.toLowerCase(),
      nodes: Number(perftDivideMatch[2]),
    };
  }

  return {
    type: 'unknown',
    raw: line,
  };
}

function parseOptionLine(line: string): UciOptionMessage | UciUnknownMessage {
  const typeMatch = line.match(/^option\s+name\s+(.+?)\s+type\s+(check|spin|combo|button|string)(?:\s+(.*))?$/);
  if (!typeMatch) {
    return { type: 'unknown', raw: line };
  }

  const name = typeMatch[1]!.trim();
  const optionType = typeMatch[2]! as UciOptionType;
  const tail = (typeMatch[3] ?? '').trim();

  const msg: UciOptionMessage = {
    type: 'option',
    name,
    optionType,
  };

  if (!tail) {
    return msg;
  }

  if (optionType === 'string') {
    const defMatch = tail.match(/^default\s*(.*)$/);
    if (defMatch) {
      const rawVal = defMatch[1]!.trim();
      msg.defaultValue = rawVal === '<empty>' ? '' : rawVal;
    }
    return msg;
  }

  if (optionType === 'check') {
    const defMatch = tail.match(/\bdefault\s+(true|false)\b/);
    if (defMatch) {
      msg.defaultValue = defMatch[1] === 'true';
    }
    return msg;
  }

  if (optionType === 'spin') {
    const defMatch = tail.match(/\bdefault\s+(-?\d+)\b/);
    const minMatch = tail.match(/\bmin\s+(-?\d+)\b/);
    const maxMatch = tail.match(/\bmax\s+(-?\d+)\b/);
    if (defMatch) msg.defaultValue = Number(defMatch[1]);
    if (minMatch) msg.min = Number(minMatch[1]);
    if (maxMatch) msg.max = Number(maxMatch[1]);
    return msg;
  }

  if (optionType === 'combo') {
    const parts = tail.split(/\s+(?=default\b|var\b)/);
    const vars: string[] = [];
    for (const part of parts) {
      if (part.startsWith('default ')) {
        msg.defaultValue = part.slice('default '.length).trim();
      } else if (part.startsWith('var ')) {
        vars.push(part.slice('var '.length).trim());
      }
    }
    msg.vars = vars;
  }

  return msg;
}

function parseInfoLine(line: string): UciInfoStringMessage | UciInfoSearchMessage {
  const rest = line.slice(5).trim();
  if (rest.startsWith('string ')) {
    return {
      type: 'info_string',
      message: rest.slice(7).trim(),
    };
  }

  const tokens = rest.split(/\s+/);
  const info: UciInfoSearchMessage = {
    type: 'info',
    pv: [],
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i]!;
    switch (token) {
      case 'depth': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.depth = val;
        i += 2;
        break;
      }
      case 'seldepth': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.seldepth = val;
        i += 2;
        break;
      }
      case 'multipv': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.multipv = val;
        i += 2;
        break;
      }
      case 'nodes': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.nodes = val;
        i += 2;
        break;
      }
      case 'nps': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.nps = val;
        i += 2;
        break;
      }
      case 'hashfull': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.hashfull = val;
        i += 2;
        break;
      }
      case 'tbhits': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.tbhits = val;
        i += 2;
        break;
      }
      case 'time': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.timeMs = val;
        i += 2;
        break;
      }
      case 'currmove': {
        if (tokens[i + 1]) info.currmove = tokens[i + 1]!;
        i += 2;
        break;
      }
      case 'currmovenumber': {
        const val = Number(tokens[i + 1]);
        if (!Number.isNaN(val)) info.currmovenumber = val;
        i += 2;
        break;
      }
      case 'wdl': {
        const w = Number(tokens[i + 1]);
        const d = Number(tokens[i + 2]);
        const l = Number(tokens[i + 3]);
        if (!Number.isNaN(w) && !Number.isNaN(d) && !Number.isNaN(l)) {
          info.wdl = [w, d, l];
        }
        i += 4;
        break;
      }
      case 'score': {
        const kind = tokens[i + 1];
        const rawVal = Number(tokens[i + 2]);
        i += 3;
        if ((kind === 'cp' || kind === 'mate') && !Number.isNaN(rawVal)) {
          const score: UciScore = {
            type: kind,
            value: rawVal,
          };
          if (tokens[i] === 'upperbound' || tokens[i] === 'lowerbound') {
            score.bound = tokens[i] as 'upperbound' | 'lowerbound';
            i += 1;
          }
          info.score = score;
        }
        break;
      }
      case 'pv': {
        i += 1;
        const pvMoves: string[] = [];
        while (i < tokens.length && !INFO_KEYS.has(tokens[i]!)) {
          pvMoves.push(tokens[i]!);
          i += 1;
        }
        info.pv = pvMoves;
        break;
      }
      case 'string': {
        info.string = tokens.slice(i + 1).join(' ');
        i = tokens.length;
        break;
      }
      default: {
        i += 1;
        break;
      }
    }
  }

  return info;
}
