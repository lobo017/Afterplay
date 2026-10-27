import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  normalizeFenToEpd,
  type EndgamePositionEntry,
  type OpeningsMap,
  type PuzzleEntry,
} from '../../src/core/datasets';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..', '..');
const dataDir = path.join(rootDir, 'data');

describe('Phase 0 — Scaffold, Licensing & Datasets', () => {
  it('normalizes 6-field FEN into 4-field EPD', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
    expect(normalizeFenToEpd(startFen)).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3');
  });

  it('includes GPL-3.0-or-later LICENSE and LICENSES inventory', () => {
    const licensePath = path.join(rootDir, 'LICENSE');
    const licensesReadmePath = path.join(rootDir, 'LICENSES', 'README.md');
    expect(fs.existsSync(licensePath)).toBe(true);
    expect(fs.existsSync(licensesReadmePath)).toBe(true);

    const licenseText = fs.readFileSync(licensePath, 'utf8');
    expect(licenseText).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(licenseText).toContain('Version 3');

    const inventoryText = fs.readFileSync(licensesReadmePath, 'utf8');
    expect(inventoryText).toContain('stockfish');
    expect(inventoryText).toContain('chess.js');
    expect(inventoryText).toContain('idb');
    expect(inventoryText).toContain('CC0-1.0');
  });

  it('validates generated openings dataset (data/openings.json)', () => {
    const openingsPath = path.join(dataDir, 'openings.json');
    expect(fs.existsSync(openingsPath)).toBe(true);

    const raw = fs.readFileSync(openingsPath, 'utf8');
    const openings = JSON.parse(raw) as OpeningsMap;
    const keys = Object.keys(openings);
    expect(keys.length).toBeGreaterThan(2500);

    // Verify Sicilian Defense (1. e4 c5) is present and keyed by EPD
    const chess = new Chess();
    chess.move('e4');
    chess.move('c5');
    const sicilianEpd = normalizeFenToEpd(chess.fen());
    const sicilian = openings[sicilianEpd];
    expect(sicilian).toBeDefined();
    expect(sicilian?.eco).toBe('B20');
    expect(sicilian?.name).toContain('Sicilian');
    expect(sicilian?.moves).toEqual(['e4', 'c5']);
  });

  it('validates generated endgames dataset (data/endgames.json)', () => {
    const endgamesPath = path.join(dataDir, 'endgames.json');
    expect(fs.existsSync(endgamesPath)).toBe(true);

    const endgames = JSON.parse(fs.readFileSync(endgamesPath, 'utf8')) as EndgamePositionEntry[];
    expect(endgames.length).toBeGreaterThanOrEqual(6);

    const requiredCategories = ['K+Q v K', 'K+R v K', 'K+P opposition', 'Lucena', 'Philidor', 'R+P v R'];
    for (const cat of requiredCategories) {
      expect(endgames.some((e) => e.category === cat)).toBe(true);
    }

    for (const pos of endgames) {
      const chess = new Chess(pos.fen);
      expect(chess.isGameOver()).toBe(false);
      expect(chess.turn()).toBe(pos.sideToMove);
      expect(chess.moves().length).toBeGreaterThan(0);
    }
  });

  it('validates generated stratified Lichess puzzles dataset (data/puzzles.json)', () => {
    const puzzlesPath = path.join(dataDir, 'puzzles.json');
    expect(fs.existsSync(puzzlesPath)).toBe(true);

    const puzzles = JSON.parse(fs.readFileSync(puzzlesPath, 'utf8')) as PuzzleEntry[];
    expect(puzzles.length).toBe(20000);

    // Check stratification across rating bands
    const under1000 = puzzles.filter((p) => p.rating < 1000).length;
    const midRange = puzzles.filter((p) => p.rating >= 1400 && p.rating < 1800).length;
    const highRated = puzzles.filter((p) => p.rating >= 2200).length;
    expect(under1000).toBeGreaterThan(500);
    expect(midRange).toBeGreaterThan(1000);
    expect(highRated).toBeGreaterThan(500);

    // Spot-check that FEN is before opponent's move (moves[0]) and moves[1] is also legal
    for (let i = 0; i < 25; i++) {
      const sample = puzzles[i * 750];
      expect(sample).toBeDefined();
      if (!sample) continue;
      expect(sample.moves.length).toBeGreaterThanOrEqual(2);
      expect(sample.themes.length).toBeGreaterThan(0);

      const chess = new Chess(sample.fen);
      const oppMove = sample.moves[0]!;
      const m0 = chess.move({
        from: oppMove.slice(0, 2),
        to: oppMove.slice(2, 4),
        promotion: oppMove.slice(4, 5) || undefined,
      });
      expect(m0).not.toBeNull();

      const playerFirstMove = sample.moves[1]!;
      const m1 = chess.move({
        from: playerFirstMove.slice(0, 2),
        to: playerFirstMove.slice(2, 4),
        promotion: playerFirstMove.slice(4, 5) || undefined,
      });
      expect(m1).not.toBeNull();
    }
  });
});
