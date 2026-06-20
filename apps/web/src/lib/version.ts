/** This web client's build identity, stamped at build time (see vite.config.ts).
 *  `buildId` changes every build, so it pins down exactly which bundle is loaded —
 *  the server reports the build it serves in `welcome`, and a mismatch means this
 *  page is running stale (un-refreshed) code. */
export interface BuildInfo {
  version: string;
  buildId: string;
}

export const clientBuild: BuildInfo = __MARA_BUILD__;

/** Short, human-readable form of a build id (an ISO timestamp) for display. */
export function shortBuild(buildId: string): string {
  // "2026-06-20T16:45:12.345Z" -> "2026-06-20 16:45"
  return buildId.slice(0, 16).replace('T', ' ');
}
