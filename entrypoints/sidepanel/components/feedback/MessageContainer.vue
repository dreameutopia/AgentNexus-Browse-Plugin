<template>
  <!-- 全局 Toast 宿主：固定右上角、层级高于全部模态（10000/10001）与图片查看器（9999）。
       宿主本身不拦截指针事件——只有 toast 本体可点，聊天区点击不受遮挡 -->
  <div class="message-toast-host">
    <MessageToast
      v-for="msg in messages"
      :key="msg.id"
      :message="msg.message"
      :type="msg.type"
      :duration="0"
      :visible="true"
      @close="removeMessage(msg.id)"
    />
  </div>
</template>

<script setup lang="ts">
import MessageToast from './MessageToast.vue'
import { message } from '../../utils/chat/message'

const { messages, removeMessage } = message
</script>

<style scoped>
.message-toast-host {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 11000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: calc(100vw - 32px);
  pointer-events: none;
}
</style>
