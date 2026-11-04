import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('artifacts/coverage', { recursive: true });
rmSync('artifacts/coverage/lcov.info', { force: true });
rmSync('artifacts/coverage/summary.json', { force: true });
const result = spawnSync(process.execPath, [
  '--import', 'tsx', '--experimental-test-coverage',
  '--test-coverage-include=src/model/**', '--test-coverage-include=src/connectors/**',
  '--test-coverage-include=src/lib/native-transport.ts', '--test-coverage-include=packages/teamwire-sdk/src/**',
  '--test-reporter=spec', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', '--test-reporter-destination=artifacts/coverage/lcov.info',
  '--test', 'tests/*.test.ts', 'packages/teamwire-sdk/test/*.test.ts',
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const totals = { LF: 0, LH: 0, FNF: 0, FNH: 0, BRF: 0, BRH: 0 };
  for (const line of readFileSync('artifacts/coverage/lcov.info', 'utf8').split('\n')) {
    const match = /^(LF|LH|FNF|FNH|BRF|BRH):(\d+)$/.exec(line.trim());
    if (match) totals[match[1]] += Number(match[2]);
  }
  const metrics = [
    { name: 'lines', covered: totals.LH, total: totals.LF, minimum: 95 },
    { name: 'branches', covered: totals.BRH, total: totals.BRF, minimum: 85 },
    { name: 'functions', covered: totals.FNH, total: totals.FNF, minimum: 90 },
  ].map(metric => ({ ...metric, percentage: metric.total ? 100 * metric.covered / metric.total : 0 }));
  const passed = metrics.every(metric => metric.total > 0 && metric.percentage >= metric.minimum);
  writeFileSync('artifacts/coverage/summary.json', `${JSON.stringify({
    scope: ['src/model/**', 'src/connectors/**', 'src/lib/native-transport.ts', 'packages/teamwire-sdk/src/**'],
    node: process.version, passed, metrics,
  }, null, 2)}\n`);
  for (const metric of metrics) {
    console.log(`Coverage ${metric.name}: ${metric.percentage.toFixed(2)}% (required ${metric.minimum}%)`);
  }
  if (!passed) process.exitCode = 1;
}
