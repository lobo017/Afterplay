import type { SiteGameRef } from '../../../src/capture/game-id';
import {
  lichessGameState,
  lichessPageDataExtractor,
  lichessPlayers,
  readLichessPageData,
  type LichessGameData,
} from '../extractors/lichess-page-data';
import { lichessSessionExportExtractor } from '../extractors/lichess-session-export';
import { watchForSelector, type PageGame } from './capture-page';
import { watchGameStream } from './lichess-stream';
import { startPageRunner, type PageRunnerAdapter } from './page-runner';

// Content script on lichess.org. On a game page: the Save button, and auto-capture of my
// game when it ends. The end comes from Lichess's official game stream (the site's own
// data); the result block in the move list is a faster hint. Extraction: the official
// export with the browser's Lichess session first, the game page's own data when that
// wants a login.

/**
 * The round page shows the result block when a game ends (Lichess's `.result-wrap` in the
 * move list). Unofficial: Lichess can rename it; the game stream doesn't depend on it.
 */
const GAME_OVER_SELECTOR = '.result-wrap';

function playerName(p: LichessGameData['player']): string {
  if (p.user?.username) return p.user.username;
  if (p.ai) return `lichess AI level ${p.ai}`;
  return p.name ?? 'Anonymous';
}

/** When the game ended, estimated from its start and the time spent on every move. */
function estimatedEnd(data: LichessGameData): number | null {
  const centis = (data.game as { moveCentis?: number[] }).moveCentis;
  if (!data.game.createdAt) return null;
  if (!Array.isArray(centis)) return data.game.createdAt;
  return data.game.createdAt + centis.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) * 10;
}

function gameFromData(ref: SiteGameRef, data: LichessGameData, source: string): PageGame {
  const { white, black } = lichessPlayers(data);
  const state = lichessGameState(data);
  const viewerIsPlayer =
    data.player.spectator === false || (data.player.spectator === undefined && Boolean(data.player.user)) ? true : null;
  return {
    ref,
    state,
    white: playerName(white),
    black: playerName(black),
    viewerIsPlayer,
    startedAt: data.game.createdAt ?? null,
    endedAt: state === 'in-progress' ? null : estimatedEnd(data),
    source,
  };
}

const adapter: PageRunnerAdapter = {
  site: 'lichess',
  extractors: [lichessSessionExportExtractor, lichessPageDataExtractor],
  async detect(ref, fresh) {
    let data = fresh ? null : readLichessPageData(document);
    let source = 'page data';
    if (!data) {
      const res = await fetch(`https://lichess.org/${ref.gameId}`, {
        credentials: 'include',
        headers: { Accept: 'text/html' },
      });
      if (res.status === 404) return { notFound: `Lichess has no game ${ref.gameId}.` };
      if (!res.ok) throw new Error(`The game page answered ${res.status}.`);
      data = readLichessPageData(await res.text());
      source = 'page data (fetched again)';
    }
    if (!data || data.game.id !== ref.gameId) return { notFound: `No game data for ${ref.gameId} on the page.` };
    return { game: gameFromData(ref, data, source) };
  },
  watchForEnd(ref, game, onEnd, log) {
    const stopDom = watchForSelector(GAME_OVER_SELECTOR, () =>
      onEnd({ source: 'the result block appeared (.result-wrap)', fromData: false }),
    );
    const stream = watchGameStream({
      gameId: ref.gameId,
      fetch: (i, init) => fetch(i, init),
      log,
      onEnd: (line) =>
        onEnd({
          source: 'Lichess game stream',
          fromData: true,
          game: {
            ...game,
            state: line.aborted ? 'aborted' : 'finished',
            white: line.white,
            black: line.black,
            endedAt: Date.now(),
            source: 'Lichess game stream',
          },
        }),
      // Lichess closes the stream when the game ends; a close without the end line is checked
      onClosed: () => onEnd({ source: 'the game stream closed', fromData: true }),
    });
    return {
      stop() {
        stopDom();
        stream.stop();
      },
      describe: () => [stream.describe(), `the result block (${GAME_OVER_SELECTOR})`],
    };
  },
};

startPageRunner(adapter);
