/**
 * Slash commands for the message input. `runSlashCommand` parses a leading-`/` line and
 * dispatches it. It returns `true` whenever the line began with `/` — recognised commands
 * run, and an UNRECOGNISED `/word` shows an error notice — so the line is never sent as a
 * message (catching typos). A line not starting with `/` returns `false` (sent normally).
 *
 * The commands talk to the app only through `CommandContext`, which keeps this module pure
 * and unit-testable (the UI supplies the real implementations in ChatApp).
 */
import type { Token, UserInfo } from '@mara/client-core';

export interface CommandContext {
  /** The channel the line was typed in, or null when in a PM / no conversation. */
  activeChannel: Token | null;
  /** Resolve a currently-connected user by name (case-insensitive); null if none. */
  resolveUser(name: string): UserInfo | null;
  /** Send a `/me` action to the active channel. */
  emote(text: string): void;
  /** Open/focus a PM with the user and send `text` to them. */
  privateMessage(token: Token, text: string): void;
  /** Set (non-empty) or clear (empty) away status. */
  setAway(text: string): void;
  /** Change our display name. */
  setName(name: string): void;
  /** Show a client-side notice line (command help, usage, and errors). */
  notice(text: string): void;
  /** Random number in [0, 1) — injected so dice rolls stay unit-testable. */
  random(): number;
}

interface Command {
  name: string;
  /** Argument summary for `/help`, e.g. `<user> <message>`. */
  args: string;
  help: string;
  run(rest: string, ctx: CommandContext): void;
}

/** Max display-name length (matches the protocol's `setProfile.name`). */
const NAME_MAX = 64;

/** Dice-roll bounds — keep a single `/roll` sane and its output readable. */
const ROLL_MAX_DICE = 100;
const ROLL_MAX_SIDES = 1000;
/** `[p][-]NdM[±K]`: p=private, -=show each die, N dice (default 1), M sides, optional modifier. */
const ROLL_RE = /^(p)?(-)?(\d*)d(\d+)([+-]\d+)?$/i;

const COMMANDS: Command[] = [
  {
    name: 'me',
    args: '<action>',
    help: 'Send an action to the channel',
    run(rest, ctx) {
      if (ctx.activeChannel === null) return ctx.notice('/me can only be used in a channel.');
      if (!rest) return ctx.notice('Usage: /me <action>');
      ctx.emote(rest);
    },
  },
  {
    name: 'msg',
    args: '<user> <message>',
    help: 'Send a private message to a user',
    run(rest, ctx) {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(rest);
      const name = match?.[1];
      const body = match?.[2];
      if (!name || !body) return ctx.notice('Usage: /msg <user> <message>');
      const user = ctx.resolveUser(name);
      if (!user) return ctx.notice(`No connected user named "${name}".`);
      ctx.privateMessage(user.token, body);
    },
  },
  {
    name: 'away',
    args: '[note]',
    help: 'Set your away note (clears it if you give none)',
    run(rest, ctx) {
      // The server broadcasts this back and each client announces it per shared channel
      // ("X is away (note)" / "X is back."), so no separate local notice is needed.
      ctx.setAway(rest);
    },
  },
  {
    name: 'back',
    args: '',
    help: 'Clear your away status',
    run(_rest, ctx) {
      ctx.setAway('');
    },
  },
  {
    name: 'name',
    args: '<new name>',
    help: 'Change your display name',
    run(rest, ctx) {
      if (!rest) return ctx.notice('Usage: /name <new name>');
      if (rest.length > NAME_MAX) return ctx.notice(`Name too long (max ${NAME_MAX}).`);
      ctx.setName(rest);
    },
  },
  {
    name: 'roll',
    args: '[p][-]NdM[±K]',
    help: 'Roll dice (p = private, - = show each die). E.g. 2d20, -5d10, p2d6+3',
    run(rest, ctx) {
      const m = ROLL_RE.exec(rest);
      if (!m) return ctx.notice('Usage: /roll [p][-]NdM[±K] — e.g. 2d20, -5d10, p2d6+3');
      const priv = !!m[1];
      const verbose = !!m[2];
      const count = m[3] ? parseInt(m[3], 10) : 1;
      const sides = parseInt(m[4]!, 10);
      const mod = m[5] ? parseInt(m[5], 10) : 0;
      if (count < 1 || count > ROLL_MAX_DICE)
        return ctx.notice(`/roll: use 1–${ROLL_MAX_DICE} dice.`);
      if (sides < 1 || sides > ROLL_MAX_SIDES)
        return ctx.notice(`/roll: dice need 1–${ROLL_MAX_SIDES} sides.`);
      const rolls: number[] = [];
      for (let i = 0; i < count; i++) rolls.push(1 + Math.floor(ctx.random() * sides));
      const total = rolls.reduce((a, b) => a + b, 0) + mod;
      const spec = `${count}d${sides}${mod ? (mod > 0 ? `+${mod}` : `${mod}`) : ''}`;
      let body: string;
      // Show the individual dice only when there's more than one number to break down.
      if (verbose && (count > 1 || mod)) {
        const modBreak = mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)}` : '';
        body = `${spec}: [${rolls.join(', ')}]${modBreak} = ${total}`;
      } else {
        body = `${spec}: ${total}`;
      }
      // Private rolls (and any roll made outside a channel) show only to you; a public roll
      // emotes to the whole channel so everyone sees the result.
      if (priv || ctx.activeChannel === null) ctx.notice(`You roll ${body}`);
      else ctx.emote(`rolls ${body}`);
    },
  },
  {
    name: 'help',
    args: '',
    help: 'List the available commands',
    run(_rest, ctx) {
      const lines = COMMANDS.map((c) => `/${c.name}${c.args ? ' ' + c.args : ''} — ${c.help}`);
      ctx.notice('Commands:\n' + lines.join('\n'));
    },
  },
];

/**
 * Parse and run a slash command. Returns `true` if the input started with `/` (handled —
 * either a command ran or an "unknown command" notice was shown; do NOT also send it as a
 * message), `false` otherwise (send it normally).
 */
export function runSlashCommand(input: string, ctx: CommandContext): boolean {
  if (!input.startsWith('/')) return false;
  const space = input.indexOf(' ');
  const name = (space === -1 ? input.slice(1) : input.slice(1, space)).toLowerCase();
  const rest = (space === -1 ? '' : input.slice(space + 1)).trim();
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    ctx.notice(`Unknown command: /${name} — type /help for a list.`);
    return true; // swallow it: don't send the typo'd line as a message
  }
  command.run(rest, ctx);
  return true;
}
