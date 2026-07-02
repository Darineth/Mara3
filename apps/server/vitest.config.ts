import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These suites each start a real HTTP + WebSocket server on an OS-assigned port and
    // drive it over live sockets with real timers/sleeps. Spreading the files across
    // parallel forked workers multiplies process/port/CPU contention, and under load
    // (notably `turbo run test`, which runs packages concurrently) vitest 2.1's forks
    // pool intermittently reports "Worker exited unexpectedly" while tearing those
    // workers down — a teardown race, not a real test failure. Running everything in one
    // long-lived fork removes the per-file worker spawn/teardown churn and the
    // contention, so the run is deterministic. Files still run isolated (vitest's default
    // `isolate: true` gives each file a fresh module registry), just sequentially — cheap
    // for a suite this size.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
