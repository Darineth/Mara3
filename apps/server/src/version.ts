// Server + served-web build identity, reported to clients in `welcome` so they can
// show versions and detect a stale (un-refreshed) page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type ServerInfo } from '@mara/protocol';

// Read our own version from package.json. `../package.json` resolves the same from
// `src/` (tsx) or the built `dist/` — both sit one level under the package root.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const SERVER_VERSION: string = pkg.version;

/**
 * Read the build id of the web assets we are serving (written to dist/version.json
 * by the web build). Returns undefined in dev/headless, or if the file is missing
 * or malformed — staleness detection simply goes quiet rather than failing.
 */
export function readWebBuild(webRoot: string | null): string | undefined {
  if (!webRoot) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(webRoot, 'version.json'), 'utf8')) as {
      buildId?: unknown;
    };
    return typeof parsed.buildId === 'string' ? parsed.buildId : undefined;
  } catch {
    return undefined;
  }
}

/** Assemble the `welcome.server` payload for a given web root. */
export function getServerInfo(webRoot: string | null): ServerInfo {
  return {
    version: SERVER_VERSION,
    protocol: PROTOCOL_VERSION,
    webBuild: readWebBuild(webRoot),
  };
}
