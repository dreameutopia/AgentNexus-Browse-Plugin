/** Types only: injected functions must not capture module bindings. */
export interface ElementReferenceRegistry {
  register(element: Element): string;
  resolve(id: string): Element | null;
  fingerprint(): string;
  invalidate(): void;
}

export type ReferenceDocument = Document & {
  __agentNexusReferences?: ElementReferenceRegistry;
};

/** A read-only second pass, in the same isolated world as scan and action. */
export function validateElementReferences(
  ids: string[],
  requireActionable = true
): { fingerprint: string; valid: boolean } {
  const registry = (document as ReferenceDocument).__agentNexusReferences;
  return {
    fingerprint: registry?.fingerprint() ?? '',
    valid:
      !!registry &&
      ids.every((id) => {
        const node = registry.resolve(id);
        if (!node) return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          !(Number.parseFloat(style.opacity) < 0.1) &&
          rect.width >= 1 &&
          rect.height >= 1 &&
          (!requireActionable ||
            (!node.matches(':disabled, [aria-disabled="true"]') &&
              !node.closest('[inert]')))
        );
      }),
  };
}
