/** Session scripts are core tools, never selectable agent contributions. */
export const JS_RUN_TOOL_ID = 'js_run';
export const BACKEND_PAGE_EXEC_TOOL_ID = 'browser_page_exec';
export function isHiddenAgentScriptTool(id: string): boolean {
    return id === JS_RUN_TOOL_ID || id === BACKEND_PAGE_EXEC_TOOL_ID;
}
