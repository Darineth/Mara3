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
    random: () => 0.5, // deterministic: die of M sides -> 1 + floor(0.5 * M)
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

  it('sends a pasted image path (leading /) as a message, not a command', () => {
    // An image-only paste is sent as its bare upload path; it must not be mistaken for a
    // command and swallowed. The "name" contains slashes/dots, so it is not command-shaped.
    const c = ctx();
    expect(runSlashCommand('/uploads/abc123.png', c)).toBe(false);
    expect(c.notice).not.toHaveBeenCalled();

    // Typed text plus the pasted image URL on the next line also passes through.
    const c2 = ctx();
    expect(runSlashCommand('/uploads/a.png\n/uploads/b.png', c2)).toBe(false);
    expect(c2.notice).not.toHaveBeenCalled();
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

  it('/roll emotes a public roll to the channel (total only)', () => {
    const c = ctx();
    // random 0.5 -> each d20 = 11, so 2d20 = 22.
    expect(runSlashCommand('/roll 2d20', c)).toBe(true);
    expect(c.emote).toHaveBeenCalledWith('rolls 2d20: 22');
    expect(c.notice).not.toHaveBeenCalled();
  });

  it('/roll with "p" keeps the result private (notice, not emote)', () => {
    const c = ctx();
    runSlashCommand('/roll p2d20', c);
    expect(c.emote).not.toHaveBeenCalled();
    expect(c.notice).toHaveBeenCalledWith('You roll 2d20: 22');
  });

  it('/roll with "-" shows each die', () => {
    const c = ctx();
    // random 0.5 -> each d6 = 4.
    runSlashCommand('/roll -3d6', c);
    expect(c.emote).toHaveBeenCalledWith('rolls 3d6: [4, 4, 4] = 12');
  });

  it('/roll applies a modifier and shows it in the breakdown', () => {
    const c = ctx();
    runSlashCommand('/roll -2d6+3', c);
    expect(c.emote).toHaveBeenCalledWith('rolls 2d6+3: [4, 4] + 3 = 11');

    const c2 = ctx();
    runSlashCommand('/roll 2d6-1', c2); // non-verbose: total only
    expect(c2.emote).toHaveBeenCalledWith('rolls 2d6-1: 7');
  });

  it('/roll defaults the count and combines p and - flags', () => {
    const c = ctx();
    runSlashCommand('/roll p-d20', c); // 1 die, private, verbose (single die -> total only)
    expect(c.emote).not.toHaveBeenCalled();
    expect(c.notice).toHaveBeenCalledWith('You roll 1d20: 11');
  });

  it('/roll falls back to a private notice when not in a channel', () => {
    const c = ctx({ activeChannel: null });
    runSlashCommand('/roll 1d20', c);
    expect(c.emote).not.toHaveBeenCalled();
    expect(c.notice).toHaveBeenCalledWith('You roll 1d20: 11');
  });

  it('/roll rejects bad syntax and out-of-range dice', () => {
    const bad = ctx();
    runSlashCommand('/roll nonsense', bad);
    expect(bad.notice).toHaveBeenCalledWith(expect.stringContaining('Usage'));

    const many = ctx();
    runSlashCommand('/roll 999d6', many);
    expect(many.emote).not.toHaveBeenCalled();
    expect(many.notice).toHaveBeenCalledWith(expect.stringContaining('dice'));

    const big = ctx();
    runSlashCommand('/roll 1d99999', big);
    expect(big.emote).not.toHaveBeenCalled();
    expect(big.notice).toHaveBeenCalledWith(expect.stringContaining('sides'));
  });

  it('/help lists every command', () => {
    let text = '';
    const c = ctx({ notice: (t) => (text = t) });
    runSlashCommand('/help', c);
    for (const name of ['/me', '/msg', '/away', '/back', '/name', '/roll', '/help']) {
      expect(text).toContain(name);
    }
  });

  it('is case-insensitive on the command name', () => {
    const c = ctx();
    expect(runSlashCommand('/ME waves', c)).toBe(true);
    expect(c.emote).toHaveBeenCalledWith('waves');
  });
});
