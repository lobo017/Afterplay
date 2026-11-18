import { serializeBook, type Book } from '../../../src/engine/bot-profile';

/**
 * An invented book that reads as valid, of `chars` characters or a few fewer, shaped like a real one: keys of about 60
 * characters, a second move at one position in seven. `salt` makes two books of the same size differ. No real game or
 * player is behind it.
 */
export function syntheticBook(chars: number, salt = ''): string {
  const entries: Book['entries'] = {};
  // The text is {"v":1,"pliesCap":36,"entries":{ ... }}: 34 characters around the entries, a comma between two of them
  let length = 34;
  for (let i = 0; ; i++) {
    const key = `${salt}${i.toString(36)}/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR/${'1'.repeat(8)} ${i % 2 === 0 ? 'w' : 'b'} KQkq -`;
    const moves: [string, number][] =
      i % 7 === 0
        ? [
            ['e2e4', 3 + (i % 5)],
            ['d2d4', 1 + (i % 3)],
          ]
        : [['g1f3', 1 + (i % 9)]];
    const added = JSON.stringify(key).length + 1 + JSON.stringify(moves).length + (i > 0 ? 1 : 0);
    if (length + added > chars) break;
    length += added;
    entries[key] = moves;
  }
  return serializeBook({ v: 1, pliesCap: 36, entries });
}
