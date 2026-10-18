import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePgn } from '../../src/core/pgn';
import { checkPgnText } from '../../src/capture/pgn-games';
import {
  lichessDataToPgn,
  lichessGameState,
  lichessPageDataExtractor,
  lichessUsernames,
  readLichessPageData,
} from '../../extension/src/extractors/lichess-page-data';
import { lichessIdsExportExtractor } from '../../extension/src/extractors/lichess-ids-export';
import {
  classifyLichessExport,
  lichessSessionExportExtractor,
} from '../../extension/src/extractors/lichess-session-export';
import { runExtractors } from '../../extension/src/extractors/types';
import { formatClock } from '../../extension/src/extractors/pgn-builder';

const DIR = path.join(__dirname, '..', 'fixtures', 'capture', 'lichess');
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const anonymous = JSON.parse(read('export-anonymous.json')) as {
  pgnRequest: { status: number; location: string };
  jsonRequest: { status: number; body: string };
};

/** Mainline SANs and [%clk] values of a PGN, for comparing two PGNs of one game. */
function movesAndClocks(pgn: string) {
  const tree = parsePgn(pgn);
  return tree.getMainLine().map((n) => ({ san: n.san, clk: /\[%clk ([0-9:.]+)\]/.exec(n.comment)?.[1] ?? null }));
}

interface FakeResponseInit {
  status?: number;
  url?: string;
  redirected?: boolean;
  contentType?: string;
}

function fakeResponse(body: string, init: FakeResponseInit = {}) {
  return {
    status: init.status ?? 200,
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    url: init.url ?? '',
    redirected: init.redirected ?? false,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? (init.contentType ?? null) : null) },
    text: async () => body,
  } as unknown as Response;
}

type Handler = (url: string, init?: RequestInit) => Response;
function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fn, calls };
}

describe('Phase 5b — Lichess page data', () => {
  for (const id of ['Bjl39T9x', 'iTIXmTZF']) {
    it(`turns the recorded page of ${id} into the PGN Lichess exports (moves and clocks)`, () => {
      const data = readLichessPageData(read(`page-${id}.html`));
      expect(data?.game.id).toBe(id);
      expect(lichessGameState(data!)).toBe('finished');
      const pgn = lichessDataToPgn(data!)!;
      const exported = read(`export-ids-${id}.pgn`);
      expect(movesAndClocks(pgn)).toEqual(movesAndClocks(exported));
      const mine = parsePgn(pgn).getHeaders();
      const theirs = parsePgn(exported).getHeaders();
      for (const h of [
        'Event',
        'Site',
        'Date',
        'White',
        'Black',
        'Result',
        'GameId',
        'UTCDate',
        'UTCTime',
        'WhiteElo',
        'BlackElo',
        'WhiteRatingDiff',
        'BlackRatingDiff',
        'Variant',
        'TimeControl',
        'Termination',
      ]) {
        expect(mine[h], h).toBe(theirs[h]);
      }
      // Valid for the queue: one legal game, keyed by its Lichess ID
      const { games } = checkPgnText(pgn);
      expect(games).toHaveLength(1);
      expect(games[0]!.key).toBe(`lichess:${id}`);
    });
  }

  it('reads the players, and recognises pages without game data', () => {
    const data = readLichessPageData(read('page-Bjl39T9x.html'))!;
    expect(lichessUsernames(data)).toEqual({ white: 'geu3', black: 'lobo017' });
    expect(readLichessPageData('<html><body>no data</body></html>')).toBeNull();
    expect(readLichessPageData('<script id="page-init-data" type="application/json">{not json</script>')).toBeNull();
  });

  it('says "in progress" for a game that is still being played', () => {
    const html = read('page-Bjl39T9x.html').replace('"status":{"id":30,"name":"mate"}', '"status":{"id":20,"name":"started"}');
    const data = readLichessPageData(html)!;
    expect(lichessGameState(data)).toBe('in-progress');
    expect(parsePgn(lichessDataToPgn(data)!).getHeaders().Result).toBe('*');
  });

  it('fetches the page again when the document is not the finished game', async () => {
    const { fn, calls } = fakeFetch(() => fakeResponse(read('page-Bjl39T9x.html')));
    const result = await lichessPageDataExtractor.extract({ ref: { site: 'lichess', gameId: 'Bjl39T9x' }, fetch: fn });
    expect(result).toMatchObject({ ok: true, method: 'lichess-page-data' });
    expect(calls.map((c) => c.url)).toEqual(['https://lichess.org/Bjl39T9x']);
    const missing = fakeFetch(() => fakeResponse('Not found', { status: 404 }));
    expect(await lichessPageDataExtractor.extract({ ref: { site: 'lichess', gameId: 'Bjl39T9x' }, fetch: missing.fn })).toMatchObject({
      ok: false,
      notFound: true,
    });
  });

  it('formats clocks like Lichess (whole seconds, rounded to the nearest)', () => {
    expect(formatClock(120.03)).toBe('0:02:00');
    expect(formatClock(99.81)).toBe('0:01:40');
    expect(formatClock(58.59)).toBe('0:00:59');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(176.3, true)).toBe('0:02:56.3');
    expect(formatClock(-1)).toBe('0:00:00');
  });
});

