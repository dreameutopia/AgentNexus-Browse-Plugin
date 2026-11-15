/** Shared contracts; serialized injections must not capture module bindings. */
export interface ElementReferenceRegistry {
  semanticVersion?: number;
  register(element: Element): string;
  resolve(id: string): Element | null;
  fingerprint(): string;
  invalidate(): void;
  describe?(element: Element): ControlSemantics;
  isRendered?(element: Element): boolean;
}

export interface ControlSemantics {
  category: string;
  patterns?: string[];
  role: string;
  evidence: string;
  name: string;
  states: Record<string, unknown>;
  relations: Array<{
    relation: string;
    elementId: string;
    role: string;
    name: string;
  }>;
  actions: string[];
}

export const CONTROL_CATEGORIES = [
  'button',
  'close',
  'link',
  'text',
  'search',
  'password',
  'number',
  'date',
  'time',
  'color',
  'slider',
  'spinbutton',
  'checkbox',
  'radio',
  'switch',
  'toggle',
  'select',
  'multiselect',
  'combobox',
  'listbox',
  'option',
  'menu',
  'menuitem',
  'tab',
  'tablist',
  'tree',
  'treeitem',
  'grid',
  'gridcell',
  'dialog',
  'disclosure',
  'group',
  'toolbar',
  'tooltip',
  'status',
  'progress',
  'meter',
  'separator',
  'file',
  'editor',
  'scroll',
  'element',
  'table', 'row', 'cell', 'columnheader', 'rowheader', 'tabpanel',
  'calendar', 'date-range', 'time-range', 'date-segment',
] as const;

/** A control can be a grid and a calendar at the same time. */
export function matchesControlCategory(semantics: Pick<ControlSemantics, 'category' | 'patterns'> | undefined, categories: readonly string[]): boolean {
  return !categories.length || categories.some(category => category === (semantics?.category || 'element') || semantics?.patterns?.includes(category));
}

export type ReferenceDocument = Document & {
  __agentNexusReferences?: ElementReferenceRegistry;
};

/** A read-only second pass, in the same isolated world as scan and action. */
export function validateElementReferences(
  ids: string[],
  requireActionable = true,
): {
  fingerprint: string;
  valid: boolean;
  semantics?: Array<{ elementId: string; semantics: ControlSemantics }>;
  validElementIds?: string[];
  invalidElementIds?: string[];
  errors?: Array<{ elementId: string; message: string }>;
} {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  const validElementIds: string[] = [];
  const invalidElementIds: string[] = [];
  const semantics: Array<{ elementId: string; semantics: ControlSemantics }> = [];
  const errors: Array<{ elementId: string; message: string }> = [];
  for (const elementId of ids) {
    try {
      const node = registry?.resolve(elementId);
      if (!node) { invalidElementIds.push(elementId); continue; }
      const current = registry?.describe?.(node);
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const rendered = registry?.isRendered ? registry.isRendered(node) : style.display !== 'none';
      const actionable = !requireActionable || (!current?.states.disabled && !node.matches(':disabled') && !node.closest('[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])'));
      if (!rendered || style.visibility === 'hidden' || style.visibility === 'collapse' || Number.parseFloat(style.opacity) < 0.1 || rect.width < 1 || rect.height < 1 || !actionable) {
        invalidElementIds.push(elementId);
        continue;
      }
      validElementIds.push(elementId);
      if (current) semantics.push({ elementId, semantics: current });
    } catch (error) {
      invalidElementIds.push(elementId);
      let message = 'Unserializable reference validation error';
      try { message = (error instanceof Error ? error.message : String(error)).slice(0, 300); } catch { /* Keep the fallback. */ }
      errors.push({ elementId, message });
    }
  }
  return {
    fingerprint: registry?.fingerprint() ?? '',
    semantics: registry?.describe ? semantics : undefined,
    valid: !!registry && invalidElementIds.length === 0,
    validElementIds,
    invalidElementIds,
    ...(errors.length ? { errors } : {}),
  };
}
