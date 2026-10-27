import { describe, expect, it } from 'vitest';
import {
  contentHash,
  gameKey,
  gameUrl,
  isGameKey,
  parseGameUrl,
  pasteKey,
  refFromPgnHeaders,
} from '../../src/capture/game-id';
import { checkPgnText, splitPgnGames } from '../../src/capture/pgn-games';

describe('Phase 5b — game IDs', () => {
  it('reads Lichess game links in their usual forms', () => {
    const lichess = (gameId: string) => ({ site: 'lichess', gameId });
    expect(parseGameUrl('https://lichess.org/Bjl39T9x')).toEqual(lichess('Bjl39T9x'));
    expect(parseGameUrl('https://lichess.org/Bjl39T9xAbCd')).toEqual(lichess('Bjl39T9x'));
    expect(parseGameUrl('https://lichess.org/Bjl39T9x/black#12')).toEqual(lichess('Bjl39T9x'));
    expect(parseGameUrl('https://lichess.org/game/export/Bjl39T9x?clocks=true')).toEqual(lichess('Bjl39T9x'));
    expect(parseGameUrl('https://lichess.org/embed/game/Bjl39T9x')).toEqual(lichess('Bjl39T9x'));
    // Site pages with 8-letter names, other paths, other hosts
    for (const url of [
      'https://lichess.org/analysis',
      'https://lichess.org/training',
      'https://lichess.org/streamer',
      'https://lichess.org/@/Lobo017',
      'https://lichess.org/Bjl39T9x/moves',
      'https://lichess.org/tv',
      'https://lichess.org.evil.com/Bjl39T9x',
      'ftp://lichess.org/Bjl39T9x',
      'not a url',
    ]) {
      expect(parseGameUrl(url), url).toBeNull();
    }
  });

  it('reads Chess.com game links and keeps live and daily IDs apart', () => {
    const cc = (gameId: string) => ({ site: 'chesscom', gameId });
    expect(parseGameUrl('https://www.chess.com/game/live/185518487990')).toEqual(cc('live-185518487990'));
    expect(parseGameUrl('https://www.chess.com/game/daily/1036320138')).toEqual(cc('daily-1036320138'));
    expect(parseGameUrl('https://www.chess.com/live/game/185518487990')).toEqual(cc('live-185518487990'));
    expect(parseGameUrl('https://www.chess.com/daily/game/1036320138')).toEqual(cc('daily-1036320138'));
    expect(parseGameUrl('https://www.chess.com/analysis/game/live/185518487990?tab=review')).toEqual(
      cc('live-185518487990'),
    );
    expect(parseGameUrl('https://chess.com/game/185518487990')).toEqual(cc('live-185518487990'));
    expect(parseGameUrl('https://www.chess.com/live#g=185518487990')).toEqual(cc('live-185518487990'));
    expect(parseGameUrl('https://www.chess.com/member/hikaru')).toBeNull();
    expect(parseGameUrl('https://www.chess.com/game/live/abc')).toBeNull();
  });

  it('builds canonical URLs and keys, and validates keys', () => {
    expect(gameUrl({ site: 'lichess', gameId: 'Bjl39T9x' })).toBe('https://lichess.org/Bjl39T9x');
    expect(gameUrl({ site: 'chesscom', gameId: 'daily-1036320138' })).toBe(
      'https://www.chess.com/game/daily/1036320138',
    );
    expect(gameKey({ site: 'chesscom', gameId: 'live-1' })).toBe('chesscom:live-1');
    expect(isGameKey('lichess:Bjl39T9x')).toBe(true);
    expect(isGameKey('chesscom:live-185518487990')).toBe(true);
    expect(isGameKey('paste:0123456789abcdef')).toBe(true);
    for (const bad of [
      'lichess:analysis',
      'lichess:short',
      'chesscom:185518487990',
      'paste:xyz',
      'other:Bjl39T9x',
      '',
    ]) {
      expect(isGameKey(bad), bad).toBe(false);
    }
  });

  it('finds the site game a PGN names', () => {
    expect(refFromPgnHeaders({ Site: 'https://lichess.org/Bjl39T9x' })).toEqual({
      site: 'lichess',
      gameId: 'Bjl39T9x',
    });
    expect(refFromPgnHeaders({ Site: 'lichess.org', GameId: 'Bjl39T9x' })).toEqual({
      site: 'lichess',
      gameId: 'Bjl39T9x',
    });
    expect(refFromPgnHeaders({ Site: 'Chess.com', Link: 'https://www.chess.com/game/live/185518487990' })).toEqual({
      site: 'chesscom',
      gameId: 'live-185518487990',
    });
    expect(refFromPgnHeaders({ Site: 'Paris FRA' })).toBeNull();
  });

  it('gives a game without a site ID a stable key from players, date and moves', () => {
    const a = pasteKey({ White: 'A', Black: 'B', Date: '2026.01.01' }, ['e4', 'e5']);
    expect(a).toMatch(/^paste:[0-9a-f]{16}$/);
    expect(pasteKey({ White: 'A', Black: 'B', Date: '2026.01.01' }, ['e4', 'e5'])).toBe(a);
    expect(pasteKey({ White: 'A', Black: 'B', Date: '2026.01.01' }, ['e4', 'c5'])).not.toBe(a);
    expect(contentHash('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('Phase 5b — checking pasted PGN', () => {
  const GAME_A =
    '[Event "A"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
  const GAME_B =
    '[Event "B"]\n[Site "https://lichess.org/Bjl39T9x"]\n[White "GEU3"]\n[Black "Lobo017"]\n[Result "0-1"]\n\n1. d3 { [%clk 0:02:00]\n} d5 0-1';

  it('splits games at header blocks, not at [%clk] lines inside comments', () => {
    const parts = splitPgnGames(`${GAME_A}\n\n${GAME_B}\n`);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toContain('[%clk 0:02:00]');
    const wrapped = '[Event "W"]\n\n1. e4 {\n[%clk 0:01:00] } e5 *';
    expect(splitPgnGames(wrapped)).toHaveLength(1);
  });

  it('accepts legal games, keys them by site or hash, and keeps the original text of one game', () => {
    const { games, errors } = checkPgnText(`${GAME_A}\n\n${GAME_B}`);
    expect(errors).toEqual([]);
    expect(games.map((g) => g.source)).toEqual(['paste', 'lichess']);
    expect(games[1]!.key).toBe('lichess:Bjl39T9x');
    expect(games[0]!.key).toMatch(/^paste:/);
    expect(checkPgnText(GAME_A).games[0]!.pgn).toBe(GAME_A);
  });

  it('rejects a bad game without losing the others', () => {
    const illegal = '[Event "Bad"]\n\n1. e4 e5 2. Ke3 Ke6 3. Kxe5 *';
    const empty = '[Event "Empty"]\n[White "X"]\n\n*';
    const { games, errors } = checkPgnText(`${GAME_A}\n\n${illegal}\n\n${empty}\n\n${GAME_B}`);
    expect(games.map((g) => g.headers.Event)).toEqual(['A', 'B']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^Game 2: not a valid PGN/);
    expect(errors[1]).toBe('Game 3: no moves.');
    expect(checkPgnText('   ').errors).toEqual(['The text is empty.']);
  });
});
