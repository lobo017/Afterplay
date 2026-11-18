import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The scrollbar is themed once, for the whole app (the e2e spec phase11-scrollbars checks the computed style on screens).
// These checks read the style sheet: one set of rules on every element, none scoped to a screen, none that turns the bar
// off or back to the browser's own.
const css = fs.readFileSync(path.join('src', 'styles', 'main.css'), 'utf8');

/** The selector lists of the rules whose block mentions `needle`, or whose selector does. */
function ruleSelectors(needle: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (m[1]!.includes(needle) || m[2]!.includes(needle)) out.push(m[1]!.replace(/\/\*[\s\S]*?\*\//g, '').trim());
  }
  return out;
}

describe('one themed scrollbar for the whole app', () => {
  it('the standard properties are on every element', () => {
    expect(ruleSelectors('scrollbar-color')).toContain('*');
    const rule = /(?:^|\n)\*\s*\{([^}]*)\}/.exec(css.slice(css.indexOf('One themed scrollbar')))!;
    expect(rule[1]).toContain('scrollbar-width: thin');
    expect(rule[1]).toContain('scrollbar-color: var(--wc-scrollbar-thumb) var(--wc-scrollbar-track)');
  });

  it('the prefixed pieces are on every element too, and there is one rule for each', () => {
    for (const piece of ['::-webkit-scrollbar', '::-webkit-scrollbar-thumb', '::-webkit-scrollbar-thumb:hover']) {
      expect(
        ruleSelectors(piece).filter((s) => s === piece),
        piece,
      ).toHaveLength(1);
    }
    expect(ruleSelectors('::-webkit-scrollbar').filter((s) => s.includes('.wc-'))).toEqual([]);
  });

  it('the colors are the app’s gold on dark, in the variables and in the prefixed pieces', () => {
    expect(css).toContain('--wc-scrollbar-track: #10131b;');
    expect(css).toContain('--wc-scrollbar-thumb: rgba(212, 175, 55, 0.5);');
    expect(css).toContain('--wc-scrollbar-thumb-hover: rgba(212, 175, 55, 0.75);');
  });

  it('nothing turns the bar off or back to the browser’s own, and no screen has its own rule', () => {
    expect(css).not.toMatch(/scrollbar-width:\s*(none|auto)/);
    expect(css).not.toMatch(/scrollbar-color:\s*(auto|initial)/);
    expect(css).not.toMatch(/\.wc-review-shell[^{]*::-webkit-scrollbar/);
    // The scoped rule was an @supports fallback for Firefox: the standard properties now cover it for all
    expect(css).not.toMatch(/@supports not selector\(::-webkit-scrollbar\)/);
  });
});
