import { describe, expect, it } from 'vitest';
import { CollisionError, EXIT, EnvError, UserError } from './errors.js';

describe('error classes', () => {
  it('UserError carries its exit code and the message', () => {
    const err = new UserError('boom');
    expect(err.exitCode).toBe(EXIT.USER);
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(UserError);
  });

  it('EnvError carries its exit code', () => {
    expect(new EnvError('boom').exitCode).toBe(EXIT.ENV);
  });

  it('CollisionError carries conflicts + exit code', () => {
    const conflicts = [
      {
        destPath: '/foo',
        currentSourceUrl: 'a',
        incomingSourceUrl: 'b',
        name: 'foo',
      },
    ];
    const err = new CollisionError('boom', conflicts);
    expect(err.exitCode).toBe(EXIT.COLLISION);
    expect(err.conflicts).toEqual(conflicts);
  });

  it('UserError forwards the ES2022 cause chain (inherited from Error)', () => {
    // The class doesn't define its own constructor — Error's constructor
    // signature `(message, options?)` is inherited unchanged. This test
    // pins that behavior so a future rewrite can't silently drop it.
    const root = new Error('root');
    const wrapped = new UserError('outer', { cause: root });
    expect(wrapped.cause).toBe(root);
  });

  it('EnvError forwards cause too', () => {
    const root = new Error('root');
    const wrapped = new EnvError('outer', { cause: root });
    expect(wrapped.cause).toBe(root);
  });

  it('CollisionError forwards cause through its 3rd-arg options', () => {
    const root = new Error('root');
    const err = new CollisionError('outer', [], { cause: root });
    expect(err.cause).toBe(root);
  });

  it('EXIT codes match the documented user contract', () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.USER).toBe(1);
    expect(EXIT.ENV).toBe(2);
    expect(EXIT.COLLISION).toBe(3);
  });
});
