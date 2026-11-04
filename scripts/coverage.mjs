import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

mkdirSync('artifacts/coverage', { recursive: true });
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
