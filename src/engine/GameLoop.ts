/**
 * Fixed-timestep game loop (see GAME_TICK.md). Time is divided into discrete
 * ticks; `advance` runs whole ticks based on real elapsed time, catching up
 * after a stall (capped to avoid a spiral of death). The tick-advancement logic
 * is separate from the timer so it can be driven deterministically in tests.
 */
export interface GameLoopOptions {
  /** Ticks per second. */
  tickRate: number;
  /** Called once per tick with the new tick number. */
  onTick: (tick: number) => void;
  /** Max ticks to run in a single catch-up pass (default 5). */
  maxCatchUpTicks?: number;
}

export class GameLoop {
  /** Milliseconds per tick. */
  readonly tickMs: number;
  private readonly onTick: (tick: number) => void;
  private readonly maxCatchUp: number;

  private timer: NodeJS.Timeout | null = null;
  private accumulator = 0;
  private lastTime: number | null = null;
  private tick = 0;

  constructor(options: GameLoopOptions) {
    this.tickMs = 1000 / options.tickRate;
    this.onTick = options.onTick;
    this.maxCatchUp = options.maxCatchUpTicks ?? 5;
  }

  /**
   * Advances the loop to `nowMs`. The first call primes the clock and runs no
   * ticks; subsequent calls run one tick per elapsed `tickMs`, up to the
   * catch-up cap.
   */
  advance(nowMs: number): void {
    if (this.lastTime === null) {
      this.lastTime = nowMs;
      return;
    }
    this.accumulator += nowMs - this.lastTime;
    this.lastTime = nowMs;

    let ran = 0;
    while (this.accumulator >= this.tickMs && ran < this.maxCatchUp) {
      this.tick += 1;
      this.onTick(this.tick);
      this.accumulator -= this.tickMs;
      ran += 1;
    }

    // Drop any remaining backlog beyond the cap so we don't spiral.
    if (this.accumulator > this.tickMs * this.maxCatchUp) {
      this.accumulator = 0;
    }
  }

  /** Starts ticking on a real timer. `clock` is injectable for testing. */
  start(clock: () => number = () => performance.now()): void {
    if (this.timer) return;
    this.lastTime = clock();
    this.timer = setInterval(() => this.advance(clock()), this.tickMs);
    // Don't keep the process alive for the loop alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get currentTick(): number {
    return this.tick;
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
