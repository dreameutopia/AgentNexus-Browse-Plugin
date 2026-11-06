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
} {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  return {
    fingerprint: registry?.fingerprint() ?? '',
    semantics: registry?.describe
      ? ids.flatMap((elementId) => {
          const node = registry.resolve(elementId);
          return node
            ? [{ elementId, semantics: registry.describe!(node) }]
            : [];
        })
      : undefined,
    valid:
      !!registry &&
      ids.every((id) => {
        const node = registry.resolve(id);
        if (!node) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          (registry.isRendered ? registry.isRendered(node) : style.display !== 'none') &&
          style.visibility !== 'hidden' &&
          !(Number.parseFloat(style.opacity) < 0.1) &&
          rect.width >= 1 &&
          rect.height >= 1 &&
          (!requireActionable ||
            (!registry.describe?.(node).states.disabled &&
              !node.matches(':disabled') &&
              !node.closest(
                '[inert],[aria-disabled="true"],[data-disabled]:not([data-disabled="false"])',
              )))
        );
      }),
  };
}
