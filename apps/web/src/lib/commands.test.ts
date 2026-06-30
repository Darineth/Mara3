import { describe, expect, it, vi } from 'vitest';
import { runSlashCommand, type CommandContext } from './commands.js';
import type { UserInfo } from '@mara/client-core';

const bob: UserInfo = { token: 7, name: 'Bob', color: '#3366cc', away: '' };

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    activeChannel: 1,
    resolveUser: (name) => (name.toLowerCase() === 'bob' ? bob : null),
    emote: vi.fn(),
    privateMessage: vi.fn(),
    setAway: vi.fn(),
    setName: vi.fn(),
    notice: vi.fn(),
    ...overrides,
  };
}

describe('runSlashCommand', () => {
  it('sends ordinary text (no leading slash) as a message', () => {
    const c = ctx();
    expect(runSlashCommand('hello there', c)).toBe(false);
    expect(c.notice).not.toHaveBeenCalled();
  });

  it('swallows an unknown command with an error notice (catches typos)', () => {
    const c = ctx();
    expect(runSlashCommand('/nope x', c)).toBe(true);
    expect(c.notice).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  it('/me emotes to the active channel', () => {
    const c = ctx();
    expect(runSlashCommand('/me waves', c)).toBe(true);
    expect(c.emote).toHaveBeenCalledWith('waves');
  });

  it('/me requires a channel and an argument', () => {
    const noChan = ctx({ activeChannel: null });
    expect(runSlashCommand('/me waves', noChan)).toBe(true);
    expect(noChan.emote).not.toHaveBeenCalled();
    expect(noChan.notice).toHaveBeenCalledWith(expect.stringContaining('channel'));

    const c = ctx();
    runSlashCommand('/me', c);
    expect(c.emote).not.toHaveBeenCalled();
    expect(c.notice).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('/msg resolves the user (case-insensitive) and sends, preserving the message', () => {
    const c = ctx();
    expect(runSlashCommand('/msg bob hello there', c)).toBe(true);
    expect(c.privateMessage).toHaveBeenCalledWith(7, 'hello there');
  });

  it('/msg reports an unknown user and bad usage', () => {
    const c = ctx();
    runSlashCommand('/msg ghost hi', c);
    expect(c.privateMessage).not.toHaveBeenCalled();
    expect(c.notice).toHaveBeenCalledWith(expect.stringContaining('ghost'));

    const c2 = ctx();
    runSlashCommand('/msg bob', c2); // no message body
    expect(c2.privateMessage).not.toHaveBeenCalled();
    expect(c2.notice).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('/away sets a note, and clears it when bare', () => {
    const c = ctx();
    runSlashCommand('/away lunch', c);
    expect(c.setAway).toHaveBeenCalledWith('lunch');

    const c2 = ctx();
    runSlashCommand('/away', c2);
    expect(c2.setAway).toHaveBeenCalledWith('');
  });

  it('/back clears away status', () => {
    const c = ctx();
    expect(runSlashCommand('/back', c)).toBe(true);
    expect(c.setAway).toHaveBeenCalledWith('');
  });

  it('/name changes the display name and rejects empty/too-long', () => {
    const c = ctx();
    runSlashCommand('/name Alice', c);
    expect(c.setName).toHaveBeenCalledWith('Alice');

    const c2 = ctx();
    runSlashCommand(`/name ${'x'.repeat(65)}`, c2);
    expect(c2.setName).not.toHaveBeenCalled();
    expect(c2.notice).toHaveBeenCalledWith(expect.stringContaining('too long'));
  });

  it('/help lists every command', () => {
    let text = '';
    const c = ctx({ notice: (t) => (text = t) });
    runSlashCommand('/help', c);
    for (const name of ['/me', '/msg', '/away', '/back', '/name', '/help']) {
      expect(text).toContain(name);
    }
  });

  it('is case-insensitive on the command name', () => {
    const c = ctx();
    expect(runSlashCommand('/ME waves', c)).toBe(true);
    expect(c.emote).toHaveBeenCalledWith('waves');
  });
});
