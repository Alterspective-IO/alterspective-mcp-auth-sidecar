import type { Config } from './config.js';
import type { AuditEvent } from './types.js';

export class AuditEmitter {
  private buffer: AuditEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: Config) {
    this.flushTimer = setInterval(() => this.flush(), cfg.auditFlushIntervalMs);
    // Don't keep the process alive just for flushes
    this.flushTimer.unref?.();
  }

  enqueue(event: AuditEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.cfg.auditBatchSize) {
      // Fire-and-forget; flush handles its own errors
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);

    if (this.cfg.mockAuth) {
      // Local dev — just log
      // eslint-disable-next-line no-console
      console.log('[audit]', JSON.stringify(batch));
      return;
    }

    try {
      const res = await fetch(`${this.cfg.keystoneUrl}/api/audit/mcp-events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.keystoneServiceToken}`,
        },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        // Re-enqueue on failure so we don't lose events. Cap retries by buffer size check above.
        this.buffer.unshift(...batch);
        // eslint-disable-next-line no-console
        console.error(`[audit] flush failed ${res.status}; re-enqueued ${batch.length} events`);
      }
    } catch (err) {
      this.buffer.unshift(...batch);
      // eslint-disable-next-line no-console
      console.error('[audit] flush error', err);
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
