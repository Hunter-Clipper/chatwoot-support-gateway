// Spec 5.3 (Availability behavior): "Chatwoot outage - support actions disabled or queued
// according to risk, status visible to administrators." Without this, a Chatwoot outage means
// every single request still waits out its own timeout before failing - slow, and it lets
// requests pile up against a service that's already down. This fails fast once the outage is
// established, and periodically lets one trial request through to detect recovery.
export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit breaker is open - Chatwoot has failed repeatedly, failing fast without calling it');
    this.name = 'CircuitOpenError';
  }
}

type State = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private state: State = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly failureThreshold: number = 3,
    private readonly cooldownMs: number = 30_000,
  ) {}

  // Wraps a call that can throw on genuine connectivity failure (network error, timeout).
  // Does NOT know whether a resolved value represents a healthy or unhealthy outcome (e.g. a
  // successfully-received HTTP 500) - callers whose "failure" isn't a thrown exception should
  // use recordSuccess()/recordFailure() directly instead of (or in addition to) this.
  async throwIfOpen(): Promise<void> {
    if (this.state !== 'open') return;
    if (Date.now() - this.openedAt < this.cooldownMs) {
      throw new CircuitOpenError();
    }
    this.state = 'half-open';
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.throwIfOpen();
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    // A failure during the half-open trial reopens immediately, without needing to
    // re-accumulate failureThreshold failures from scratch.
    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  getState(): State {
    return this.state;
  }
}
