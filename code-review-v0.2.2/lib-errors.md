# Module: src/lib/errors.ts

**LoC**: 28  •  **Test file**: no  •  **v0.2.2 status**: NEW in v0.2.2

## Purpose
Defines the four user-facing error categories (`UserError`, `EnvError`, `CollisionError`) plus the canonical exit-code map (`EXIT`). Lets command code throw a typed error and the top-level CLI handler in `cli.ts` map it to the right exit code without per-command branching.

## Public surface
- Const: `EXIT`
- Types: `ExitCode`
- Classes: `UserError`, `EnvError`, `CollisionError`

## Strengths
- Excellent tiny module: 28 LoC, one job. The shape is exactly what the rest of the codebase needs — every command file imports it (verified via grep: `cli.ts`, all 8 `commands/*.ts` consumers).
- Exit-code values (`OK: 0, USER: 1, ENV: 2, COLLISION: 3`) match the user-facing contract and are tagged with a "do not renumber" warning at line 5–6 — exactly the kind of constraint that needs to be commented at the source.
- `ExitCode` derived type (line 8) — `(typeof EXIT)[keyof typeof EXIT]` — keeps the union in lockstep with the const. If a new EXIT key is added, `ExitCode` widens automatically.
- `UserError` / `EnvError` / `CollisionError` carry `readonly exitCode = EXIT.X` (lines 12, 17, 22) so the top-level handler can `err.exitCode ?? EXIT.USER` without instanceof-cascades.
- `CollisionError.conflicts` (line 23) preserves the structured payload instead of stringifying.

## Concerns
### Cohesion
Single-purpose: typed errors + exit-code contract. Right grouping.

### Coupling
- Imports `Conflict` from `./types.js` (line 1) — small but real coupling. The alternative would be making `CollisionError` generic and letting callers parameterize. Today's coupling is acceptable because `CollisionError` is only ever thrown with `Conflict[]`.
- Consumers: `cli.ts` and 8 `commands/*.ts` modules. Tight, expected.

### Maintainability
- 28 LoC, no functions, no logic. Adding a fourth error category is mechanical.
- No `cause` plumbing in the constructors — `new UserError("…", { cause: err })` would not currently attach the cause because the constructors don't forward options. JavaScript `Error` accepts `(message, options)`; subclassing without forwarding loses the cause. For an OSS release this is a small nit; in practice the CLI wraps causes with formatted messages anyway.
- No `static fromError(err: unknown): UserError` helper — every call site does `throw new UserError(\`failed: ${(err as Error).message}\`)` which discards the original stack. Adding a `cause: err` plumb would be one constructor change.

### Style
- Naming consistent with conventional Node ergonomics (`Foo extends Error`, readonly exitCode).
- No emojis, no TODOs.
- The `as const` at line 7 makes `EXIT` properties literal-typed — important for `ExitCode` derivation.
- Test file is missing, but the module is small enough that visual review covers it. A 5-line smoke test (each error throws, has the right `exitCode`, `instanceof Error`) would be quick insurance.

## Specific issues
- `src/lib/errors.ts:11–13, 16–18` — `UserError` and `EnvError` constructors do not forward `cause`. `new UserError("foo", { cause: e })` will compile but the cause is dropped because the constructor is the default `Error(message)` — it won't pass through options. Add `constructor(message: string, options?: ErrorOptions) { super(message, options); }` to both.
- `src/lib/errors.ts:22–28` — `CollisionError`'s constructor takes `(message, conflicts)` but no `options` slot, so causes can't be attached at all. Same fix.
- `src/lib/errors.ts` — no `errors.test.ts`. A 10-line smoke test for the exit-code map and instanceof checks is worth having since this is the contract scripts depend on.

## Suggestions
- **[medium]** Add `constructor(message, options?: ErrorOptions)` to `UserError`/`EnvError` and forward to `super`. One-line each. Today, wrapping a caught error loses the cause chain, which makes debugging harder for users running with `DEBUG=1` or similar.
- **[low]** Add `errors.test.ts` smoke test (~10 LoC): construct each, assert `exitCode`, assert `instanceof Error`. The exit-code contract is part of the OSS API surface; a regression test pins it.
- **[low]** Optional `Error.captureStackTrace(this, ThisClass)` in each constructor for cleaner stacks. V8-only but also no-op elsewhere.
