import { describe, expect, it } from 'vitest';
import { canonicalRedirect, hostNameOf } from '../../scripts/lib/canonical-origin.mjs';

describe('npm run serve: one origin', () => {
  it('reads the host name from a Host header', () => {
    expect(hostNameOf('localhost:4173')).toBe('localhost');
    expect(hostNameOf('LOCALHOST')).toBe('localhost');
    expect(hostNameOf('[::1]:4173')).toBe('[::1]');
    expect(hostNameOf('127.0.0.1:4173')).toBe('127.0.0.1');
  });

  it('sends localhost and [::1] to 127.0.0.1, keeping the path and query', () => {
    expect(canonicalRedirect('localhost:4173', '/?mode=games', 4173)).toBe('http://127.0.0.1:4173/?mode=games');
    expect(canonicalRedirect('[::1]:4173', '/assets/x.js', 4173)).toBe('http://127.0.0.1:4173/assets/x.js');
    expect(canonicalRedirect('localhost:5000', '/', 5000)).toBe('http://127.0.0.1:5000/');
  });

  it('leaves 127.0.0.1 alone', () => {
    expect(canonicalRedirect('127.0.0.1:4173', '/', 4173)).toBeNull();
    expect(canonicalRedirect(undefined, '/', 4173)).toBeNull();
  });

  it('never redirects off the server (absolute-form request targets become /)', () => {
    expect(canonicalRedirect('localhost:4173', 'http://evil.example/', 4173)).toBe('http://127.0.0.1:4173/');
  });
});
