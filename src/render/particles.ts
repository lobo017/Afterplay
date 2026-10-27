import type { Color, Square } from '../core/rules';
import { squareToBoardCoords } from './overlay';

interface PooledShard {
  active: boolean;
  color: Color;
  isEmber: boolean;
  x: number;
  y: number;
  z: number; // Height above board surface for 2.5D bounce physics
  vx: number;
  vy: number;
  vz: number;
  rot: number;
  rotVel: number;
  scale: number;
  life: number;
  maxLife: number;
  shapeVariant: number; // 0, 1, or 2 pre-baked polygon silhouette
}

export const PARTICLE_POOL_SIZE = 180;
export const SHARDS_PER_CAPTURE = 54;

/**
 * Fixed-pool 2D <canvas> capture shatter particle effect ported from PooledShatterSystem in legacy/index.html.
 * Allocates all 180 shard objects once in the constructor and creates zero objects per frame.
 * Runs requestAnimationFrame ONLY while shards are active (0% idle CPU).
 */
export class CaptureParticleSystem {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly pool: PooledShard[];
  private enabled = true;
  private activeCount = 0;
  private rafId: number | null = null;
  private lastFrameTime = 0;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wc-capture-canvas';
    this.canvas.width = 800;
    this.canvas.height = 800;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.setAttribute('data-testid', 'capture-particle-canvas');
    parent.appendChild(this.canvas);

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = this.canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    this.ctx = ctx;

