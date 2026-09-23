export function metrics(events, from, to) {
  const completed = events.filter(e => ['delivered', 'dead_letter'].includes(e.status));
  const attempts = events.flatMap(e => e.attemptLog).filter(a => a.outcome !== 'started' && Date.parse(a.at) >= from && Date.parse(a.at) <= to);
  const latencies = attempts.filter(a => Number.isFinite(a.latency)).map(a => a.latency).sort((a, b) => a - b);
  const percentile = p => latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] : null;
  const reasons = {};
  for (const a of attempts) if (a.error) reasons[a.error] = (reasons[a.error] || 0) + 1;
  const buckets = Array.from({ length: 12 }, (_, i) => ({ at: new Date(from + (to - from) * i / 12).toISOString(), delivered: 0, failed: 0, attempts: 0, successRate: null }));
  for (const a of attempts) {
    const b = buckets[Math.min(11, Math.floor((Date.parse(a.at) - from) / Math.max(1, to - from) * 12))];
    b.attempts++; a.error ? b.failed++ : b.delivered++;
  }
  for (const b of buckets) if (b.attempts) b.successRate = Math.round(b.delivered / b.attempts * 10000) / 100;
  return { received: events.length, delivered: events.filter(e => e.status === 'delivered').length,
    failed: events.filter(e => e.status === 'dead_letter').length, pending: events.filter(e => !['delivered', 'dead_letter'].includes(e.status)).length,
    successRate: completed.length ? Math.round(completed.filter(e => e.status === 'delivered').length / completed.length * 10000) / 100 : null,
    p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), attemptCount: attempts.length, failureReasons: reasons, series: buckets };
}
export function routeHealth(route, events) {
  const own = events.filter(e => e.endpointId === route.id);
  return { state: !route.enabled ? 'paused' : own.some(e => e.status === 'dead_letter') ? 'attention' : own.some(e => ['retrying', 'processing'].includes(e.status)) ? 'recovering' : own.some(e => e.status === 'delivered') ? 'healthy' : 'no_data',
    deliveries: own.length, failed: own.filter(e => e.status === 'dead_letter').length };
}

