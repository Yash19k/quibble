// Structured logging + CloudWatch custom metrics.
//
// log() writes one JSON object per line, which CloudWatch Logs Insights can query directly:
//   fields @timestamp, level, msg | filter level = "error"
//
// metric() uses the CloudWatch Embedded Metric Format (EMF): a specially shaped log line that
// CloudWatch turns into a real metric (namespace "Quibble"), with no extra API calls or IAM.

export function log(level, msg, extra = {}) {
  const line = { level, msg, ...extra };
  if (extra.error instanceof Error) line.error = { message: extra.error.message, name: extra.error.name, stack: extra.error.stack };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

export function metric(name, value = 1, unit = 'Count') {
  if (process.env.QUIBBLE_LOCAL) return; // the local dev server has no CloudWatch
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: 'Quibble', Dimensions: [[]], Metrics: [{ Name: name, Unit: unit }] }],
    },
    [name]: value,
  }));
}
