import { describe, expect, it } from 'vitest';
import { lazy, lazyProxy, whenIdle } from '../../src/ui/lazy';

class Counter {
  private n = 0;
  public label = 'start';
  public bump(by = 1): number {
    this.n += by;
    return this.n;
  }
}

describe('lazy', () => {
  it('creates the value once, on the first get, and reports whether it exists without creating it', () => {
    let made = 0;
    const l = lazy(() => ({ id: ++made }));
    expect(l.created()).toBe(false);
    expect(made).toBe(0);
    const a = l.get();
    const b = l.get();
    expect(a).toBe(b);
    expect(made).toBe(1);
    expect(l.created()).toBe(true);
  });
});

describe('lazyProxy', () => {
  it('builds nothing until a property is used, then forwards reads, calls (with the real this) and writes', () => {
    let made = 0;
    const real = new Counter();
    const source = lazy(() => {
      made++;
      return real;
    });
    const proxy = lazyProxy(() => source.get());
    expect(made).toBe(0);
    expect(source.created()).toBe(false);
    expect(proxy.bump(2)).toBe(2);
    expect(made).toBe(1);
    const detached = proxy.bump;
    expect(detached(3)).toBe(5);
    expect(proxy.label).toBe('start');
    proxy.label = 'changed';
    expect(real.label).toBe('changed');
    expect('bump' in proxy).toBe(true);
    expect(made).toBe(1);
  });

  it('is built once however it is first touched, including by a call that runs while it is being asked for', () => {
    const l = lazy(() => new Counter());
    const proxy = lazyProxy(() => l.get());
    proxy.bump();
    proxy.bump();
    expect(l.created()).toBe(true);
    expect(l.get().bump(0)).toBe(2);
  });
});

describe('whenIdle', () => {
  it('runs the task (a timer where there are no idle callbacks, as in Node)', async () => {
    let ran = false;
    whenIdle(() => {
      ran = true;
    }, 1000);
    expect(ran).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(ran).toBe(true);
  });
});
