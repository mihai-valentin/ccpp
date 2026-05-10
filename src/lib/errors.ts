import type { Conflict } from './types.js';

/**
 * Exit codes — must match the user-facing contract documented in `ccpp --help`
 * and `docs/exit-codes.md`. Scripts depend on these values, so do not renumber.
 */
export const EXIT = { OK: 0, USER: 1, ENV: 2, COLLISION: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** User-fixable problem — bad flags, missing config, conflicting input. Exit 1. */
export class UserError extends Error {
  readonly exitCode = EXIT.USER;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Environment problem — git unavailable, network failure, unreadable file. Exit 2. */
export class EnvError extends Error {
  readonly exitCode = EXIT.ENV;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Two sources tried to install the same destination. Exit 3. */
export class CollisionError extends Error {
  readonly exitCode = EXIT.COLLISION;
  readonly conflicts: Conflict[];
  constructor(message: string, conflicts: Conflict[], options?: ErrorOptions) {
    super(message, options);
    this.conflicts = conflicts;
  }
}
