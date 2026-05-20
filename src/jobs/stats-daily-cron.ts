import { refreshStatsDaily } from "../lib/gold";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const WINDOW_DAYS = 7;

/**
 * Periodically rebuild postmark_stats_daily for the trailing window.
 * Uses a re-entrancy guard so an overrun refresh does not stack.
 * Must be started AFTER app.listen() — backfill scans every silver row in the window.
 */
export function startStatsDailyCron(): void {
  let running = false;

  const tick = async () => {
    if (running) {
      console.warn("[postmark-service] stats-daily refresh skipped — previous run still in flight");
      return;
    }
    running = true;
    const start = Date.now();
    try {
      await refreshStatsDaily({ windowDays: WINDOW_DAYS });
      console.log(`[postmark-service] stats-daily refresh completed in ${Date.now() - start}ms`);
    } catch (err: any) {
      console.error(`[postmark-service] stats-daily refresh failed: ${err.message}`);
    } finally {
      running = false;
    }
  };

  // Fire once shortly after boot, then on the interval.
  setTimeout(() => { void tick(); }, 10_000);
  setInterval(() => { void tick(); }, REFRESH_INTERVAL_MS);
}
