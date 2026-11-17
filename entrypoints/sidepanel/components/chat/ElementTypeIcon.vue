<!--
  元素类型图标（捕获元素 chip / 弹窗共用）

  口径：每种 CapturedElementKind 都有独立图标语义，禁止退化为统一问号图标；
  尺寸 / 颜色由父级 CSS 控制（stroke=currentColor），组件只负责图形本身。
-->
<template>
  <component
    :is="iconComponent"
    :size="size"
    :stroke-width="strokeWidth"
    class="element-type-icon"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { computed, type Component } from 'vue';
import {
  Box,
  CalendarClock,
  CalendarDays,
  ChevronDown,
  CircleDot,
  Clock,
  Code,
  Form,
  Frame,
  Hash,
  Heading1,
  Image,
  Link,
  Link2,
  List,
  Lock,
  Mail,
  MousePointerClick,
  Music,
  Palette,
  PenTool,
  Phone,
  Pilcrow,
  Search,
  SlidersHorizontal,
  SquareCheck,
  SquareDashed,
  Table,
  Tag,
  TextCursor,
  TextCursorInput,
  ToggleLeft,
  Upload,
  Video,
} from 'lucide-vue-next';
import type { CapturedElementKind } from '@/utils/element-capture/types';

const props = withDefaults(
  defineProps<{
    kind: CapturedElementKind;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 14,
    strokeWidth: 1.9,
  },
);

const ICONS: Record<CapturedElementKind, Component> = {
  'text-input': TextCursorInput,
  textarea: TextCursor,
  password: Lock,
  number: Hash,
  email: Mail,
  search: Search,
  tel: Phone,
  url: Link,
  date: CalendarDays,
  time: Clock,
  datetime: CalendarClock,
  color: Palette,
  range: SlidersHorizontal,
  file: Upload,
  checkbox: SquareCheck,
  radio: CircleDot,
  select: ChevronDown,
  button: MousePointerClick,
  link: Link2,
  image: Image,
  video: Video,
  audio: Music,
  table: Table,
  list: List,
  form: Form,
  iframe: Frame,
  canvas: PenTool,
  svg: PenTool,
  code: Code,
  heading: Heading1,
  paragraph: Pilcrow,
  container: Box,
  switch: ToggleLeft,
  label: Tag,
  other: SquareDashed,
};

const iconComponent = computed<Component>(() => ICONS[props.kind] ?? ICONS.other);
</script>

<style scoped>
.element-type-icon {
  flex: 0 0 auto;
  color: inherit;
}
</style>