describe('Phase 5b — Lichess exports', () => {
  it('recognises the login wall of the single-game export (recorded answers)', () => {
    expect(anonymous.pgnRequest).toEqual({ status: 303, location: '/signup' });
    // fetch() follows the 303: the page ends up on /signup with an HTML body
    const redirected = classifyLichessExport(
      fakeResponse('<!doctype html><title>Sign up</title>', { url: 'https://lichess.org/signup', redirected: true }),
      '<!doctype html>',
      'm',
    );
    expect(redirected).toMatchObject({ ok: false, loginRequired: true });
    const json = classifyLichessExport(fakeResponse(anonymous.jsonRequest.body, { status: anonymous.jsonRequest.status }), anonymous.jsonRequest.body, 'm');
    expect(json).toMatchObject({ ok: false, loginRequired: true });
    expect(classifyLichessExport(fakeResponse('', { status: 429 }), '', 'm')).toMatchObject({ ok: false, retryAfterMs: 60_000 });
    expect(classifyLichessExport(fakeResponse('<html>', { status: 200 }), '<html>', 'm')).toMatchObject({ ok: false });
  });

  it('session export: a logged-in answer is the PGN; the request carries the session', async () => {
    const pgn = read('export-ids-Bjl39T9x.pgn');
    const { fn, calls } = fakeFetch(() => fakeResponse(pgn, { url: 'https://lichess.org/game/export/Bjl39T9x' }));
    const result = await lichessSessionExportExtractor.extract({ ref: { site: 'lichess', gameId: 'Bjl39T9x' }, fetch: fn });
    expect(result).toMatchObject({ ok: true, method: 'lichess-session-export' });
    expect(calls[0]!.url).toContain('/game/export/Bjl39T9x?clocks=true');
    expect(calls[0]!.init?.credentials).toBe('include');
  });

  it('IDs export: POSTs the ID, checks the game, treats an empty answer as not found', async () => {
    const { fn, calls } = fakeFetch(() => fakeResponse(read('export-ids-Bjl39T9x.pgn')));
    const ref = { site: 'lichess' as const, gameId: 'Bjl39T9x' };
    expect(await lichessIdsExportExtractor.extract({ ref, fetch: fn })).toMatchObject({ ok: true, method: 'lichess-ids-export' });
    expect(calls[0]).toMatchObject({ url: expect.stringContaining('/api/games/export/_ids?clocks=true'), init: { method: 'POST', body: 'Bjl39T9x' } });
    const other = fakeFetch(() => fakeResponse(read('export-ids-iTIXmTZF.pgn')));
    expect(await lichessIdsExportExtractor.extract({ ref, fetch: other.fn })).toMatchObject({ ok: false });
    const empty = fakeFetch(() => fakeResponse(''));
    expect(await lichessIdsExportExtractor.extract({ ref, fetch: empty.fn })).toMatchObject({ ok: false, notFound: true });
  });

  it('falls back from the login wall to the game page', async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.includes('/game/export/')
        ? fakeResponse('<!doctype html>', { url: 'https://lichess.org/signup', redirected: true })
        : fakeResponse(read('page-Bjl39T9x.html')),
    );
    const outcome = await runExtractors([lichessSessionExportExtractor, lichessPageDataExtractor], {
      ref: { site: 'lichess', gameId: 'Bjl39T9x' },
      fetch: fn,
    });
    expect(outcome.result).toMatchObject({ ok: true, method: 'lichess-page-data' });
    expect(outcome.attempts).toEqual([{ method: 'lichess-session-export', reason: 'Lichess wants a login for this export.' }]);
    expect(calls).toHaveLength(2);
  });
});
