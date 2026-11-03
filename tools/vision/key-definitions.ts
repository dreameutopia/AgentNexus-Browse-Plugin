import { GuiError } from './gui-errors';

export type Modifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export const MODIFIER_BITS: Record<Modifier, number> = { Alt:1, Control:2, Meta:4, Shift:8 };
export interface KeyDefinition { key: string; code: string; windowsVirtualKeyCode: number; modifier: number; shifted?: string; location?: number; isKeypad?: boolean }
const aliases: Record<string,string> = {
  Ctrl:'Control', Cmd:'Meta', Command:'Meta', Win:'Meta', Super:'Meta', Option:'Alt',
  Esc:'Escape', Return:'Enter', Del:'Delete', Ins:'Insert', Spacebar:'Space',
  Left:'ArrowLeft', Right:'ArrowRight', Up:'ArrowUp', Down:'ArrowDown', PgUp:'PageUp', PgDn:'PageDown',
};
const keypad: Record<string,[string,number]> = {
  NumpadEnter:['Enter',13], NumpadAdd:['+',107], NumpadSubtract:['-',109],
  NumpadMultiply:['*',106], NumpadDivide:['/',111], NumpadDecimal:['.',110],
};
const named: Record<string, [string, number]> = {
  Enter:['Enter',13], Tab:['Tab',9], Escape:['Escape',27], Backspace:['Backspace',8], Delete:['Delete',46],
  ArrowLeft:['ArrowLeft',37], ArrowUp:['ArrowUp',38], ArrowRight:['ArrowRight',39], ArrowDown:['ArrowDown',40],
  Home:['Home',36], End:['End',35], PageUp:['PageUp',33], PageDown:['PageDown',34], Insert:['Insert',45],
  CapsLock:['CapsLock',20], Space:['Space',32],
  ContextMenu:['ContextMenu',93], NumLock:['NumLock',144], ScrollLock:['ScrollLock',145], Pause:['Pause',19], PrintScreen:['PrintScreen',44],
  Control:['ControlLeft',17], Shift:['ShiftLeft',16], Alt:['AltLeft',18], Meta:['MetaLeft',91],
};
const punctuation: [string,string,string,number][] = [
  ['`','~','Backquote',192],['-','_','Minus',189],['=','+','Equal',187],['[','{','BracketLeft',219],
  [']','}','BracketRight',221],['\\','|','Backslash',220],[';',':','Semicolon',186],["'",'"','Quote',222],
  [',','<','Comma',188],['.','>','Period',190],['/','?','Slash',191],
  ...Array.from('0123456789', (digit,i): [string,string,string,number] => [digit,')!@#$%^&*('[i],`Digit${digit}`,48+i]),
];
export function validateModifiers(value: unknown): Modifier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4 || value.some(k => typeof k !== 'string' || !Object.hasOwn(MODIFIER_BITS,k)) || new Set(value).size !== value.length)
    throw new GuiError('INVALID_ARGUMENT','modifiers accepts unique Alt/Control/Meta/Shift names (at most four)');
  return value as Modifier[];
}
export function resolveKeys(value: unknown): KeyDefinition[] {
  if (!Array.isArray(value) || !value.length || value.length > 5 || value.some(k => typeof k !== 'string' || k.length > 32))
    throw new GuiError('INVALID_ARGUMENT','keys requires 1..5 key names, each at most 32 characters');
  let needsShift = false;
  const keys = value.map((input: string): KeyDefinition => {
    const name = Object.hasOwn(aliases,input) ? aliases[input] : input;
    const side = /^(Control|Shift|Alt|Meta)(Left|Right)$/.exec(name);
    if (side) {
      const key = side[1] as Modifier;
      return {key,code:name,windowsVirtualKeyCode:key === 'Meta' && side[2] === 'Right' ? 92 : named[key][1],modifier:MODIFIER_BITS[key],location:side[2] === 'Right' ? 2 : 1};
    }
    if (/^Numpad[0-9]$/.test(name)) return {key:name.slice(-1),code:name,windowsVirtualKeyCode:96+Number(name.slice(-1)),modifier:0,isKeypad:true};
    if (Object.hasOwn(keypad,name)) return {key:keypad[name][0],code:name,windowsVirtualKeyCode:keypad[name][1],modifier:0,isKeypad:true};
    if (Object.hasOwn(named,name)) return { key:name === 'Space' ? ' ' : name, code:named[name][0], windowsVirtualKeyCode:named[name][1], modifier:MODIFIER_BITS[name as Modifier] ?? 0,
      ...(Object.hasOwn(MODIFIER_BITS,name) ? {location:1} : {}) };
    if (/^F([1-9]|1\d|2[0-4])$/.test(name)) return { key:name,code:name,windowsVirtualKeyCode:111+Number(name.slice(1)),modifier:0 };
    if (/^[a-z]$/i.test(name)) {
      if (name === name.toUpperCase()) needsShift = true;
      return { key:name,code:`Key${name.toUpperCase()}`,windowsVirtualKeyCode:name.toUpperCase().charCodeAt(0),modifier:0,shifted:name.toUpperCase() };
    }
    if (name === ' ') return { key:' ',code:'Space',windowsVirtualKeyCode:32,modifier:0 };
    const entry = punctuation.find(([plain,shifted]) => name === plain || name === shifted);
    if (entry) { if (name === entry[1]) needsShift = true; return { key:name,code:entry[2],windowsVirtualKeyCode:entry[3],modifier:0,shifted:entry[1] }; }
    throw new GuiError('INVALID_ARGUMENT',`Unsupported key: ${name}`);
  });
  if (new Set(keys.map(k=>k.code)).size !== keys.length) throw new GuiError('INVALID_ARGUMENT','Duplicate physical key (including aliases)');
  if (needsShift && !keys.some(k => k.modifier === 8)) keys.unshift({key:'Shift',code:'ShiftLeft',windowsVirtualKeyCode:16,modifier:8,location:1});
  return keys.sort((a,b) => Number(!!b.modifier) - Number(!!a.modifier));
}
