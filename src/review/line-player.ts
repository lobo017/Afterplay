/**
 * Plays a line of nodes out on the board one move at a time (the review's "Show refutation"), so the line is seen growing.
 * The first move is shown at once, each later one after a fixed delay, ending on the last. Anything the user does stops
 * it and takes over, and a stopped player leaves no timer and no listener behind. With reduced motion the board goes
 * straight to the end. Pure of the DOM: everything it touches comes in through `LinePlayerDeps`.
 */

/** The pause between two moves (the puzzle's "Show solution" moves on at the same pace). */
export const LINE_STEP_MS = 600;

export interface LinePlayerDeps {
  /** Shows the node on the board. The board reports it back through `noteNavigation`, synchronously. */
  goTo(nodeId: string): void;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** The user asked for less motion: no delays, straight to the end. */
  reducedMotion(): boolean;
  /** The screen with the board is still in view (a line is not played out behind another screen). */
  shown(): boolean;
  /** Calls `stop` on any user action (a tap, a click, a key); returns what removes that listener again. */
  onUserAction(stop: () => void): () => void;
}

export class LinePlayer {
  private nodes: readonly string[] = [];
  private index = 0;
  private timer: unknown = null;
  private removeListener: (() => void) | null = null;
  private playing = false;
  /** The node the player itself is moving to: the board's report of it is not a user action. */
  private expected: string | null = null;

  constructor(
    private readonly deps: LinePlayerDeps,
    private readonly stepMs: number = LINE_STEP_MS,
  ) {}

  public isPlaying(): boolean {
    return this.playing;
  }

  /** Plays the nodes in order, from the first (shown now) to the last. Replaces any line being played. */
  public play(nodeIds: readonly string[]): void {
    this.stop();
    const last = nodeIds[nodeIds.length - 1];
    if (last === undefined) return;
    if (nodeIds.length === 1 || this.deps.reducedMotion()) {
      this.go(last);
      return;
    }
    this.nodes = nodeIds;
    this.index = 0;
    this.playing = true;
    this.go(nodeIds[0]!);
    if (!this.playing) return;
    this.removeListener = this.deps.onUserAction(() => this.stop());
    this.timer = this.deps.schedule(() => this.tick(), this.stepMs);
  }

  /** The board moved to this node: any node other than the player's own is the user taking over. */
  public noteNavigation(nodeId: string): void {
    if (this.playing && nodeId !== this.expected) this.stop();
  }

  /** Ends the animation where it is: no timer, no listener. */
  public stop(): void {
    if (this.timer !== null) this.deps.cancel(this.timer);
    this.timer = null;
    this.removeListener?.();
    this.removeListener = null;
    this.playing = false;
    this.nodes = [];
  }

  private tick(): void {
    this.timer = null;
    if (!this.playing) return;
    if (!this.deps.shown()) {
      this.stop();
      return;
    }
    this.index++;
    this.go(this.nodes[this.index]!);
    if (!this.playing) return;
    if (this.index >= this.nodes.length - 1) {
      this.stop();
      return;
    }
    this.timer = this.deps.schedule(() => this.tick(), this.stepMs);
  }

  private go(nodeId: string): void {
    this.expected = nodeId;
    try {
      this.deps.goTo(nodeId);
    } finally {
      this.expected = null;
    }
  }
}
