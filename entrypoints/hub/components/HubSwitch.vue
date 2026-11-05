<template>
  <!--
    iOS 形态自定义开关（Hub 全站替换原生 checkbox 开关）。
    玻璃轨道 + 弹性滑块：按住微展宽、开启染品牌渐变（样式见 hub.css .hub-switch）。
    文案走默认插槽（i18n 由使用方传入），不传则只渲染开关本体。
  -->
  <label class="hub-switch" :class="{ 'is-disabled': disabled }">
    <input
      class="hub-switch__input"
      type="checkbox"
      role="switch"
      :checked="modelValue"
      :disabled="disabled"
      @change="onChange"
    />
    <span class="hub-switch__track" aria-hidden="true"></span>
    <span v-if="hasLabel" class="hub-switch__label"><slot /></span>
  </label>
</template>

<script setup lang="ts">
/**
 * 自定义开关（受控组件，v-model 绑定布尔值）。
 * 纯视觉替换：状态语义仍由真实 checkbox 承载（键盘 / 读屏可用），
 * change 事件回写 modelValue；disabled 时整体弱化且不可点。
 */
import { useSlots } from 'vue';

defineProps<{
  modelValue: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
}>();

const hasLabel = !!useSlots().default;

function onChange(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).checked);
}
</script>
