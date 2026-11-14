import type { ExtendedChatMessage } from '../../types/chat';
/** Tool rounds are model batches, not individual parallel calls. Historical records fall back to call count. */
export function skillCaptureState(messages: readonly ExtendedChatMessage[], responding: boolean) {
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--)
        if (messages[index].role === 'user' && !messages[index].isIgnore) {
            userIndex = index;
            break;
        }
    const visible = messages.filter(message => !message.isIgnore && !message.isSystemNotice), last = visible.at(-1);
    const rounds = (message: ExtendedChatMessage) => Number.isSafeInteger(message.toolRounds) && message.toolRounds! >= 0 ? message.toolRounds! : new Set((message.toolCalls ?? []).map(call => call.id)).size;
    const unique = [...new Map(messages.filter(message => message.role === 'assistant').map((message, index) => [message.id ?? 'legacy:' + index, message])).values()];
    const sessionRounds = unique.reduce((sum, message) => sum + rounds(message), 0);
    const taskRounds = [...new Map(messages.slice(userIndex + 1).filter(message => message.role === 'assistant').map((message, index) => [message.id ?? 'legacy:' + index, message])).values()].reduce((sum, message) => sum + rounds(message), 0);
    return { messageId: last?.id, scope: messages[userIndex]?.id ?? String(userIndex), taskRounds, sessionRounds,
        eligible: !responding && userIndex >= 0 && last?.role === 'assistant' && !!last.id && !last.isThinking && (!last.completionStatus || last.completionStatus === 'done') && (taskRounds > 20 || sessionRounds > 40),
    };
}
