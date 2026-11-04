/** Public, explicit capability boundary; browser transport and model accuracy are separate. */
export const VISION_CAPABILITIES = {
  scope: 'active Chromium web-content viewport',
  coordinateSystem: { range:[0,1000], order:'x,y', fractional:true, excludesBrowserChrome:true },
  pointer: { buttons:['left','right','middle'], clickCounts:[1,2,3], modifiers:['Alt','Control','Meta','Shift'],
    dragWaypoints:128, dragTotalDurationMs:[200,3000], holdDurationMs:[0,3000], persistentButtonState:false },
  wheel: { units:['viewport-percent','CSS-pixel-delta'], diagonal:true, hoveredComponentRouting:true },
  input: { modes:['Unicode-text-insertion','printable-ASCII-key-events'], keyLayout:'US for printable key events', nativeImeComposition:false },
  keyboard: {chordMaxKeys:5, functionKeys:'F1-F24', sidedModifiers:true, numericKeypad:true,
    persistentKeyState:false, browserOrOsShortcutGuarantee:false, clipboardAccessGuarantee:false},
  observation: {zoom:'original-image crop with parent-bound viewId; max 2048px/4MP',
    checks:['URL','bounded visible text','target name/enabled/editable/checked','non-password value equality'],
    statuses:['passed','failed','unknown','observed'],targetGuard:'stable enabled inspectable main-frame DOM targets; not a pixel/business guarantee',
    actionRetry:false},
  humanTiming: 'drag: straight eased segments, independent 500..1500ms held dwell at start/end unless overridden; bounded click/key/input/wheel timing',
  antiBotGuarantee: false,
  unsupported: ['operating-system dialogs/desktop','browser address bar and native menus','multi-touch/pinch gestures',
    'physical keyboard layout/IME emulation','arbitrary offscreen drawing in one gesture','guaranteed model perception or business outcome'],
} as const;