    this.pool = new Array<PooledShard>(PARTICLE_POOL_SIZE);
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.pool[i] = {
        active: false,
        color: 'w',
        isEmber: false,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        rot: 0,
        rotVel: 0,
        scale: 1,
        life: 0,
        maxLife: 1.5,
        shapeVariant: i % 3,
      };
    }
  }

  public getElement(): HTMLCanvasElement {
    return this.canvas;
  }

  public getPoolSize(): number {
    return this.pool.length;
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  public isLoopRunning(): boolean {
    return this.rafId !== null;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clear();
    }
  }

  /**
   * Triggers a 54-shard shatter burst at the captured square using directional impulse from the attacker square.
   * Zero object allocations.
   */
  public triggerCapture(targetSquare: Square, capturedColor: Color, attackerSquare?: Square, flipped = false): number {
    if (!this.enabled) return 0;

    const target = squareToBoardCoords(targetSquare, flipped);
    let dirX = 0;
    let dirY = 0;
    if (attackerSquare && attackerSquare !== targetSquare) {
      const atk = squareToBoardCoords(attackerSquare, flipped);
      const dx = target.cx - atk.cx;
      const dy = target.cy - atk.cy;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        dirX = dx / len;
        dirY = dy / len;
      }
    }

    let spawned = 0;
    for (let i = 0; i < PARTICLE_POOL_SIZE && spawned < SHARDS_PER_CAPTURE; i++) {
      const s = this.pool[i]!;
      if (s.active) continue;

      s.active = true;
      s.color = capturedColor;
      s.isEmber = spawned % 3 === 0;
      s.life = 0;
      s.maxLife = 0.65 + Math.random() * 0.55; // Crisp 0.65-1.20s visual shatter
      s.scale = s.isEmber ? 0.6 + Math.random() * 0.8 : 0.55 + Math.random() * 0.95;

      s.x = target.cx + (Math.random() - 0.5) * 42;
      s.y = target.cy + (Math.random() - 0.5) * 42;
      s.z = 12 + Math.random() * 55;

      const radialAngle = Math.random() * Math.PI * 2;
      const radialSpeed = 95 + Math.random() * 220;
      s.vx = Math.cos(radialAngle) * radialSpeed + dirX * 145;
      s.vy = Math.sin(radialAngle) * radialSpeed + dirY * 145;
      s.vz = 130 + Math.random() * 240;

      s.rot = Math.random() * Math.PI * 2;
      s.rotVel = (Math.random() - 0.5) * 14;

      spawned++;
      this.activeCount++;
    }

    if (this.activeCount > 0 && this.rafId === null) {
      this.lastFrameTime = performance.now();
      this.scheduleTick();
    }

    return spawned;
  }

  /**
   * Steps physics by dt seconds and draws active shards.
   * Exposed publicly so deterministic unit tests can step the simulation without waiting on wall-clock rAF.
   */
  public step(dtSeconds: number): void {
    const dt = Math.max(0.001, Math.min(0.05, dtSeconds));
    const ctx = this.ctx;
    if (ctx) {
      ctx.clearRect(0, 0, 800, 800);
    }

    let remaining = 0;

    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      const s = this.pool[i]!;
      if (!s.active) continue;

      s.life += dt;
      if (s.life >= s.maxLife) {
        s.active = false;
        continue;
      }

      remaining++;

      // Gravity & air drag (ported from legacy PooledShatterSystem)
      s.vz -= (s.isEmber ? 340 : 780) * dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;

      // Bounce on board surface (restitution 0.42, friction 0.72 from legacy audit)
      if (s.z < 0) {
        s.z = 0;
        s.vz *= -0.42;
        s.vx *= 0.72;
        s.vy *= 0.72;
        s.rotVel *= 0.75;
      }

      s.rot += s.rotVel * dt;

      // Smooth shrink in final 35% of life
      const lifeRatio = s.life / s.maxLife;
      const currentScale = lifeRatio > 0.65 ? s.scale * (1 - (lifeRatio - 0.65) / 0.35) : s.scale;

      if (ctx && currentScale > 0.02) {
        const screenY = s.y - s.z * 0.45;
        ctx.save();
        ctx.translate(s.x, screenY);
        ctx.rotate(s.rot);
        const radius = (s.isEmber ? 5.5 : 9.0) * currentScale;

        if (s.isEmber) {
          ctx.fillStyle = '#f59e0b';
          ctx.beginPath();
          ctx.moveTo(0, -radius);
          ctx.lineTo(radius * 0.75, 0);
          ctx.lineTo(0, radius);
          ctx.lineTo(-radius * 0.75, 0);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = s.color === 'w' ? '#f8f5f0' : '#161925';
          ctx.strokeStyle = s.color === 'w' ? '#d4af37' : '#a855f7';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          if (s.shapeVariant === 0) {
            ctx.moveTo(-radius, -radius * 0.6);
            ctx.lineTo(radius * 0.85, -radius * 0.4);
            ctx.lineTo(radius * 0.4, radius * 0.9);
            ctx.lineTo(-radius * 0.7, radius * 0.65);
          } else if (s.shapeVariant === 1) {
            ctx.moveTo(0, -radius * 1.1);
            ctx.lineTo(radius * 0.95, radius * 0.25);
            ctx.lineTo(-radius * 0.2, radius * 0.95);
            ctx.lineTo(-radius * 0.9, -radius * 0.15);
          } else {
            ctx.moveTo(-radius * 0.8, -radius * 0.75);
            ctx.lineTo(radius * 0.7, -radius * 0.8);
            ctx.lineTo(radius, radius * 0.35);
            ctx.lineTo(0, radius * 0.9);
            ctx.lineTo(-radius * 0.95, radius * 0.2);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    this.activeCount = remaining;
  }

  private scheduleTick(): void {
    this.rafId = requestAnimationFrame((now) => {
      this.rafId = null;
      const dt = (now - this.lastFrameTime) / 1000;
      this.lastFrameTime = now;

      this.step(dt);

      if (this.activeCount > 0) {
        this.scheduleTick();
      } else if (this.ctx) {
        this.ctx.clearRect(0, 0, 800, 800);
      }
    });
  }

  public clear(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
      this.pool[i]!.active = false;
    }
    this.activeCount = 0;
    if (this.ctx) {
      this.ctx.clearRect(0, 0, 800, 800);
    }
  }

  public destroy(): void {
    this.clear();
    this.canvas.remove();
  }
}
