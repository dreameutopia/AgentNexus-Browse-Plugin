/** Click delegation for v-html cards. App.vue owns retry policy. */
export interface ApiErrorRetryTarget { messageId: string; partIndex: number; errorIndex: number }
type ApiErrorRetryHandler = (target: ApiErrorRetryTarget) => void | Promise<void>;
let retryHandler: ApiErrorRetryHandler | null = null;
let handlerInstalled = false;
export function setApiErrorRetryHandler(handler: ApiErrorRetryHandler | null): void { retryHandler = handler; }
export function installApiErrorRetryHandler(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;
  document.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest?.('.api-error-retry-btn');
    if (!button || !retryHandler) return;
    event.preventDefault();
    const card = button.closest('.api-error-card');
    const message = button.closest('[data-message-id]');
    const part = button.closest('[data-part-index]');
    const target = { partIndex: Number(part?.getAttribute('data-part-index') ?? -1), messageId: message?.getAttribute('data-message-id') ?? '',
      errorIndex: part ? Array.from(part.querySelectorAll('.api-error-card')).indexOf(card!) : -1 };
    try {
      void Promise.resolve(retryHandler(target)).catch(error => console.warn('[ApiErrorRetry]', error));
    } catch (error) { console.warn('[ApiErrorRetry]', error); }
  });
}
