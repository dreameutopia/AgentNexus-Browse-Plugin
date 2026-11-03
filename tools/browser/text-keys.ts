import { resolveKeys } from '../vision/key-definitions';

const aliases: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  win: 'Meta',
  super: 'Meta',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  del: 'Delete',
  delete: 'Delete',
  ins: 'Insert',
  insert: 'Insert',
  left: 'ArrowLeft',
  arrowleft: 'ArrowLeft',
  right: 'ArrowRight',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  arrowup: 'ArrowUp',
  down: 'ArrowDown',
  arrowdown: 'ArrowDown',
  home: 'Home',
  end: 'End',
  pgup: 'PageUp',
  pageup: 'PageUp',
  pgdn: 'PageDown',
  pagedown: 'PageDown',
  capslock: 'CapsLock',
  contextmenu: 'ContextMenu',
  numlock: 'NumLock',
  scrolllock: 'ScrollLock',
  pause: 'Pause',
  printscreen: 'PrintScreen',
};
const primary = new Set([
  'mod',
  'controlormeta',
  'ctrlormeta',
  'cmdorctrl',
  'commandorcontrol',
]);

/** Normalizes notation only; never guesses an application's shortcut meaning. */
export function needsPrimaryModifier(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((k) => typeof k === 'string' && primary.has(k.toLowerCase()))
  );
}
export function resolveTextKeys(value: unknown, os?: string) {
  if (!Array.isArray(value) || value.some((k) => typeof k !== 'string'))
    return resolveKeys(value);
  const names = value.map((name: string) => {
    const lower = name.toLowerCase();
    if (primary.has(lower)) {
      if (!os)
        throw new Error('无法确定平台修饰键，请明确使用 Control 或 Meta');
      return os === 'mac' ? 'Meta' : 'Control';
    }
    return Object.hasOwn(aliases, lower)
      ? aliases[lower]
      : /^f\d{1,2}$/i.test(name)
        ? name.toUpperCase()
        : name;
  });
  // Ctrl+A is a conventional spelling for Ctrl+a, not Ctrl+Shift+a.
  const shortcut = names.some((k) => ['Control', 'Alt', 'Meta'].includes(k));
  return resolveKeys(
    names.map((k) => (shortcut && /^[A-Z]$/.test(k) ? k.toLowerCase() : k))
  );
}
