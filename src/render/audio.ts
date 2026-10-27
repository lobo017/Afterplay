import type { PieceSymbol } from '../core/rules';

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * Procedural Web Audio synthesizer ported from CathedralAudioEngine in legacy/index.html.
 * - Starts lazily on the first user gesture (never creates AudioContext on page load).
 * - Routes all voices through a master GainNode controlled by a volume slider (0..1) and mute toggle.
 * - Pre-allocates and caches the 0.45s stone-slide white-noise AudioBuffer once on init (0 per-move allocations).
 */
export class CathedralAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private cachedStoneNoiseBuffer: AudioBuffer | null = null;
  private noiseBufferAllocationCount = 0;
  private enabled = true;
  private volume = 0.75;
  private readonly contextFactory: (() => AudioContext | null) | undefined;

  constructor(options?: { enabled?: boolean; volume?: number; contextFactory?: () => AudioContext | null }) {
    if (typeof options?.enabled === 'boolean') {
      this.enabled = options.enabled;
    }
    if (typeof options?.volume === 'number') {
      this.volume = Math.max(0, Math.min(1, options.volume));
    }
    this.contextFactory = options?.contextFactory;
  }

  /**
   * Builds the AudioContext ahead of the first gesture without starting playback. The
   * context stays suspended until init() resumes it during a user gesture.
   */
  public prewarm(): void {
    this.createContext();
  }

  /**
   * Initializes or resumes the AudioContext on a user gesture.
   */
  public init(): boolean {
    this.createContext();

    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {
        // Ignore autoplay restriction errors until next user gesture
      });
    }

    return this.ctx !== null;
  }

  private createContext(): void {
    if (!this.ctx) {
      try {
        if (this.contextFactory) {
          this.ctx = this.contextFactory();
        } else if (typeof window !== 'undefined') {
          const AudioCtx = window.AudioContext || (window as unknown as WebkitWindow).webkitAudioContext;
          if (AudioCtx) {
            this.ctx = new AudioCtx();
          }
        }
      } catch {
        this.ctx = null;
      }

      if (this.ctx) {
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.enabled ? this.volume : 0;
        this.masterGain.connect(this.ctx.destination);
        this.ensureStoneNoiseBuffer();
      }
    }
  }

  private ensureStoneNoiseBuffer(): AudioBuffer | null {
    if (!this.ctx) return null;
    if (this.cachedStoneNoiseBuffer) {
      return this.cachedStoneNoiseBuffer;
    }

    const bufferSize = Math.floor(this.ctx.sampleRate * 0.45);
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.6;
    }
    this.cachedStoneNoiseBuffer = buffer;
    this.noiseBufferAllocationCount++;
    return buffer;
  }

  public isInitialized(): boolean {
    return this.ctx !== null;
  }

  public getNoiseBufferAllocationCount(): number {
    return this.noiseBufferAllocationCount;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime);
    }
  }

  public getVolume(): number {
    return this.volume;
  }

  public setVolume(volume: number): void {
    if (Number.isNaN(volume)) return;
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime);
    }
  }

  private getOutputNode(): AudioNode | null {
    if (!this.enabled || this.volume <= 0) return null;
    this.init();
    if (!this.ctx || !this.masterGain) return null;
    return this.masterGain;
  }

  public static shouldPieceLevitate(piece: PieceSymbol): boolean {
    return piece === 'n' || piece === 'b' || piece === 'q';
  }

  /**
   * Piece selection chime: sine 528 Hz -> 792 Hz (3:2 perfect fifth).
   */
  public playSelect(): void {
    const out = this.getOutputNode();
    if (!out || !this.ctx) return;

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(528, now);
    osc.frequency.exponentialRampToValueAtTime(792, now + 0.14);

    gain.gain.setValueAtTime(0.11, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(gain);
    gain.connect(out);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  /**
   * Piece slide / levitation sound:
   * - Levitating pieces (N, B, Q): ethereal arcane triangle hum (190 -> 280 -> 160 Hz).
   * - Grounded pieces (P, R, K): bandpass-filtered stone grinding noise + low 95 -> 38 Hz thud.
   */
  public playSlide(isLevitate = false): void {
    const out = this.getOutputNode();
    if (!out || !this.ctx) return;

    const now = this.ctx.currentTime;
    if (isLevitate) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(190, now);
      osc.frequency.exponentialRampToValueAtTime(280, now + 0.25);
      osc.frequency.exponentialRampToValueAtTime(160, now + 0.55);

      gain.gain.setValueAtTime(0.01, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.58);

      osc.connect(gain);
      gain.connect(out);
      osc.start(now);
      osc.stop(now + 0.6);
    } else {
      const buffer = this.ensureStoneNoiseBuffer();
      if (buffer) {
        const noise = this.ctx.createBufferSource();
        noise.buffer = buffer;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(140, now);
        filter.frequency.linearRampToValueAtTime(210, now + 0.35);
        filter.Q.value = 2.2;

        const gain = this.ctx.createGain();
        gain.gain.setValueAtTime(0.01, now);
        gain.gain.linearRampToValueAtTime(0.22, now + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.005, now + 0.44);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(out);
        noise.start(now);
      }

      const thud = this.ctx.createOscillator();
      const thudGain = this.ctx.createGain();
      thud.type = 'sine';
      thud.frequency.setValueAtTime(95, now + 0.36);
      thud.frequency.exponentialRampToValueAtTime(38, now + 0.52);
      thudGain.gain.setValueAtTime(0.24, now + 0.36);
      thudGain.gain.exponentialRampToValueAtTime(0.001, now + 0.54);
      thud.connect(thudGain);
      thudGain.connect(out);
      thud.start(now + 0.36);
      thud.stop(now + 0.55);
    }
  }

  /**
   * Capture shatter sound: heavy sawtooth bass boom (130 -> 28 Hz) + 9 staggered crystalline fracture bursts.
   */
  public playShatter(): void {
    const out = this.getOutputNode();
    if (!out || !this.ctx) return;

    const now = this.ctx.currentTime;

    const boom = this.ctx.createOscillator();
    const boomGain = this.ctx.createGain();
    boom.type = 'sawtooth';
    boom.frequency.setValueAtTime(130, now);
    boom.frequency.exponentialRampToValueAtTime(28, now + 0.45);
    boomGain.gain.setValueAtTime(0.35, now);
    boomGain.gain.exponentialRampToValueAtTime(0.001, now + 0.48);
    boom.connect(boomGain);
    boomGain.connect(out);
    boom.start(now);
    boom.stop(now + 0.5);

    for (let i = 0; i < 9; i++) {
      const delay = i * 0.038 + Math.random() * 0.025;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = i % 2 === 0 ? 'triangle' : 'sine';
      const baseFreq = 700 + Math.random() * 1900;
      osc.frequency.setValueAtTime(baseFreq, now + delay);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.45, now + delay + 0.14);

      g.gain.setValueAtTime(0.14 / (1 + i * 0.25), now + delay);
      g.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.15);

      osc.connect(g);
      g.connect(out);
      osc.start(now + delay);
      osc.stop(now + delay + 0.16);
    }
  }

  /**
   * Cathedral tubular bell minor-second check alert ([440, 466.16, 880] Hz).
   */
  public playCheck(): void {
    const out = this.getOutputNode();
    if (!out || !this.ctx) return;

    const now = this.ctx.currentTime;
    const freqs = [440, 466.16, 880];
    freqs.forEach((freq, idx) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.04);
      gain.gain.setValueAtTime(0.15, now + idx * 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 1.1);
      osc.connect(gain);
      gain.connect(out);
      osc.start(now + idx * 0.04);
      osc.stop(now + 1.15);
    });
  }

  /**
   * Game over arpeggio: C-major [261.63, 329.63, 392.00, 523.25] for victory,
   * A-minor harmonic [220.00, 261.63, 329.63, 415.30] for defeat/draw.
   */
  public playGameOver(victory = true): void {
    const out = this.getOutputNode();
    if (!out || !this.ctx) return;

    const now = this.ctx.currentTime;
    const chord = victory ? [261.63, 329.63, 392.0, 523.25] : [220.0, 261.63, 329.63, 415.3];
    chord.forEach((freq, i) => {
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.12);
      gain.gain.setValueAtTime(0.12, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 2.0);
      osc.connect(gain);
      gain.connect(out);
      osc.start(now + i * 0.12);
      osc.stop(now + 2.05);
    });
  }
}
