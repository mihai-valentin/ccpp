/**
 * Public package entry — type re-exports only. The CLI lives in `src/cli.ts`
 * and ships as the `ccpp` bin; programmatic consumers should import types
 * from this entry and treat anything not exported here as internal.
 */
export type * as Types from './lib/types.js';
