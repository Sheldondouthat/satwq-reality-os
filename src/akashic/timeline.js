/**
 * Akashic Records — timeline math.
 *
 * Pure functions: bucket events into a density histogram for the scrubber,
 * and filter the event set to "everything up to the cutoff" for replay mode.
 * No DOM, no Cesium.
 */

export const TIMELINE_WINDOW_DAYS = 30;
export const TIMELINE_BUCKET_COUNT = 120;

/**
 * Bucket events into a fixed-count density histogram over the trailing window.
 * @returns {{ buckets: Array<{start:number,end:number,count:number}>, max:number, windowStart:number, windowEnd:number }}
 */
export function bucketizeEvents(
  events,
  {
    days = TIMELINE_WINDOW_DAYS,
    bucketCount = TIMELINE_BUCKET_COUNT,
    now = () => Date.now(),
  } = {},
) {
  const windowEnd = now();
  const windowStart = windowEnd - days * 86400000;
  const span = Math.max(1, windowEnd - windowStart);
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({
    start: windowStart + (span * i) / bucketCount,
    end: windowStart + (span * (i + 1)) / bucketCount,
    count: 0,
  }));
  let max = 0;
  for (const event of events ?? []) {
    if (!event || !Number.isFinite(event.time)) continue;
    if (event.time < windowStart || event.time > windowEnd) continue;
    const index = Math.min(
      bucketCount - 1,
      Math.floor(((event.time - windowStart) / span) * bucketCount),
    );
    buckets[index].count += 1;
    if (buckets[index].count > max) max = buckets[index].count;
  }
  return { buckets, max, windowStart, windowEnd };
}

/**
 * Replay filter: the globe shows exactly the events at or before the cutoff.
 * Sorted oldest-first so markers paint in chronological order.
 */
export function filterEventsUpTo(events, cutoffMs) {
  if (!Number.isFinite(cutoffMs)) return [];
  return (events ?? [])
    .filter((e) => e && Number.isFinite(e.time) && e.time <= cutoffMs)
    .sort((a, b) => a.time - b.time || String(a.id).localeCompare(String(b.id)));
}

/** Format a cutoff timestamp for the timeline readout. */
export function formatCutoff(cutoffMs) {
  if (!Number.isFinite(cutoffMs)) return '—';
  const date = new Date(cutoffMs);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
