<template>
  <div class="app-container" :class="{ 'is-welcome': !showChatMode }" @click="handleContainerClick">
    <!-- WebSocket 状态栏 -->
    <WebSocketStatusBar 
      :status="wsConnectionStatus" 
      :is-dev="isDev"
      @toggle-connection="toggleWebSocketConnection" 
      @toggle-debug="toggleToolPanel" 
    />
    
    <!-- 工作笔记按钮（notes-btn：修正白底白字导致的图标不可见；悬停仅轻微放大） -->
    <button class="settings-btn notes-btn" @click="openNotesPage" style="top: 12px;left: 12px;" v-tip="t('sidepanel.app.notesButton')">
      <svg class="notes-btn-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M6,3H18A2,2 0 0,1 20,5V19A2,2 0 0,1 18,21H6A2,2 0 0,1 4,19V5A2,2 0 0,1 6,3Z"/>
        <path d="M9,8H15"/>
        <path d="M9,12H15"/>
        <path d="M9,16H13"/>
      </svg>
    </button>
    <!-- 用户设置按钮 -->
    <button class="settings-btn" @click="openSettings" :class="{ active: showSettingsModal }" style="display: none;">
      <svg t="1753162055562" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="2508" width="16" height="16"><path d="M449.194667 82.346667a128 128 0 0 1 125.610666 0l284.16 160a128 128 0 0 1 65.194667 111.530666v316.245334a128 128 0 0 1-65.194667 111.530666l-284.16 160a128 128 0 0 1-125.610666 0l-284.16-160a128 128 0 0 1-65.194667-111.530666V353.877333A128 128 0 0 1 165.034667 242.346667z m83.754666 74.410666a42.666667 42.666667 0 0 0-41.898666 0L206.933333 316.714667a42.666667 42.666667 0 0 0-21.76 37.162666v316.245334a42.666667 42.666667 0 0 0 21.76 37.162666l284.16 160a42.666667 42.666667 0 0 0 41.898667 0l284.16-160a42.666667 42.666667 0 0 0 21.76-37.162666V353.877333a42.666667 42.666667 0 0 0-21.76-37.162666zM512 341.333333a170.666667 170.666667 0 1 1 0 341.333334 170.666667 170.666667 0 0 1 0-341.333334z m0 85.333334a85.333333 85.333333 0 1 0 0 170.666666 85.333333 85.333333 0 0 0 0-170.666666z" fill="#000000" p-id="2509"></path>
      </svg>
    </button>
    <!-- 主内容区域 -->
    <div class="main-content" v-show="!showChatMode">
      <!-- 居中容器 -->
      <div class="center-container">
        <section class="greeting-container" aria-labelledby="greeting-title">
          <div class="greeting-brand" aria-hidden="true">
            <img class="greeting-logo" :src="greetingLogoUrl" alt="" width="26" height="26" />
            <span class="greeting-brand-name">AgentNexus</span>
          </div>
          <h1 id="greeting-title" class="greeting-title">{{ greetingText }}</h1>
          <p class="greeting-subtitle">{{ t('sidepanel.app.greetingSubtitle') }}</p>
        </section>
      </div>
    </div>

    <!-- 聊天模式 -->
    <ChatMessageList
      :key="activeChatId"
      :chat-id="activeChatId"
      :messages="messages"
      :show-chat-mode="showChatMode"
      :is-ai-responding="isAiResponding"
      :live-message-id="liveAssistantMessageId"
      @toggle-tool-call-expansion="toggleToolCallExpansion"
      @toggle-reasoning-collapse="toggleReasoningCollapse"
      @toggle-reasoning-content-collapse="toggleReasoningContentCollapse"
      @toggle-compaction-collapse="toggleCompactionCollapse"
      @feedback-change="handleFeedbackChange"
      @create-skill="createSkillFromPractice"
      @guard-continue="handleGuardContinue"
      @guard-open-settings="handleGuardOpenSettings"
    />

    <!-- 底部输入区域 -->
    <div class="bottom-section">
      <div class="bottom-toolbar">
        <!-- 网站学习入口（工具栏最左侧，恒定贴左；图标 + 「学习」文字同体为一个按钮）。
             学习流程进行中禁用——状态条上已有终止入口，避免两个入口并存引发歧义 -->
        <button
          class="learn-entry-btn"
          type="button"
          :disabled="learn.isLearnActive.value"
          :title="t('sidepanel.learn.entryTip')"
          :aria-label="t('sidepanel.learn.entryTip')"
          @click="learn.openModal()"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path
              d="M12 1.5L14.35 9.65L22.5 12L14.35 14.35L12 22.5L9.65 14.35L1.5 12L9.65 9.65L12 1.5Z"
              fill="currentColor"
            />
          </svg>
          <span class="learn-entry-btn__label">{{ t('sidepanel.learn.entryLabel') }}</span>
        </button>

        <!-- 左侧模式切换按钮 -->
        <div class="mode-selector-wrapper">
          <button class="mode-toggle-btn" @click.stop="toggleModeSelector" :title="t('sidepanel.app.switchMode')" style = "display:none" >
            <svg t="1756793254500" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="7644" width="16" height="16">
              <path d="M320 885.12h-106.666667c-47.146667 0-85.333333-38.186667-85.333333-85.333333v-341.333334c0-47.146667 38.186667-85.333333 85.333333-85.333333h106.666667c47.146667 0 85.333333 38.186667 85.333333 85.333333v341.333334c0 47.146667-38.186667 85.333333-85.333333 85.333333z" fill="#93A8FF" p-id="7645"></path><path d="M810.666667 885.12H554.666667c-47.146667 0-85.333333-38.186667-85.333334-85.333333v-341.333334c0-47.146667 38.186667-85.333333 85.333334-85.333333h256c47.146667 0 85.333333 38.186667 85.333333 85.333333v341.333334c0 47.146667-38.186667 85.333333-85.333333 85.333333z" fill="#2953FF" p-id="7646"></path><path d="M810.666667 309.546667H213.333333c-47.146667 0-85.333333-38.186667-85.333333-85.333334s38.186667-85.333333 85.333333-85.333333h597.333334c47.146667 0 85.333333 38.186667 85.333333 85.333333s-38.186667 85.333333-85.333333 85.333334z" fill="#FCCA1E" p-id="7647"></path>
            </svg>
            <span class="mode-text">{{ currentModeLabel }}</span>
            <svg class="dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M7,10L12,15L17,10H7Z" fill="currentColor"/>
            </svg>
          </button>

          <Transition name="dropdown">
            <div class="mode-dropdown mode-dropdown-up" v-show="showModeSelector" @click.stop>
              <div class="mode-option" @click="selectMode('fast')" :class="{ active: currentMode === 'fast' }">
                <svg t="1756793349853" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="8677" width="16" height="16"><path d="M400.495534 161.33256l303.660364 16.005568-82.106484 209.230484 160.530797 51.639485L339.739705 960.096509l22.300894-497.657349 38.454935-301.1066z" fill="#56E5BE" p-id="8678"></path><path d="M439.247419 247.833894l277.202181 11.848277-78.840042 215.674284 160.530797 51.639485L381.965897 968.886208l18.826586-419.945714 38.454936-301.1066z" fill="#50DDB8" p-id="8679"></path><path d="M727.763369 515.177358l64.734949 33.881916L441.623014 916.415265l13.451803-299.651548 38.425241-301.106601 153.225844 8.047327-46.799211 149.632757 127.836678 41.840158z" fill="#42D3AD" p-id="8680"></path><path d="M338.106484 1024a54.638673 54.638673 0 0 1-25.65642-6.473495 53.985385 53.985385 0 0 1-27.735066-59.033523l73.316785-355.121679-126.975525-18.885976A54.401114 54.401114 0 0 1 185.474539 521.264818L269.00638 44.98782A54.549588 54.549588 0 0 1 324.83285 0.17817l462.201601 17.816958a54.430808 54.430808 0 0 1 45.581719 80.473263l-197.382206 360.823107 140.961837 12.056141a54.401114 54.401114 0 0 1 34.26795 92.232456l-433.545992 443.939218a54.133859 54.133859 0 0 1-38.811275 16.480687z m5.137223-53.450876z m-97.993272-444.384642l127.094305 18.915671a54.430808 54.430808 0 0 1 45.255074 64.824034L346.955574 952.613386l412.75954-422.677648-137.873564-11.877972a54.401114 54.401114 0 0 1-43.087345-80.176314l197.441596-360.496462-448.987357-17.460619z" fill="#2E3138" p-id="8681"></path>
                </svg>
                <span>{{ t('sidepanel.app.modeFast') }}</span>
              </div>
              <div class="mode-option" @click="selectMode('reasoning')" :class="{ active: currentMode === 'reasoning' }">
                <svg t="1756793418211" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="11417" width="16" height="16"><path d="M528 320a375.68 375.68 0 0 1 152.32-128 26.88 26.88 0 0 1 15.36 0c3.2 0 12.8 16.64 10.24 60.16a48 48 0 1 0 96 5.76c5.76-92.16-28.16-131.84-57.6-149.12a115.2 115.2 0 0 0-88.96-8.32c-74.24 19.84-167.04 104.32-250.88 223.36-24.32 0-48.64 5.12-72.32 8.96C311.04 256 314.24 200.96 328.32 192c0 0 19.84 0 55.04 20.48a48 48 0 1 0 52.48-80.64 143.36 143.36 0 0 0-155.52-23.04c-64 38.4-71.04 133.12-42.88 243.84C128 384 48 435.84 48 512c0 32.64 16 80 91.52 120.32a51.2 51.2 0 0 0 23.04 5.76 48 48 0 0 0 42.24-24.96 48.64 48.64 0 0 0-19.84-64c-30.72-16.64-40.96-31.36-40.96-35.84 0-16 43.52-44.8 123.52-64 8.32 21.76 17.92 44.16 28.16 64-78.72 170.24-111.36 346.88-15.36 402.56a99.84 99.84 0 0 0 51.84 13.44 192 192 0 0 0 104.32-37.12 48 48 0 1 0-52.48-81.28c-35.84 23.04-53.12 21.76-55.68 20.48-17.92-10.24-19.2-88.96 25.6-209.92 94.72 160 211.84 277.76 301.44 301.44a128 128 0 0 0 35.84 5.12 112.64 112.64 0 0 0 53.12-13.44c32-18.56 67.84-64 55.68-168.96a803.2 803.2 0 0 0-76.16-242.56 48 48 0 0 0-83.84 41.6 696.32 696.32 0 0 1 64 211.2c6.4 55.04-5.12 73.6-8.32 75.52a29.44 29.44 0 0 1-16 0c-56.32-14.72-160.64-112.64-251.52-270.08-9.6-16.64-17.28-32-25.6-48 8.32-16 16-31.36 25.6-48l28.16-46.08h55.04c239.36 0 368 67.84 368 95.36a68.48 68.48 0 0 1-35.2 33.92 48 48 0 0 0 35.84 88.96A149.76 149.76 0 0 0 976 512c0-128-229.12-188.8-448-192z" fill="#1296db" p-id="11418"></path>
                </svg>
                <span>{{ t('sidepanel.app.modeReasoning') }}</span>
              </div>
              <div class="mode-option" @click="selectMode('action')" :class="{ active: currentMode === 'action' }">
                <svg t="1756793536879" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="15305" width="16" height="16"><path d="M491.62 969.18a36.19 36.19 0 0 1-15.35-3.41c-120.11-56.37-212.69-119.1-275.19-186.46-52.62-56.71-81.6-115.63-81.6-165.9 0-56.01-7.38-351.97-8.22-385.54-0.49-19.5 12.17-37.21 30.78-43.07L478.38 78.98h0.01a43.847 43.847 0 0 1 26.39 0L841.14 184.8c18.62 5.86 31.27 23.57 30.78 43.07-0.84 33.57-8.22 329.66-8.22 385.53 0 50.27-28.98 109.19-81.6 165.9-62.5 67.36-155.09 130.09-275.19 186.46a35.967 35.967 0 0 1-15.29 3.42zM183.75 247.16c2.09 84.07 7.72 315.8 7.72 366.25 0 50.62 63.69 165.45 300.11 279.9C728.01 778.85 791.7 664.02 791.7 613.41c0-50.33 5.63-282.16 7.72-366.25l-307.83-96.85-307.84 96.85z" fill="#31D0C8" p-id="15306"></path><path d="M457.57 639.91c-11.27 0-22.53-4.29-31.11-12.87l-91.75-91.75c-14.06-14.06-14.06-36.85 0-50.91s36.85-14.06 50.91 0l71.95 71.95 139.97-139.97c14.06-14.06 36.85-14.06 50.91 0s14.06 36.85 0 50.91L488.69 627.04c-8.58 8.58-19.85 12.87-31.12 12.87z" fill="#31D0C8" p-id="15307"></path>
                </svg>
                <span>{{ t('sidepanel.app.modeAction') }}</span>
              </div>
            </div>
          </Transition>
        </div>

        <!-- 已选智能体/技能胶囊条（设置与历史会话按钮之间；超出可横向滚动：
             小滚动条 + 边缘渐隐作提示，「+N」悬浮/点击展开管理弹层） -->
        <div
          v-if="selectionStripChips.length"
          class="selection-strip"
          @mouseleave="selectionStripHovered = false"
        >
          <!-- 滚动包装层：承载不随内容滚动的边缘渐隐覆盖 -->
          <div class="selection-strip-scrollwrap">
            <div
              class="selection-strip-viewport"
              ref="selectionStripViewport"
              @scroll="onSelectionStripScroll"
            >
              <span
                v-for="chip in selectionStripChips"
                :key="chip.key"
                class="strip-chip"
                :class="chip.kind === 'agent' ? 'strip-chip-agent' : 'strip-chip-skill'"
                data-strip-chip
              >
                <!-- 智能体胶囊展示自身头像（图片或 emoji，无背景色）；技能胶囊沿用固定闪电图标 -->
                <AgentAvatar
                  v-if="chip.kind === 'agent'"
                  class="strip-chip-avatar"
                  :avatar="chip.avatar"
                  :size="12"
                />
                <svg
                  v-else
                  class="strip-chip-icon"
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path :d="SELECTION_STRIP_SKILL_ICON_PATH" fill="currentColor" />
                </svg>
                <span class="strip-chip-name">{{ chip.label }}</span>
                <button
                  class="strip-chip-remove"
                  :title="chip.kind === 'agent' ? t('sidepanel.app.removeAgent') : t('sidepanel.app.removeSkill')"
                  @click.stop="removeSelectionStripChip(chip)"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                  </svg>
                </button>
              </span>
            </div>
            <!-- 边缘渐隐：提示对应方向还有未滚入的胶囊 -->
            <div v-if="selectionStripCanScrollLeft" class="selection-strip-fade selection-strip-fade-left"></div>
            <div v-if="selectionStripCanScrollRight" class="selection-strip-fade selection-strip-fade-right"></div>
          </div>

          <button
            v-if="selectionStripOverflowCount > 0"
            class="strip-more"
            :title="t('sidepanel.app.selectionManageTitle')"
            @mouseenter="selectionStripHovered = true"
            @click.stop="toggleSelectionStripPin"
          >
            +{{ selectionStripOverflowCount }}
          </button>

          <!-- 展开管理弹层：全量条目逐个移除 + 一键清空 -->
          <Transition name="dropdown">
            <div
              v-if="showSelectionStripPopover"
              class="selection-strip-popover"
              @click.stop
              @mouseenter="selectionStripHovered = true"
            >
              <div class="strip-popover-header">
                <span>{{ t('sidepanel.app.selectionManageTitle') }}</span>
                <button class="strip-clear-all" @click="clearAllSelections">
                  {{ t('sidepanel.app.selectionClearAll') }}
                </button>
              </div>
              <div class="strip-popover-body">
                <span
                  v-for="chip in selectionStripChips"
                  :key="chip.key"
                  class="strip-chip strip-popover-chip"
                  :class="chip.kind === 'agent' ? 'strip-chip-agent' : 'strip-chip-skill'"
                >
                  <!-- 智能体胶囊展示自身头像（图片或 emoji，无背景色）；技能胶囊沿用固定闪电图标 -->
                  <AgentAvatar
                    v-if="chip.kind === 'agent'"
                    class="strip-chip-avatar"
                    :avatar="chip.avatar"
                    :size="12"
                  />
                  <svg
                    v-else
                    class="strip-chip-icon"
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path :d="SELECTION_STRIP_SKILL_ICON_PATH" fill="currentColor" />
                  </svg>
                  <span class="strip-chip-name">{{ chip.label }}</span>
                  <button
                    class="strip-chip-remove"
                    :title="chip.kind === 'agent' ? t('sidepanel.app.removeAgent') : t('sidepanel.app.removeSkill')"
                    @click.stop="removeSelectionStripChip(chip)"
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                    </svg>
                  </button>
                </span>
              </div>
            </div>
          </Transition>
        </div>
    
        
        
        <!-- 右侧按钮组 -->
        <div class="right-actions">
          <!-- <button class="icon-btn" title="截屏" @click="handleScreenCapture" :class="{ 'capturing': isCapturingScreen }">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4,4H7L9,2H15L17,4H20A2,2 0 0,1 22,6V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V6A2,2 0 0,1 4,4M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9Z" fill="currentColor"/>
            </svg>
          </button> -->
          <!-- <button class="icon-btn"  title="语音助手模式" @click="toggleVoiceAssistantMode">
            <svg t="1756793054159" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="4386" width="18" height="18">
              <path d="M512.228571 511.2m-107.428571 0a107.428571 107.428571 0 1 0 214.857143 0 107.428571 107.428571 0 1 0-214.857143 0Z" p-id="4387"></path><path d="M357.371429 688.914286c-5.828571 0-11.657143-2.285714-16.114286-6.742857-45.714286-45.714286-70.857143-106.4-70.857143-170.971429s25.142857-125.371429 70.857143-170.971429c8.914286-8.914286 23.428571-8.914286 32.342857 0s8.914286 23.428571 0 32.342858c-37.028571 37.028571-57.485714 86.285714-57.485714 138.742857s20.457143 101.6 57.485714 138.742857c8.914286 8.914286 8.914286 23.428571 0 32.342857-4.457143 4.342857-10.4 6.514286-16.228571 6.514286zM667.2 688.914286c-5.828571 0-11.657143-2.285714-16.114286-6.742857-8.914286-8.914286-8.914286-23.428571 0-32.342858 37.028571-37.028571 57.371429-86.285714 57.371429-138.628571 0-52.571429-20.457143-101.942857-57.714286-138.971429-8.914286-8.914286-9.028571-23.428571-0.114286-32.342857 8.914286-8.914286 23.428571-9.028571 32.342858-0.114285 45.942857 45.714286 71.2 106.628571 71.2 171.314285 0 64.571429-25.142857 125.257143-70.742858 170.971429-4.571429 4.571429-10.4 6.857143-16.228571 6.857143zM166.971429 879.428571c-5.828571 0-11.657143-2.285714-16.114286-6.742857-46.971429-46.971429-83.771429-101.6-109.6-162.514285C14.514286 647.2 1.028571 580.228571 1.028571 511.2c0-69.028571 13.485714-136 40.228572-198.971429C66.971429 251.314286 103.885714 196.685714 150.857143 149.714286c8.914286-8.914286 23.428571-8.914286 32.342857 0s8.914286 23.428571 0 32.342857c-42.742857 42.742857-76.342857 92.571429-99.771429 148C59.2 387.428571 46.857143 448.342857 46.857143 511.2s12.342857 123.771429 36.571428 181.142857c23.428571 55.428571 57.028571 105.257143 99.771429 148 8.914286 8.914286 8.914286 23.428571 0 32.342857-4.571429 4.457143-10.4 6.742857-16.228571 6.742857zM857.6 879.314286c-5.828571 0-11.657143-2.285714-16.114286-6.742857-8.914286-8.914286-8.914286-23.428571 0-32.342858 42.742857-42.742857 76.342857-92.571429 99.771429-148 24.228571-57.371429 36.571429-118.285714 36.571428-181.142857 0-62.971429-12.342857-124-36.685714-181.371428-23.542857-55.428571-57.142857-105.257143-100-148.114286-8.914286-8.914286-8.914286-23.428571 0-32.342857 8.914286-8.914286 23.428571-8.914286 32.342857 0 47.085714 46.971429 84 101.714286 109.828572 162.628571 26.742857 63.085714 40.228571 130.171429 40.228571 199.2 0 69.028571-13.485714 135.885714-40.114286 198.971429-25.714286 60.914286-62.628571 115.542857-109.485714 162.514286-4.571429 4.571429-10.4 6.742857-16.342857 6.742857z" p-id="4388"></path><path d="M263.771429 782.628571c-5.828571 0-11.657143-2.285714-16.114286-6.742857-70.742857-70.742857-109.6-164.685714-109.6-264.685714s38.971429-193.942857 109.6-264.685714c8.914286-8.914286 23.428571-8.914286 32.342857 0s8.914286 23.428571 0 32.342857c-62.057143 62.057143-96.228571 144.571429-96.228571 232.342857 0 87.771429 34.171429 170.285714 96.228571 232.342857 8.914286 8.914286 8.914286 23.428571 0 32.342857-4.571429 4.457143-10.4 6.742857-16.228571 6.742857zM760.8 782.628571c-5.828571 0-11.657143-2.285714-16.114286-6.742857-8.914286-8.914286-8.914286-23.428571 0-32.342857 62.057143-62.057143 96.228571-144.571429 96.228572-232.342857 0-87.885714-34.285714-170.514286-96.571429-232.685714-8.914286-8.914286-8.914286-23.428571 0-32.342857 8.914286-8.914286 23.428571-8.914286 32.342857 0 34.514286 34.4 61.6 74.4 80.457143 119.085714 19.542857 46.285714 29.485714 95.314286 29.485714 145.942857 0 100-38.971429 193.942857-109.6 264.685714-4.571429 4.457143-10.4 6.742857-16.228571 6.742857z" p-id="4389"></path>
            </svg>
          </button> -->
          
          <!-- <button class="icon-btn" title="工作流" @click="toggleWorkflowCard" >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M3,3H11V11H3V3M13,3H21V11H13V3M3,13H11V21H3V13M13,13H21V21H13V13M5,5V9H9V5H5M15,5V9H19V5H15M5,15V19H9V15H5M15,15V19H19V15H15Z" fill="currentColor"/>
            </svg>
          </button> -->
          <!-- 设置按钮（历史会话按钮左侧；打开设置弹窗：模型服务/高级参数/语音/已登录网站等分区） -->
          <button class="api-settings-btn" @click="showSettingsModal = true" v-tip="t('common.settings')">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
          <button class="icon-btn" v-tip="t('sidepanel.app.historyDrawer')" @click="showHistoryDrawer = true">
            <svg t="1753196772574" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path d="M512 128c212.064 0 384 153.6 384 341.312 0 187.712-171.936 341.312-384 341.312-38.944 0-77.056-5.28-113.376-15.552l-107.2 60.96a32 32 0 0 1-47.936-31.616l11.776-96.768C173.28 683.632 128 579.808 128 469.312 128 281.6 299.936 128 512 128z m0 64c-176.448 0-320 124.288-320 277.312 0 92.896 40.704 177.76 111.904 234.4a32 32 0 0 1 11.84 26.944l-7.52 61.792 68.736-39.12a32 32 0 0 1 25.216-2.816c35.232 10.816 72.32 16.128 109.824 16.128 176.448 0 320-124.224 320-277.312S688.448 192 512 192zM352 432a48 48 0 1 1 0 96 48 48 0 0 1 0-96z m160 0a48 48 0 1 1 0 96 48 48 0 0 1 0-96z m160 0a48 48 0 1 1 0 96 48 48 0 0 1 0-96z" fill="currentColor"/></svg>
          </button>
          <button class="icon-btn" v-tip="t('sidepanel.app.newChat')" @click="goHome()">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12z"/>
              <line x1="12" y1="7" x2="12" y2="13"/>
              <line x1="9" y1="10" x2="15" y2="10"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- 循环守卫确认条（达到轮数/时长上限时出现；非阻塞，超时未确认自动停止） -->
      <GuardConfirmBar
        :visible="pendingGuard !== null"
        :kind="pendingGuard?.kind ?? 'max-iterations'"
        :count="pendingGuard?.count"
        :minutes="pendingGuard?.minutes"
        :seconds-left="guardSecondsLeft"
        :total-seconds="GUARD_AUTO_STOP_SECONDS"
        @continue="settleGuard(true)"
        @stop="settleGuard(false)"
      />

      <div class="input-section">
        <!-- 网页引用条：待引用（等用户确认）/ 已引用（随本轮消息发送）。
             两态互斥：确认后原文固定、不进输入框；此时页面上再选别的内容不再响应，
             须先「取消引用」。发送时双路落地：模型面以 <page_quote> 信封拼进本轮
             用户消息，用户面随记录落库（气泡据此渲染引用块，历史可追溯）。 -->
        <PageQuoteBar
          v-if="pendingQuote"
          state="pending"
          :text="pendingQuote.text"
          :source-title="pendingQuote.source.title"
          :source-url="pendingQuote.source.url"
          @confirm="confirmPageQuote"
          @discard="discardPendingQuote"
        />
        <PageQuoteBar
          v-else-if="confirmedQuote"
          state="confirmed"
          :text="confirmedQuote.text"
          :source-title="confirmedQuote.source.title"
          :source-url="confirmedQuote.source.url"
          @cancel="cancelConfirmedQuote"
        />

        <!-- 截图预览 -->
        <div v-if="showCapturedImage && capturedImage" class="captured-image-display">
          <div class="captured-image-content">
            <div class="captured-image-header">
              <div class="captured-image-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4,4H7L9,2H15L17,4H20A2,2 0 0,1 22,6V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V6A2,2 0 0,1 4,4M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9Z" fill="currentColor"/>
                </svg>
              </div>
              <span class="captured-image-label">{{ t('sidepanel.app.screenshotPreview') }}</span>
              <button class="close-captured-image" @click="clearCapturedImage" :title="t('sidepanel.app.clearScreenshot')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
            <div class="captured-image-preview">
              <img :src="capturedImage" :alt="t('sidepanel.app.screenshotPreview')" class="preview-image" />
            </div>
          </div>
        </div>

        <!-- 待发送附件栏：文本/Office 解析产物与图片混排；移除即时释放预算 -->
        <div v-if="pendingAttachments.length" class="attachment-bar">
          <TransitionGroup name="attachment-chip">
            <div
              v-for="att in pendingAttachments"
              :key="att.id"
              class="attachment-chip"
              :title="attachmentChipTitle(att)"
            >
              <span class="attachment-chip-icon" :class="`source-${att.source}`" aria-hidden="true">
                <svg v-if="att.source === 'image'" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M8.5,13.5L11,16.5L14.5,12L19,18H5M21,19V5C21,3.89 20.1,3 19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19Z" fill="currentColor"/>
                </svg>
                <svg v-else-if="att.source === 'office'" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19,4H18V2H16V4H8V2H6V4H5A2,2 0 0,0 3,6V20A2,2 0 0,0 5,22H19A2,2 0 0,0 21,20V6A2,2 0 0,0 19,4M19,20H5V10H19V20M19,8H5V6H19V8M9,13V15H7V17H9V19H11V17H13V15H11V13H9M15,13V19H17V13H15Z" fill="currentColor"/>
                </svg>
                <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" fill="currentColor"/>
                </svg>
              </span>
              <span class="attachment-chip-name">{{ att.name }}</span>
              <span class="attachment-chip-meta">{{ attachmentChipMeta(att) }}</span>
              <button
                class="attachment-chip-remove"
                :title="t('sidepanel.attachments.remove')"
                @click="attachmentManager.removeAttachment(att.id)"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </TransitionGroup>
        </div>
        
        <!-- 会话计划面板（plan_tool 产物实时刷新；输入容器上方常驻，
             折叠/展开由用户控制，切换历史会话自动回显对应计划） -->
        <PlanBoard v-if="activeChatId" :chat-id="activeChatId" />

        <!-- 学习运行中：输入区整体替换为状态条（普通输入在此期间一律不可用） -->
        <LearnStatusBar
          v-if="learn.isLearnRunning.value"
          :phase="learn.phase.value === 'validating' ? 'validating' : 'learning'"
          :elapsed-ms="learn.elapsedMs.value"
          :tool-calls="learn.toolCalls.value"
          :force-submitting="learn.isForceSubmitting.value"
          :context-usage="learn.contextUsage.value"
          :compacting="isCompacting"
          @stop="learn.requestAbort()"
        />

        <div
          v-else
          class="input-container"
          :class="{ 'drag-over': isFileDragging }"
          @dragenter.prevent="onFileDragEnter"
          @dragover.prevent="onFileDragOver"
          @dragleave="onFileDragLeave"
          @drop.prevent="onFileDrop"
        >
          <!-- 拖拽放置提示（绝对定位覆盖层，不挤占布局；松开即走附件守卫链） -->
          <div v-if="isFileDragging" class="file-drop-hint">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z" fill="currentColor"/>
            </svg>
            <span>{{ t('sidepanel.attachments.dropHint') }}</span>
          </div>
          <!-- 输入框：已配置且非学习态。
               注意：下面三条提示各自独立判定（互不构成 v-if/v-else 链）——
               「未配置」提示必须带上 !isChatInputEnabled，若写成 v-else
               会被绑到上一条 v-if 链上（学习提示），条件里就没有
               isChatInputEnabled 了，结果是「已配置也照样显示未配置」。 -->
          <textarea
            v-if="isChatInputEnabled && !learn.isLearnActive.value"
            v-model="userInput"
            :placeholder="t('sidepanel.app.inputPlaceholder')"
            class="message-input"
            @keydown="handleKeyDown"
            @input="handleInputChange"
            rows="3"
            ref="messageTextarea"
          ></textarea>

          <!-- 学习配置/确认阶段：输入区让位（面板与弹窗承载全部交互） -->
          <div v-if="learn.isLearnActive.value" class="input-disabled-notice learn-input-notice">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right: 8px;" aria-hidden="true">
              <path d="M12 1.5L14.35 9.65L22.5 12L14.35 14.35L12 22.5L9.65 14.35L1.5 12L9.65 9.65L12 1.5Z" fill="currentColor"/>
            </svg>
            <span>{{ t('sidepanel.learn.statusHint') }}</span>
          </div>

          <!-- 站点学习会话：成果兜底（草稿随消息回放）。
               降级说明之外的第二重保障——暂存失败或未在管理中心确认时，
               打开该会话即可把草稿重新送去创建，成果不再随暂存时效消失。
               与输入框并存：草稿待处理不该剥夺用户继续对话的能力。 -->
          <div
            v-if="!learn.isLearnActive.value && learnRecoveryState.visible.value"
            class="learn-recover-notice"
          >
            <div class="learn-recover-summary">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
                <path d="M14 3v6h6M8 13h8M8 17h5"/>
              </svg>
              <span>{{ t('sidepanel.learn.recoverHint') }}</span>
            </div>
            <p v-if="learnRecoveryState.syncError.value" class="learn-recover-sync-error" role="status">{{ t('sidepanel.learn.recoverySyncFailed') }}</p>
            <div class="learn-recover-actions">
              <button type="button" class="learn-recover-btn learn-recover-btn--primary" :disabled="retryingLearnDraft || learnRecoveryState.busy.value" @click="retryCreateSkillFromLearn">
                {{ t('sidepanel.learn.recoverAction') }}
              </button>
              <button type="button" class="learn-recover-btn" @click="downloadLearnRecovery">{{ t('sidepanel.learn.downloadRecovery') }}</button>
              <button type="button" class="learn-recover-btn learn-recover-btn--ignore" :disabled="retryingLearnDraft || learnRecoveryState.busy.value" @click="learnRecoveryState.requestDismiss">{{ t('sidepanel.learn.ignoreAction') }}</button>
            </div>
          </div>

          <!-- 未配置提示（可点击打开配置弹窗）。
               条件独立判定，与「已配置」的输入框严格互斥。
               附具体原因：用户不必自己猜是缺密钥、地址写错还是模型被禁。 -->
          <div
            v-if="!isChatInputEnabled && !learn.isLearnActive.value"
            class="input-disabled-notice"
            @click="showSettingsModal = true"
            style="cursor: pointer;"
            :title="t('sidepanel.app.configureApiHint')"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right: 8px;">
              <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="#ff9800"/>
            </svg>
            <span>
              {{ t('sidepanel.app.apiNotConfiguredPrefix') }}<span style="color: #3b82f6; text-decoration: underline;">{{ t('sidepanel.app.apiNotConfiguredLink') }}</span>{{ t('sidepanel.app.apiNotConfiguredSuffix') }}
              <span v-if="apiBlockerHint" class="input-disabled-reason">（{{ apiBlockerHint }}）</span>
            </span>
          </div>

          <!-- 学习态下隐藏整个工具栏：发送/模型选择/附件在学习流程期间一律不可达，
               入口按钮也随之让位（配置面板与状态条承载全部交互） -->
          <div class="bottom-bar" v-if="!learn.isLearnActive.value">
            <div class="left-actions">
              <!-- 会话内模型选择器（替换原推理切换按钮）：从已配置的模型列表中切换当前生效模型 -->
              <div class="model-select-wrap">
                <button
                  class="model-select-btn"
                  :class="{ 'no-model': !activeChatModel, 'is-open': showModelSelectorMenu }"
                  :title="activeChatModel ? t('sidepanel.app.switchModel') : t('sidepanel.app.noModelsHint')"
                  @click.stop="toggleModelSelectorMenu"
                >
                  <img class="model-select-logo" :src="currentModelIcon" alt="" />
                  <span class="model-select-name">{{ activeChatModel || t('sidepanel.app.noModelConfigured') }}</span>
                  <svg class="dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M7,10L12,15L17,10H7Z" fill="currentColor"/>
                  </svg>
                </button>

                <!-- 上下文用量圆环已移至输入栏右侧（附件按钮左侧），此处仅保留模型下拉 -->
                <Transition name="dropdown">
                  <div class="model-select-dropdown" v-show="showModelSelectorMenu" @click.stop>
                    <div
                      v-for="option in modelOptions"
                      :key="option.key"
                      class="model-select-option"
                      :class="{ active: option.key === activeModelKey }"
                      :title="option.key === activeModelKey ? t('sidepanel.apiConfig.currentModel') : t('sidepanel.apiConfig.clickToActivate')"
                      @click="selectChatModel(option)"
                    >
                      <img class="model-select-option-logo" :src="getModelIconUrl(option.wireName)" alt="" />
                      <span class="model-select-option-name">{{ option.label }}</span>
                      <!-- 所属渠道标注：跨渠道同名模型据此区分 -->
                      <span class="model-select-option-channel">{{ option.channelName }}</span>
                      <span v-if="option.vision" class="model-select-vision-tag" :title="t('sidepanel.app.visionModelTag')">
                        {{ t('sidepanel.app.visionTagLabel') }}
                      </span>
                      <svg v-if="option.key === activeModelKey" class="model-select-check" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M9 16.17L4.83 12L3.41 13.41L9 19L21 7L19.59 5.59L9 16.17Z" fill="currentColor"/>
                      </svg>
                    </div>
                    <div
                      v-if="!modelOptions.length"
                      class="model-select-empty"
                      @click="showModelSelectorMenu = false; showSettingsModal = true;"
                    >
                      {{ t('sidepanel.app.noModelsHint') }}
                    </div>
                  </div>
                </Transition>
              </div>
            </div>

            <div class="right-actions">
              <!-- 上下文用量圆环（附件按钮左侧；悬浮展示全量成分明细） -->
              <ContextUsageRing :usage="contextUsage" :compacting="isCompacting" />
              <button class="input-action-btn" :disabled="!isChatInputEnabled" v-tip="t('sidepanel.app.attachmentWorkspaceHint')" @click="handleFileUpload">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M16.5,6V17.5A4,4 0 0,1 12.5,21.5A4,4 0 0,1 8.5,17.5V5A2.5,2.5 0 0,1 11,2.5A2.5,2.5 0 0,1 13.5,5V15.5A1,1 0 0,1 12.5,16.5A1,1 0 0,1 11.5,15.5V6H10V15.5A2.5,2.5 0 0,0 12.5,18A2.5,2.5 0 0,0 15,15.5V5A4,4 0 0,0 11,1A4,4 0 0,0 7,5V17.5A5.5,5.5 0 0,0 12.5,23A5.5,5.5 0 0,0 18,17.5V6H16.5Z" fill="currentColor"/>
                </svg>
              </button>
              <button class="input-action-btn" v-tip="t('sidepanel.app.voice')" @click="handleVoiceRecord">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
                </svg>
              </button>
              <button class="send-button" v-tip="isAiResponding ? t('sidepanel.chat.stopResponding') : t('sidepanel.chat.sendMessage')" @click="isAiResponding ? confirmStopResponse() : sendMessage()" :disabled="!isAiResponding && !userInput.trim() && !pendingAttachments.length && !confirmedQuote" :class="{ 'stop-button': isAiResponding }">
                <svg v-if="!isAiResponding" class="send-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M2,21L23,12L2,3V10L17,12L2,14V21Z" fill="currentColor"/>
                </svg>
                <svg v-else class="stop-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M6,6H18V18H6V6Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        
        <!-- 智能体选择卡片（@ 触发；按分类分组；搜索在卡片内搜索框完成，输入框继续打字即收起） -->
        <div v-if="showAgentSelector" class="agent-selector" @keydown="handleAgentSelectorKeyDown">
          <div class="selector-search">
            <svg class="selector-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
            </svg>
            <input
              v-model="agentSelectorQuery"
              type="text"
              class="selector-search-input"
              :placeholder="t('sidepanel.app.agentSearchPlaceholder')"
              autocomplete="off"
            />
          </div>
          <template v-for="(item, index) in agentSelectorItems" :key="item.key">
            <div v-if="item.type === 'header'" class="agent-group-header">{{ item.label }}</div>
            <div
              v-else
              :class="['agent-option', { 'selected': selectedAgentIndex === index }]"
              @click="selectAgentAtIndex(index)"
              @mouseenter="selectedAgentIndex = index"
            >
              <!-- 智能体头像：图片或 emoji，无背景色 -->
              <AgentAvatar
                class="agent-icon"
                :avatar="item.agent.avatar"
                :size="22"
                :label="item.display.name"
              />
              <div class="agent-info">
                <div class="agent-name">{{ item.display.name }}</div>
                <div class="agent-desc">{{ item.display.description }}</div>
                <div v-if="item.display.tags.length" class="agent-tags">
                  <span v-for="tag in item.display.tags" :key="tag" class="agent-tag">{{ tag }}</span>
                </div>
              </div>
            </div>
          </template>
          <div v-if="!agentSelectorItems.length" class="skill-empty">
            <span class="skill-empty-text">{{ t('sidepanel.app.noAgentsHint') }}</span>
            <button
              type="button"
              class="selector-dismiss-btn"
              v-tip="t('common.close')"
              @click="dismissAgentSelector"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
              </svg>
            </button>
          </div>
        </div>

        <!-- 技能选择卡片（/ 触发，多选；可选范围 = 当前智能体在 hub 编辑页显式
             关联的启用技能。未选智能体 → 引导先选智能体；已选 → 卡片内搜索 +
             列表 + 底部关联范围提示（未显示的技能需先在 hub 关联）；
             输入框继续打字即收起） -->
        <div v-if="showSkillSelector" class="agent-selector skill-selector" @keydown="handleSkillSelectorKeyDown">
          <!-- 未选智能体：引导态（无搜索框——此刻没有可搜的集合，搜索框只会误导） -->
          <div v-if="!selectedAgent" class="skill-empty">
            <span class="skill-empty-text">{{ t('sidepanel.app.skillNeedAgentHint') }}</span>
            <button
              type="button"
              class="selector-dismiss-btn"
              v-tip="t('common.close')"
              @click="dismissSkillSelector"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
              </svg>
            </button>
          </div>
          <template v-else>
            <div class="selector-search">
              <svg class="selector-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z" fill="currentColor"/>
              </svg>
              <input
                v-model="skillSelectorQuery"
                type="text"
                class="selector-search-input"
                :placeholder="t('sidepanel.app.skillSearchPlaceholder')"
                autocomplete="off"
              />
            </div>
            <div
              v-for="(skill, index) in filteredSkills"
              :key="skill.id"
              :class="['agent-option', 'skill-option', { 'selected': selectedSkillIndex === index, 'skill-active': selectedSkills.includes(skill.id) }]"
              @click="selectSkill(skill.id)"
              @mouseenter="selectedSkillIndex = index"
            >
              <div class="agent-info">
                <div class="agent-name">{{ skillCardLabel(skill) }}</div>
                <div class="agent-desc">{{ skill.description }}</div>
              </div>
            </div>
            <!-- 空态分岔：搜索词非空 = 过滤无果；搜索词为空 = 智能体尚无关联技能 -->
            <div v-if="!filteredSkills.length" class="skill-empty">
              <span class="skill-empty-text">{{ skillSelectorQuery.trim() ? t('sidepanel.app.noSkillsHint') : t('sidepanel.app.agentNoLinkedSkillsHint') }}</span>
              <button
                type="button"
                class="selector-dismiss-btn"
                v-tip="t('common.close')"
                @click="dismissSkillSelector"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
            <!-- 底部关联范围提示：sticky 常驻（与顶部搜索框对称），
                 「去关联」直达 hub 智能体管理分区；hub 保存后经存储同步实时刷新列表 -->
            <div class="skill-scope-hint">
              <span class="skill-scope-hint-text">{{ t('sidepanel.app.skillLinkScopeHint') }}</span>
              <button type="button" class="skill-scope-hint-action" @click="openAgentSkillLinking">
                {{ t('sidepanel.app.skillLinkManageAction') }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 工具面板覆盖层 -->
    <div v-if="showToolPanel" class="tool-overlay" @click="closeToolPanel">
      <div class="tool-panel" @click.stop>
        <div class="tool-panel-header">
          <h3>{{ t('sidepanel.app.toolbox') }}</h3>
          <button class="close-button" @click="closeToolPanel"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
        </div>
        <div class="tool-panel-content">
          <ToolComponent />
        </div>
      </div>
    </div>

    <!-- Deep Search警告弹窗 -->
    <!-- 设置弹窗（壳 + 分区：模型服务 / 高级参数 / 备份 / 语音识别；历史分区导航隐藏） -->
    <SettingsModal
      :visible="showSettingsModal"
      :initial-section="settingsInitialSection"
      :focus-target="settingsFocusTarget"
      @close="handleSettingsClose"
      @saved="handleApiConfigSaved"
    />

    <!-- 语音识别未配置提示弹窗（点击输入框语音按钮时触发） -->
    <AsrConfigPrompt
      :visible="showAsrPrompt"
      @close="showAsrPrompt = false"
      @configure="openAsrSettingsFromPrompt"
    />

    <DeepSearchWarning
      :visible="showDeepSearchWarning"
      @close="closeDeepSearchWarning"
      @go-to-website-settings="goToWebsiteSettings"
      @go-to-agent-selector="goToAgentSelector"
    />

    <!-- 语音录制弹窗 -->
    <VoiceRecordingModal
      :visible="showVoiceRecording"
      :is-recording="isRecording"
      :recording-time="recordingTime"
      :max-recording-time="maxRecordingTime"
      @stop="stopVoiceRecording"
      @cancel="cancelVoiceRecording"
    />

    <!-- AI理解中提示框 -->
    <AiProcessingOverlay :visible="showAiProcessing" />

    <!-- 历史会话抽屉 -->
    <ChatHistoryDrawer
      :visible="showHistoryDrawer"
      :active-chat-id="activeChatId"
      @close="showHistoryDrawer = false"
      @select="loadHistorySession"
      @new-chat="startNewChatFromDrawer"
      @deleted="handleSessionDeleted"
    />

    <!-- 语音助手设置弹窗 -->
    <VoiceAssistantSettings
      :visible="showVoiceAssistantSettings"
      :auto-wake="voiceAssistantAutoWake"
      @cancel="cancelVoiceAssistantMode"
      @confirm="confirmVoiceAssistantMode"
      @toggle-auto-wake="toggleAutoWake"
    />

    <!-- 语音助手悬浮卡片 -->
    <VoiceAssistantCard 
      v-if="showVoiceAssistantCard"
      :status="voiceAssistantStatus"
      :connected-time="voiceAssistantConnectedTime"
      :auto-wake="voiceAssistantAutoWake"
      :is-ai-responding="isAiResponding"
      @start-recording="startVoiceAssistantRecording"
      @stop-recording="stopVoiceAssistantRecording"
      @exit="exitVoiceAssistantMode"
    />

    <!-- 应用级弹窗（附件守卫等异步提示；Promise 化，单例排队） -->
    <AppDialog />

    <!-- 网站学习：配置面板 + 六态确认弹窗（状态由 use-learn-session 单点驱动；
         面板重置由 formEpoch 决定，确认弹窗的应答回流 answerDialog） -->
    <SiteLearnModal
      :visible="learn.phase.value === 'configuring'"
      :model-candidates="learn.modelCandidates.value"
      :errors="learn.errors.value"
      :reset-epoch="learn.formEpoch.value"
      @close="learn.closeModal()"
      @submit="learn.submitConfig($event)"
      @open-settings="showSettingsModal = true"
    />
    <!-- 收尾阶段：草稿暂存失败降级说明（非阻断；与弹窗同为模态，层级置于确认弹窗之下） -->
    <LearnDegradedNotice :visible="learn.degradedNotice.value" @close="learn.dismissDegradedNotice()" />
    <LearnDialog :view="learn.dialog.value" @answer="learn.answerDialog" />
    <LearnRecoveryDismissDialog :visible="learnRecoveryState.confirming.value" :busy="learnRecoveryState.busy.value" :error="learnRecoveryState.dismissError.value" @cancel="learnRecoveryState.cancelDismiss" @confirm="learnRecoveryState.confirmDismiss" />

    <!-- 全局 Toast 宿主（固定右上角，层级高于全部模态；反馈落库失败等轻量提示） -->
    <MessageContainer />

    <!-- interact 询问弹窗（模型提问/授权征询；弹窗 + 悬浮球最小化，超时自动收敛） -->
    <InteractDialog />

    <!-- 全局点击监听器（胶囊条管理弹层固定展示时同样纳入遮罩，点任意处关闭） -->
    <div v-if="showModeSelector || showModelSelectorMenu || selectionStripPinned" class="overlay" @click="closeAllPanels"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, onUnmounted, computed, nextTick } from 'vue';
import { t, type MessageKey } from '@/utils/i18n';
// 智能体头像展示（图片或 emoji，无背景色）：预置 / 自定义 / 导入三类智能体共用
import AgentAvatar from '@/common/AgentAvatar.vue';
// 智能体展示文案随界面语言切换（预置智能体的多语言文案；自定义智能体沿用其自填文案）
import { useAgentDisplay } from '@/common/use-agent-display';
import ToolComponent from './Tool.vue';
// 组件按功能域从 barrel 引入（chat / modals / voice / feedback）
import { ChatMessageList, ChatHistoryDrawer, ContextUsageRing, GuardConfirmBar, PlanBoard, PageQuoteBar } from '../components/chat';
import { SiteLearnModal, LearnDialog, LearnStatusBar, LearnDegradedNotice, LearnRecoveryDismissDialog } from '../components/learn';
import { useLearnSession } from '../composables/use-learn-session';
import { backgroundConversation as conversationEngine } from '../core/conversation/runtime-client';
import { readActiveChat, rememberActiveChat } from '../core/conversation/active-session';
// 用户气泡底部图片区展示口径（只含用户上传；vision 截图走助手内联「查看屏幕」）
import { userVisibleImageRefs } from '../core/context/transcript-engine';
import { SettingsModal, AsrConfigPrompt, DeepSearchWarning } from '../components/modals';
import { VoiceAssistantCard, VoiceAssistantSettings, VoiceRecordingModal } from '../components/voice';
import { AiProcessingOverlay, AppDialog, InteractDialog, MessageContainer, WebSocketStatusBar } from '../components/feedback';
// 全局 Toast（轻量可读提示：反馈落库失败 / 复制失败 / API 错误；宿主见模板 MessageContainer）
import { message as toast } from '../utils/chat/message';
import {
  normalizePageQuoteSource,
  normalizeQuoteText,
  type PageQuote,
} from '../utils/chat/page-quote';

import { openaiToolsConverter } from '../utils/tools/openai-tools-converter';
// 渠道 + 模型领域：模型选择器、端点解析、全局默认引用、会话模型回显统一经注册表
import {
  modelRegistry,
  appSettingsStore,
  modelRefKey,
  normalizeModelRef,
  CONTEXT_THRESHOLD_DEFAULT,
  type ModelOption,
  type ModelRef,
} from '../utils/channels';
// 端点活性问题的展示层映射（结构化事实 → 可读文案；随语言切换自动跟随）
import { livenessIssueText } from '../utils/ui/liveness-message';
// 系统注入上下文的激活网页查询（与引擎侧同口径；失败返回 null 不阻断发送）
import { queryActivePageInfo } from '../utils/system-context';
// 核心引擎层：会话由引擎驱动，App 层只负责事件渲染与前置交互；
// 智能体/技能的读取一律经引擎门面，不直连底层存储
import {
  runtimeBuilder,
  transcriptEngine,
  composeLlmUserMessage,
  agentEngine,
  skillEngine,
  measureContextUsage,
  toolExecutionEngine,
  type ConversationEvent,
  type ConversationRuntime,
  type ChatMessageRecord,
  type ContextUsage,
  type EffectiveContext,
  type AgentConfig,
  type AgentDisplayText,
  type SkillRecord,
  type ToolApprovalRequest,
  type GuardKind,
  type PreRunCompactionPayload,
} from '../core';
// Deep Search 站点注册表：站点开关列表与动态工具注入的单一事实来源
// （站点启用态与 UI 开关在 use-deep-search-sites 单例，见「已登录网站」注释）
import { resolveDeepSearchToolIds } from '../config/deep-search-sites';
// 网站学习成果兜底：草稿（SkillDraft）暂存 + 深链 hash（与 use-learn-session 同源）
import { saveLearnDraft } from '@/utils/learn/learn-draft-store';
import { useLearnRecovery } from '../composables/use-learn-recovery';
import { asSkillDraft } from '@/utils/learn/learn-validate';
import { learnDraftHash, type SkillDraft } from '@/utils/learn/learn-types';
// 注册表权威源对账入口（@ / 面板开启时主动与 chrome.storage 同步，兜底跨上下文 onChanged 事件漏投）
import { restoreCustomAgentsFromStorage } from '@/utils/agents/agent-store';
// 已停用的智能体不可被 @ 选中（过滤规则与存储层同源）
import { filterEnabledAgents } from '@/utils/agents/agent-types';
import { restoreCustomSkillsFromStorage } from '@/utils/skills/skill-store';
import { findDuplicateSkillNames } from '@/utils/skills/skill-types';
import { resolveAgentLinkedSkills } from '@/utils/skills/skill-availability';
// 会话计划（plan_tool 产物）：活跃会话绑定 / 删除级联 / chrome.storage 对账
import { setActivePlanChat, dropPlan, restorePlansFromStorage } from '@/utils/plan/plan-store';
import { convertAudioToText } from '../utils/ai/voice-to-text';
// 附件栏：文件分类/解析在纯逻辑层，守卫流程与状态在 composable
import { importWorkspaceFiles } from '@/utils/python-workspace/store';
import {
  createAttachmentManager,
  formatBytes,
  type ChatAttachment,
} from '../composables/use-attachments';
// 会话文件库：文本附件发送时注册（8 位短 id + 确定性分页），read_file 按页续读
import { conversationFileStore } from '@/utils/conversation-files/file-store';
// 会话跨上下文桥：管理中心「会话管理」分区请求本面板切换 / 复位会话
import { SESSION_BRIDGE_MSG } from '@/utils/sessions/session-bridge';
import {
  buildUploadFileEnvelope,
  type UploadFileEnvelopeEntry,
} from '@/utils/conversation-files/upload-file-envelope';
import { showAlert, showConfirm, showAction, openDialogWithHandle, settleDialogById, type AppDialogResult } from '../composables/use-app-dialog';
// 视觉能力守卫：模型 / 智能体 / 图片附件 三方一致性的判定单一事实源
import {
  evaluateVisionGuard,
  agentRequiresVision,
  type VisionCapabilityContext,
  type VisionGuardContext,
  type VisionGuardScenario,
} from '../utils/chat/vision-capability-guard';
import { dismissPendingInteracts } from '../composables/use-interact';
import { toApiErrorBlock } from '../utils/stream/errors';
import {
  API_ERROR_CONTINUE_EXPIRED,
  API_ERROR_RETRY_EXPIRED,
  type ApiErrorRetryRequest,
  type GuardContinueRequest,
} from '../utils/chat/retry-state';
import { setApiErrorRetryHandler, type ApiErrorRetryTarget } from '../utils/chat/api-error-retry';
// 直播消息的片段流装配（占位建立 / 占位转真实消息 / 截图按序入流）：
// 单一事实源，规则见 utils/chat/live-parts
import {
  startLiveMessage,
  beginLiveMessage,
  appendLiveImage,
  hasVisibleLiveContent,
} from '../utils/chat/live-parts';
// 压缩片段生命周期（推送/结算/中断收拢/展开切换）：引擎侧 record.parts 与
// UI 侧直播消息双写共用的唯一实现，保证终态按索引合并时片段流不错位
import {
  pushCompactionPart,
  settleCompactionPart,
  settlePendingCompactionParts,
  createCompactionPart,
  toggleCompactionExpanded,
  historyDisplayParts,
} from '../utils/chat/compaction-part';
// 行内数值格式化共享实现（token K 口径 / 行内耗时标签；见 utils/chat/format）
import { formatTokensK as sharedFormatTokensK } from '../utils/chat/format';
// 本轮消息体积守卫：token 口径计量（与窗口守卫/压缩触发同一估算实现）
import { estimateMessageTokens, estimateTextTokens } from '../utils/ai/token-estimate';
// 导入工具注册模块以确保工具被正确注册
import '@/tools';
// 导入WebSocket后端连接模块
import { ConnectionStatus } from '@/entrypoints/background/ws/websocket-types';
import { startWebsiteValidationWatcher } from '../utils/ws/website-validator';
// 统一类型定义
import type { ExtendedChatMessage, MessageFeedback, MessagePart } from '../types/chat';
// 页面视觉效果
// WebSocket连接管理
import { useWebSocket } from '../composables/useWebSocket';
// 语音录制管理
import { useVoiceRecording } from '../composables/useVoiceRecording';
// 语音助手模式管理
import { useVoiceAssistant } from '../composables/useVoiceAssistant';
// 已登录网站（Deep Search 站点开关）共享状态
import { useDeepSearchSites } from '../composables/use-deep-search-sites';

// 响应式数据
const userInput = ref('');
const isDev = import.meta.env.DEV;
const showToolPanel = ref(false);
const showChatMode = ref(false);
const currentTool = ref('');
const messages = ref<ExtendedChatMessage[]>([]);
const showAgentSelector = ref(false);
const selectedAgent = ref('');
const selectedAgentIndex = ref(0);
// 技能选择状态：/ 触发面板，支持多选、单个取消。
// 选中值为技能 id（稳定引用；技能改名后引用不失效）
const showSkillSelector = ref(false);
const selectedSkillIndex = ref(0);
const selectedSkills = ref<string[]>([]);
const skills = ref<SkillRecord[]>([]);
// 卡片内搜索词（@ 智能体卡 / 技能卡各自独立）。
// 输入框里的触发序列不再承担过滤职责：@ 与 / 之后继续打字会直接收起卡片，
// 搜索改由卡片顶部的搜索框完成
const agentSelectorQuery = ref('');
const skillSelectorQuery = ref('');
// 当前活跃会话（引擎层 chatId；空 = 尚未创建，下次发送时新建）
const activeChatId = ref('');
/**
 * 当前会话的 systemPrompt 补充段（随会话持久化，见 ChatSessionMeta.systemPromptSuffix）。
 * 会话切换时回显、发送时写库；上下文预算估算用它重建与真实请求同源的 systemPrompt。
 */
const activeSystemPromptSuffix = ref('');

// ==================== 上下文用量（环上进度条）与压缩感知 ====================

/** 单条用户消息长度上限（字符）：防御超长粘贴拖垮上下文预算与请求体 */
const MAX_USER_INPUT_CHARS = 20_000;

/** 最近一次全量上下文测量（system + 工具定义 + 对话消息；null = 尚无请求） */
const contextUsage = ref<ContextUsage | null>(null);
/** 是否正在执行上下文压缩（环呼吸动画 + 卡片提示） */
const isCompacting = ref(false);

/**
 * 当前直播消息 id（运行中的助手记录）。
 *
 * 交给 ChatMessageList 做直播态精确判定：此前按「最后一条消息」判定，
 * 任何运行期间追加到列表尾部的消息（压缩进度气泡、错误卡片）都会把
 * 流式消息挤成「已结束」渲染——大折叠提前出现、复制/赞/踩按钮在运行中
 * 即可点击、data-streaming 标记被摘除。按 id 命中后这一整类翻转消失；
 * 运行终态（完成/出错/中止）清空，回落到非直播渲染。
 */
const liveAssistantMessageId = ref<string | null>(null);

/**
 * 发送前压缩（pre-run）结果缓冲（chatId → 结算态载荷）。
 *
 * 发送前压缩发生在助手记录创建之前（无 messageId 可挂接）：done/failed
 * 事件先缓冲在这里，assistant-start 建立直播占位时把缓冲种子为消息的
 * 首个压缩片段；引擎侧经 runtime.preRunCompaction 把同一载荷写入
 * record.parts 持久化——两条路径同一来源，时间线落成同一形态。
 * 运行落定（settled）时清理，防准备失败场景下的陈旧种子。
 */
const preRunCompactionSeed = new Map<string, PreRunCompactionPayload>();

/**
 * 会话有效上下文缓存（chatId → 压缩摘要 + 记录）。
 *
 * 用途：选择变化（智能体/技能/模型）时即时重算上下文预算，不能每次都读 IndexedDB——
 * 用户在 @ 面板里连续切换几个智能体就会产生数十次读库。
 * 一致性：只在「会话加载 / 新建 / 压缩完成」三个时点写入，与转录引擎的持久化时点
 * 一一对应；会话切换时整体替换，因此环上数字永远来自当前会话的真实记录。
 */
const sessionContextCache = new Map<string, EffectiveContext>();

/** 写入/覆盖某会话的有效上下文缓存 */
const storeEffectiveContext = (chatId: string, effective: EffectiveContext): void => {
  if (!chatId) return;
  sessionContextCache.set(chatId, effective);
};

/** 清空缓存（会话删除、回到新会话时调用，避免残留会话数据拖内存） */
const clearSessionContextCache = (chatId?: string): void => {
  if (chatId) sessionContextCache.delete(chatId);
  else sessionContextCache.clear();
};

/**
 * 把指定会话的有效上下文重新载入缓存。
 * 发送流程结束后调用：本轮新增的助手记录与工具结果不在缓存里，
 * 不对齐则之后切换智能体时的预算预估会按发送前的历史偏低计算。
 */
const syncSessionContextCache = async (chatId: string): Promise<void> => {
  if (!chatId) return;
  try {
    storeEffectiveContext(chatId, await transcriptEngine.getEffectiveContext(chatId));
  } catch (error) {
    console.warn('[App] 刷新会话上下文缓存失败:', error);
  }
};

/**
 * 当前选择的稳定签名（智能体 + 技能 + 模型）。
 * 用于「运行期间选择是否被改动」的判定与上下文预算的变更触发，
 * 统一口径避免两处各自拼接字符串产生漂移。
 */
const selectionSignature = (): string =>
  `${selectedAgent.value}\u0000${[...selectedSkills.value].join('\u0000')}\u0000${activeModelKey.value}`;

/** 字符数人性化（K 单位一位小数） */
const formatCharsK = (chars: number): string =>
  chars < 1024 ? `${Math.round(chars)}` : `${(chars / 1024).toFixed(1)}K`;

/**
 * token 数人性化展示（K = 1024 token，与上下文阈值 256K = 262144 同一换算，
 * 保证「压缩前后」「消息体积 vs 预算」等对比文案与圆环读数量纲一致）。
 * 实现共享自 utils/chat/format（≤0 / 非有限值返回空串——展示隐藏语义）；
 * 告警文案需要「0」的调用点以 || '0' 兜底。
 */
const formatTokensK = (tokens: number): string => sharedFormatTokensK(tokens) || '0';

/**
 * 推送一条轻量系统通知到对话流（仅 UI 展示，不入转录/不入模型上下文）。
 * 用于输入超限、运行中止反馈等用户可感知事件。
 * 注意：运行期间追加的任何顶层消息都会使「最后一条」启发式下的直播消息
 * 翻成终态渲染——运行期进度（工具/压缩）一律走消息内片段，不走此入口。
 * 消息标记 isSystemNotice 且 parts 为 notice 类型：渲染层据此以独立的
 * 系统信息条容器展示（与工具调用行同风格），不混用正文气泡样式。
 */
const pushSystemNotice = (text: string): void => {
  messages.value.push({
    id: `notice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    role: 'assistant',
    content: text,
    timestamp: Date.now(),
    parts: [{ type: 'notice', content: text }],
    toolCalls: [],
    isSystemNotice: true,
  });
};

// ==================== 循环守卫确认（应用内非阻塞，取代 window.confirm） ====================

/**
 * 守卫未确认时的自动停止时限（秒）。
 * 默认走安全侧：无人值守（用户离开、忽略确认条）的任务不允许无限续跑。
 */
const GUARD_AUTO_STOP_SECONDS = 60;

/** 进行中的守卫确认（null = 无）：finish 一次性收敛 Promise、倒计时与 UI 状态 */
interface PendingGuard {
  kind: GuardKind;
  /** max-iterations 时的轮数上限 / tool-failures 时的连续失败轮数（文案用） */
  count?: number;
  /** max-duration 时的时长上限（分钟，文案用） */
  minutes?: number;
  /** 收敛：以参数值 resolve 引擎侧的延续确认 Promise */
  finish: (proceed: boolean) => void;
}

const pendingGuard = ref<PendingGuard | null>(null);
const guardSecondsLeft = ref(0);
let guardCountdownTimer: number | null = null;

/** 收敛进行中的守卫确认（幂等）：清理倒计时、关闭确认条、resolve 引擎侧 Promise */
const settleGuard = (proceed: boolean): void => {
  const guard = pendingGuard.value;
  if (!guard) return;
  if (guardCountdownTimer !== null) {
    window.clearInterval(guardCountdownTimer);
    guardCountdownTimer = null;
  }
  pendingGuard.value = null;
  guardSecondsLeft.value = 0;
  guard.finish(proceed);
};

/**
 * 呈现守卫确认条并挂起引擎侧延续确认。
 * 确认期间界面保持可用：停止按钮经 stopAiResponse → settleGuard(false) 即刻生效；
 * 倒计时归零按停止收敛；会话切换同样收敛（旧会话的确认不应悬停在新会话界面上）。
 */
const openGuardConfirm = (guard: Omit<PendingGuard, 'finish'>, resolve: (proceed: boolean) => void): void => {
  // 防御：同一运行内守卫串行触发，理论上不存在并发确认；旧确认按停止收敛兜底
  settleGuard(false);
  pendingGuard.value = { ...guard, finish: proceed => resolve(proceed) };
  guardSecondsLeft.value = GUARD_AUTO_STOP_SECONDS;
  guardCountdownTimer = window.setInterval(() => {
    guardSecondsLeft.value -= 1;
    if (guardSecondsLeft.value <= 0) settleGuard(false);
  }, 1000);
};

// 会话切换时收敛挂起的守卫确认：确认条全局唯一，不属于任何特定会话视图
watch(activeChatId, () => {
  settleGuard(false);
  // interact 询问同理全局唯一：切走的会话仍在后台运行，其挂起询问按
  // dismissed（询问被中断）收敛，弹窗/悬浮球不留残影
  dismissConversationQuestions();
});

// ==================== 工具审批（破坏性操作人审门） ====================

/**
 * 审批弹窗未响应时的自动拒绝时限（秒）。
 * 安全侧默认：无人值守（用户离开、忽略弹窗）绝不执行破坏性操作；
 * 引擎在拒绝后以可控失败回传模型，模型可向用户说明或改换路径。
 */
const TOOL_APPROVAL_TIMEOUT_SECONDS = 60;

/**
 * 进行中的工具审批（null = 无）：弹窗 id + 收敛器。
 * stopAiResponse 收敛它——否则「停止任务」后审批弹窗仍悬停在界面上，
 * 引擎也要等到审批 Promise 结算（用户点击或 60s 超时）才能继续退出。
 */
let pendingToolApproval: { dialogId: number; finish: (approved: boolean) => void } | null = null;

/**
 * 呈现工具审批弹窗并等待用户决定。
 * 与守卫确认条同构的超时语义：到时按拒绝收敛，绝不让运行无限悬停；
 * 弹窗排队由 use-app-dialog 的单例队列保证（与附件守卫等弹窗互不叠层）。
 * 句柄化注册：弹窗可被 stopAiResponse 经 settleDialogById 定向关闭并
 * 按拒绝收敛（排队中同样支持），停止后不留悬挂弹窗。
 */
const requestToolApproval = (request: ToolApprovalRequest): Promise<boolean> =>
  new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (approved: boolean): void => {
      if (settled) return;
      settled = true;
      // 收敛器注销：只有当前注册者本尊才清理，防止误清后续审批的注册
      if (pendingToolApproval?.finish === finish) pendingToolApproval = null;
      window.clearTimeout(timer);
      resolve(approved);
    };
    const timer = window.setTimeout(() => {
      try {
        settleDialogById(handle.id, false);
      } catch (error) {
        console.warn('[Conversation] 审批超时关闭弹窗失败:', error);
      } finally {
        finish(false);
      }
    }, TOOL_APPROVAL_TIMEOUT_SECONDS * 1000);
    const handle = openDialogWithHandle({
      message: t('sidepanel.chat.toolApprovalMessage', {
        name: request.name,
        args: request.argumentsPreview,
      }),
      title: t('sidepanel.chat.toolApprovalTitle'),
      tone: 'warn',
      mode: 'confirm',
      confirmText: t('sidepanel.chat.toolApprovalAllow'),
      cancelText: t('sidepanel.chat.toolApprovalDeny'),
    });
    pendingToolApproval = { dialogId: handle.id, finish };
    // result 永不 reject（use-app-dialog 契约：任何路径都 resolve），无拒绝分支。
    // 三态收敛为布尔：仅 'confirm' 视为允许，其余（取消 / 遮罩 / 定向收敛）均拒绝
    void handle.result.then(result => finish(result === 'confirm'));
  });

/** Ordinary chat and learning share one cleanup path for user questions. */
function dismissConversationQuestions(): void {
  dismissPendingInteracts();
  const approval = pendingToolApproval;
  if (!approval) return;
  pendingToolApproval = null;
  try {
    settleDialogById(approval.dialogId, false);
  } catch (error) {
    console.warn('[Conversation] 关闭工具审批弹窗失败:', error);
  } finally {
    approval.finish(false);
  }
}

// ==================== 持久化降级告知（IndexedDB 故障不再静默丢数据） ====================

/**
 * 降级提示的最小间隔（毫秒）。DB 故障期间每次快照 flush 都会失败，
 * 逐条提示会演变为通知风暴；节流为「每分钟至多一条」，知情权与可用性兼顾。
 */
const PERSISTENCE_NOTICE_THROTTLE_MS = 60_000;
let lastPersistenceNoticeAt = 0;

const unsubscribePersistenceIssues = transcriptEngine.onPersistenceIssue(issue => {
  const now = Date.now();
  if (now - lastPersistenceNoticeAt < PERSISTENCE_NOTICE_THROTTLE_MS) return;
  lastPersistenceNoticeAt = now;
  pushSystemNotice(t('sidepanel.chat.persistenceDegraded', { reason: issue.message }));
});

// ==================== 会话引擎事件适配（引擎事件 → UI 消息渲染） ====================

/** 运行中的 UI 助手消息缓存（messageId → 消息对象），与引擎记录同 id 便于终态覆盖；parts/toolCalls 恒有值 */
type RunningAssistantMessage = ExtendedChatMessage & {
  parts: import('../types/chat').MessagePart[];
  toolCalls: import('../types/chat').ToolCallUI[];
};
const runningAssistantMessages = new Map<string, RunningAssistantMessage>();

/**
 * 尚未落地的图片引用缓冲（messageId → { chatId, refs }）。
 * 引擎准备阶段里首截图的 message-image 事件先于 assistant-start 发出
 * （占位记录创建后立即挂图），此时 UI 消息还不存在——先缓冲，
 * assistant-start 创建占位时合并，保证首截图不丢失。
 * 随聊天 id 一并存储并双重清理：运行终态（完成/出错/中止）按 messageId
 * 清除，会话删除按 chatId 整体清除——保证任何异常时序下缓冲都不泄漏。
 */
const pendingImageRefs = new Map<string, { chatId: string; refs: string[] }>();

/**
 * 会话级 UI 状态复位（会话切换 / 新建 / 回到主页 / 学习切换的共同收尾）。
 *
 * 收敛为一处是因为这组状态**必须同生共死**：漏复位任一项都会留下与当前
 * 视图不符的悬停态——漏 `isCompacting` 会让新会话的圆环永远呼吸在「正在
 * 压缩对话记忆…」（旧会话的压缩事件被会话守卫丢弃，永远等不到收尾信号）；
 * 漏 `liveAssistantMessageId` 会让新消息被当作直播消息渲染。
 *
 * 字段口径：
 *   - runningAssistantMessages：运行源（流式刷新的唯一数据源）
 *   - liveAssistantMessageId：直播消息登记（直播态精确判定的依据）
 *   - preRunCompactionSeed：发送前压缩种子缓冲（跨会话无意义）
 *   - isCompacting：压缩感知（圆环呼吸 / 学习状态条提示）
 *   - contextUsage：上下文用量——默认保留（历史会话加载后即刻按新会话
 *     重算，提前清空只会让圆环闪一下空态）；仅新建/切换场景显式清空。
 */
const resetSessionScopedUiState = (options?: { clearContextUsage?: boolean }): void => {
  runningAssistantMessages.clear();
  liveAssistantMessageId.value = null;
  preRunCompactionSeed.clear();
  isCompacting.value = false;
  if (options?.clearContextUsage) contextUsage.value = null;
};

/** 按事件定位/创建 UI 助手消息：首个内容事件到达时把「思考中」占位转换为真实消息 */
const ensureAssistantMessage = (messageId: string, isThinkingConversion = false): RunningAssistantMessage | null => {
  let uiMessage = runningAssistantMessages.get(messageId);
  if (!uiMessage) return null;
  const listIndex = messages.value.findIndex(msg => msg.id === messageId);
  if (listIndex === -1) return null;

  if (isThinkingConversion && uiMessage.isThinking) {
    uiMessage.isThinking = false;
    // 占位转真实消息：空正文占位丢弃，**截图片段保留**（首截图是本轮已
    // 发生的事实，丢弃即从时间线消失、只剩引用 → 渲染层回退到消息底部
    // 的关联图片区，表现为「截图挂在消息最后」而非按发生顺序内联）
    uiMessage.parts = beginLiveMessage({
      parts: uiMessage.parts,
      imageRefs: uiMessage.imageRefs ?? [],
    }).parts;
    uiMessage.toolCalls = [];
    uiMessage.content = '';
    uiMessage.reasoning_content = '';
  }
  return uiMessage;
};

/**
 * 触发 Vue 响应式更新：以浅拷贝消息对象替换列表项（深拷贝工具调用引用）。
 * rAF 合批：流式期间 token/推理/工具事件密集到达，同一帧内多次 splice
 * 只有最后一次可见——合并为每帧至多一次列表替换，把列表级响应式开销
 * 从「每 token」摊薄到「每帧」。
 * 快照在调用时立即生成（而非 flush 时回查运行源）：终态路径
 * （assistant-error 等）会在 flush 前删除运行源对象，回查会丢失最后一批
 * 变更；快照则保证已入队的状态必然上屏。同帧多次调用时后一次快照
 * 覆盖前一次，最终呈现最新状态。
 */
const pendingUiRefresh = new Map<string, ExtendedChatMessage>();
let uiRefreshScheduled = false;

const applyUiRefresh = (): void => {
  uiRefreshScheduled = false;
  if (pendingUiRefresh.size === 0) return;
  const entries = [...pendingUiRefresh];
  pendingUiRefresh.clear();
  for (const [messageId, snapshot] of entries) {
    const index = messages.value.findIndex(msg => msg.id === messageId);
    if (index === -1) continue;
    messages.value.splice(index, 1, snapshot);
  }
};

const refreshUiMessage = (messageId: string): void => {
  const source = runningAssistantMessages.get(messageId);
  if (!source) return;
  pendingUiRefresh.set(messageId, {
    ...source,
    content: source.content,
    parts: source.parts.map(p => (p.type === 'tool' && p.toolCall
      ? { ...p, toolCall: { ...p.toolCall } }
      : p.type === 'compaction' && p.compaction
        ? { ...p, compaction: { ...p.compaction } }
        : p)),
    toolCalls: source.toolCalls.map(tc => ({ ...tc })),
  });
  if (!uiRefreshScheduled) {
    uiRefreshScheduled = true;
    requestAnimationFrame(applyUiRefresh);
  }
};

/** 会话引擎事件 → UI 渲染（唯一入口，替代原先散落在回调里的组装逻辑） */
const handleConversationEvent = (event: ConversationEvent): void => {
  // 防御：忽略非当前活跃会话的事件（并行会话、运行中切换/删除会话时防止消息串扰）
  if (event.chatId !== activeChatId.value) {
    console.warn(`[Conversation] 忽略非活跃会话事件: type=${event.type}, chatId=${event.chatId}`);
    return;
  }
  switch (event.type) {
    case 'user-message': {
      if (messages.value.some(message => message.id === event.record.id)) break;
      messages.value.push({
        id: event.record.id,
        role: 'user',
        content: event.record.content,
        timestamp: event.record.createdAt,
        parts: [{ type: 'text', content: event.record.content }],
        toolCalls: [],
        // 自动续跑的隐藏用户轮：参与模型上下文与时效判定，但不渲染用户气泡
        ...(event.record.synthetic ? { isIgnore: true } : {}),
        // 用户上传图片以引用形态随消息展示（可查看 / 放大 / 下载）。
        // 展示口径走 userVisibleImageRefs（只含用户上传）——引擎随后注入的
        // vision 首截图引用不在此列，避免同一截图在用户气泡与助手「查看屏幕」双显
        ...(userVisibleImageRefs(event.record).length > 0
          ? { imageRefs: userVisibleImageRefs(event.record) }
          : {}),
        // 用户确认的网页引用：随消息落库，气泡据此渲染引用块（引用原文在
        // 会话历史里始终可见——用户能核对「当时引用的是哪一段」）
        ...(event.record.pageQuote ? { pageQuote: event.record.pageQuote } : {}),
      });
      break;
    }
    case 'assistant-start': {
      // 学习/验证直接驱动引擎，不经过 sendMessage。响应态以统一事件为准，
      // 由运行终态回调结束，避免流式内容被提前当作已完成消息折叠并显示反馈按钮。
      isAiResponding.value = true;
      pendingUiRefresh.delete(event.messageId);
      messages.value = messages.value.filter(message => message.id !== event.messageId);
      // 直播消息登记（ChatMessageList 按 id 精确判定直播态，见 liveAssistantMessageId）
      liveAssistantMessageId.value = event.messageId;
      // 「思考中」占位（与旧实现一致的 UI 状态）
      // 首截图的 message-image 事件先于 assistant-start 到达（引擎准备阶段顺序）：
      // 此时 UI 消息尚不存在，事件被缓冲在 pendingImageRefs，这里合并落地。
      // 部件置于片段流最前——首截图发生在任何正文与工具调用之前
      const pending = pendingImageRefs.get(event.messageId);
      pendingImageRefs.delete(event.messageId);
      const started = startLiveMessage(pending?.refs ?? []);
      // 发送前压缩结果种子：压缩发生在本轮一切内容之前，片段置于流最前
      // （早于首截图）；无压缩时缓冲为空，不产生片段。
      // 种子构造与引擎侧共用 compaction-part.createCompactionPart，
      // 两侧承载同一份数据（trigger 恒为 pre-run，两侧各自补齐）。
      const preRunCompaction = preRunCompactionSeed.get(event.chatId);
      preRunCompactionSeed.delete(event.chatId);
      const seededParts: MessagePart[] = [
        ...(preRunCompaction
          ? [createCompactionPart({ trigger: 'pre-run', ...preRunCompaction })]
          : []),
        ...started.parts,
      ];
      const thinking: RunningAssistantMessage = {
        id: event.messageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        parts: seededParts,
        toolCalls: [],
        isThinking: true,
        ...(started.imageRefs.length > 0 ? { imageRefs: started.imageRefs } : {}),
      };
      const live: RunningAssistantMessage = event.record
        ? { ...recordToUiMessage(event.record), parts: event.record.parts, toolCalls: event.record.toolCalls, isThinking: false, durationMs: undefined }
        : thinking;
      runningAssistantMessages.set(event.messageId, live);
      messages.value.push(live);
      break;
    }
    case 'message-image': {
      // 截图挂接到对应大模型消息：
      //   - imageRefs：去重的引用集合（终态对齐与历史兜底展示用）；
      //   - parts['image']：时间线片段，直播态逐事件追加，与引擎 record.parts
      //     保持 1:1（内容寻址下同 hash 的重复截屏在时间线上是两次真实发生，
      //     漏推会让 assistant-complete 按索引合并时与引擎记录错位）
      const target =
        runningAssistantMessages.get(event.messageId) ??
        messages.value.find(msg => msg.id === event.messageId);
      if (!target) {
        // 消息尚未创建（首截图事件先于 assistant-start）：缓冲待 assistant-start 合并
        const existing = pendingImageRefs.get(event.messageId);
        const refs = existing ? existing.refs : [];
        if (!refs.includes(event.imageRef)) refs.push(event.imageRef);
        pendingImageRefs.set(event.messageId, { chatId: event.chatId, refs });
        break;
      }
      const isLiveTarget = runningAssistantMessages.has(event.messageId);
      // parts 类型可选（旧记录 / 兜底路径可能缺）：收敛初始化，
      // 供下方「终态去重判定」与「片段追加」直接使用
      target.parts ??= [];
      // 已终态的消息：终态覆盖已同步 record.parts，迟到事件只补引用不重复推片段
      if (
        !isLiveTarget &&
        target.parts.some(part => part.type === 'image' && part.imageRef === event.imageRef)
      ) {
        break;
      }
      // 截图按发生顺序追加到片段流末尾（引用集合去重保序、片段流不去重：
      // 同一张图的两次截屏是两次真实发生，时间线必须保留两条）
      const appended = appendLiveImage(
        { parts: target.parts, imageRefs: target.imageRefs ?? [] },
        event.imageRef,
      );
      target.parts = appended.parts;
      target.imageRefs = appended.imageRefs;
      refreshUiMessage(event.messageId);
      break;
    }
    case 'token': {
      // 引擎已发射清洗后的增量（含工具调用后的冒号清理），此处只做纯追加，
      // 保证 UI 展示与转录记录逐字一致
      const uiMessage = ensureAssistantMessage(event.messageId, true);
      if (!uiMessage) break;
      const lastPart = uiMessage.parts.length > 0 ? uiMessage.parts[uiMessage.parts.length - 1] : null;
      if (lastPart && lastPart.type === 'text') {
        lastPart.content = (lastPart.content || '') + event.delta;
      } else {
        uiMessage.parts.push({ type: 'text', content: event.delta });
        // 正文出现 → 收起推理片段（展示约定）；用户手动展开过的不动
        uiMessage.parts.forEach(p => { if (p.type === 'reasoning' && !p.userToggled) p.collapsed = true; });
        if (uiMessage.reasoning_content && !legacyReasoningUserToggled.has(event.messageId)) {
          (uiMessage as any)._reasoningContentCollapsed = true;
        }
      }
      uiMessage.content += event.delta;
      refreshUiMessage(event.messageId);
      break;
    }
    case 'reasoning': {
      const uiMessage = ensureAssistantMessage(event.messageId, true);
      if (!uiMessage) break;
      uiMessage.reasoning_content = (uiMessage.reasoning_content || '') + event.delta;
      const lastPart = uiMessage.parts.length > 0 ? uiMessage.parts[uiMessage.parts.length - 1] : null;
      if (lastPart && lastPart.type === 'reasoning') {
        lastPart.content = (lastPart.content || '') + event.delta;
      } else {
        uiMessage.parts.push({ type: 'reasoning', content: event.delta });
      }
      refreshUiMessage(event.messageId);
      break;
    }
    case 'notice': {
      // 系统注记（守卫停止说明 / 截断注记）：并入当前助手消息的片段流，
      // 以独立系统信息条渲染（notice 类型片段）；终态覆盖时引擎记录已含同片段。
      // 正文必须同步追加（与引擎 appendNotice 双写一致）：否则 rAF 快照会把
      // 「片段有注记、正文没有」的旧内容覆盖到终态消息上，破坏继续/重试的
      // 「注记是正文结尾」判定。
      const uiMessage = runningAssistantMessages.get(event.messageId);
      if (!uiMessage) break;
      uiMessage.parts.push({
        type: 'notice',
        content: event.text,
        ...(event.noticeAction ? { noticeAction: event.noticeAction } : {}),
        ...(event.guardKind ? { guardKind: event.guardKind } : {}),
      });
      uiMessage.content = uiMessage.content ? `${uiMessage.content}\n\n${event.text}` : event.text;
      refreshUiMessage(event.messageId);
      break;
    }
    case 'tool-call': {
      const uiMessage = ensureAssistantMessage(event.messageId, true);
      if (!uiMessage) break;
      if (uiMessage.toolCalls.some(tc => tc.id === event.call.id)) break;
      uiMessage.toolCalls.push({ ...event.call, expanded: false });
      uiMessage.parts.push({ type: 'tool', toolCall: { ...event.call, expanded: false } });
      // 工具调用出现 → 收起推理片段（展示约定）；用户手动展开过的不动
      uiMessage.parts.forEach(p => { if (p.type === 'reasoning' && !p.userToggled) p.collapsed = true; });
      refreshUiMessage(event.messageId);
      break;
    }
    case 'tool-result': {
      const uiMessage = runningAssistantMessages.get(event.messageId);
      if (!uiMessage) break;
      const applyTo = (call: { status: string; result?: any; error?: string; executionTime?: number } | undefined) => {
        if (!call) return;
        call.status = event.status;
        if (event.status === 'error' && event.error !== undefined) call.error = event.error;
        if (event.status === 'success' && event.result !== undefined) call.result = event.result;
        call.executionTime = event.executionTimeMs;
      };
      applyTo(uiMessage.toolCalls.find(tc => tc.id === event.callId));
      const toolPart = uiMessage.parts.find(p => p.type === 'tool' && p.toolCall?.id === event.callId);
      applyTo(toolPart?.toolCall);
      refreshUiMessage(event.messageId);
      break;
    }
    case 'assistant-complete': {
      // 终态以引擎记录为准整体覆盖，但保留用户在流式期间做出的展开选择：
      // 推理片段按片段下标、工具调用按调用 id，把 UI 侧（running 消息）的
      // collapsed/userToggled/expanded 状态合并进终态记录——否则覆盖瞬间
      // 用户刚展开的思考过程/工具详情会被引擎侧的默认收起状态冲掉
      const record = event.record;
      const runningUi = runningAssistantMessages.get(record.id);
      const finalParts = record.parts.map((part, index) => {
        const uiPart = runningUi?.parts[index];
        if (part.type === 'reasoning' && uiPart?.type === 'reasoning' && uiPart.userToggled) {
          return { ...part, collapsed: uiPart.collapsed, userToggled: true };
        }
        // 压缩片段：用户在流式期间展开的摘要详情同样保留（与工具展开同语义）
        if (part.type === 'compaction' && part.compaction && uiPart?.type === 'compaction' && uiPart.compaction?.expanded) {
          return { ...part, compaction: { ...part.compaction, expanded: true } };
        }
        return part;
      });
      const finalToolCalls = record.toolCalls.map(call => {
        const uiCall = runningUi?.toolCalls.find(tc => tc.id === call.id);
        return uiCall?.expanded ? { ...call, expanded: true } : call;
      });
      // parts 中的工具调用片段同样按 id 合并展开状态
      const mergedParts = finalParts.map(part =>
        part.type === 'tool' && part.toolCall
          ? { ...part, toolCall: finalToolCalls.find(tc => tc.id === part.toolCall!.id) ?? part.toolCall }
          : part,
      );
      const finalMessage: ExtendedChatMessage = {
        id: record.id,
        role: 'assistant',
        content: record.content,
        timestamp: record.createdAt,
        parts: mergedParts,
        toolCalls: finalToolCalls,
        reasoning_content: record.reasoning,
        // 执行时长（usage.durationMs 由 finalize 在发射前写入）随终态上屏；
        // 与历史加载共用 recordMetaOf，两路径口径恒一致
        ...recordMetaOf(record),
        // 关联图片（vision 自动截图）以引擎记录为准整体覆盖；
        // 记录缺失时回退运行期 UI 已挂接的引用（防御终态时序竞态）
        imageRefs:
          record.imageRefs && record.imageRefs.length > 0
            ? [...record.imageRefs]
            : runningUi?.imageRefs && runningUi.imageRefs.length > 0
              ? [...runningUi.imageRefs]
              : undefined,
        ...(runningUi?._reasoningContentCollapsed !== undefined
          ? { _reasoningContentCollapsed: runningUi._reasoningContentCollapsed }
          : {}),
      };
      const index = messages.value.findIndex(msg => msg.id === record.id);
      // 终态以引擎记录为准：丢弃此前 rAF 排队的直播快照，否则它会在下一帧
      // 用「不含终态注记正文」的旧快照覆盖归还态消息，造成片段与正文不一致
      // （守卫继续/API 重试的时效判定都会因此误判失效）。
      pendingUiRefresh.delete(record.id);
      if (index === -1) messages.value.push(finalMessage);
      else messages.value.splice(index, 1, finalMessage);
      runningAssistantMessages.delete(record.id);
      if (liveAssistantMessageId.value === record.id) liveAssistantMessageId.value = null;
      // 终态兜底：正常路径下缓冲已在 assistant-start 合并，此处保证异常时序也不滞留
      pendingImageRefs.delete(record.id);
      break;
    }
    case 'assistant-error': {
      const uiMessage = ensureAssistantMessage(event.messageId, true);
      if (!uiMessage) break;
      const errorText = `\n\n${event.error}`;
      // 压缩中断结算：错误可能发生在压缩请求进行中（压缩器失败已自行结算，
      // 其余路径由引擎 finalize 兜底）——UI 侧同一收敛，杜绝旋转态残留
      settlePendingCompactionParts(uiMessage.parts, t('sidepanel.chat.compactionInterrupted'));
      const lastPart = uiMessage.parts.length > 0 ? uiMessage.parts[uiMessage.parts.length - 1] : null;
      if (lastPart && lastPart.type === 'text') lastPart.content = (lastPart.content || '') + errorText;
      else uiMessage.parts.push({ type: 'text', content: errorText });
      uiMessage.content += errorText;
      // 终态收敛推理片段：流式期间可能从未到达过「正文/工具触发自动收起」
      // 的时点（如思考中被异常打断），此处按同一展示约定补齐收起
      uiMessage.parts.forEach(p => { if (p.type === 'reasoning' && !p.userToggled) p.collapsed = true; });
      // 失败轮次同样计时（事件在 finalize 后发射）：写入运行源后经 refresh 快照上屏
      if (event.durationMs !== undefined) uiMessage.durationMs = event.durationMs;
      refreshUiMessage(event.messageId);
      runningAssistantMessages.delete(event.messageId);
      if (liveAssistantMessageId.value === event.messageId) liveAssistantMessageId.value = null;
      pendingImageRefs.delete(event.messageId);
      break;
    }
    case 'aborted': {
      // 中止终态化：保留已流出的部分内容并结束「思考中」状态；
      // 若中止发生在任何内容到达之前，移除占位消息避免永久残留。
      // 同时推送系统信息条给出明确的「已停止」反馈——中止只表现为内容
      // 戛然而止，没有提示时用户无法区分「停了」与「卡了」
      pushSystemNotice(t('sidepanel.chat.stoppedByUser'));
      const uiMessage = runningAssistantMessages.get(event.messageId);
      runningAssistantMessages.delete(event.messageId);
      if (liveAssistantMessageId.value === event.messageId) liveAssistantMessageId.value = null;
      pendingImageRefs.delete(event.messageId);
      if (!uiMessage) break;
      // 压缩中断结算（引擎 finalize 已对 record.parts 做同一收敛）
      settlePendingCompactionParts(uiMessage.parts, t('sidepanel.chat.compactionInterrupted'));
      const index = messages.value.findIndex(msg => msg.id === event.messageId);
      if (index === -1) break;
      const contentText = typeof uiMessage.content === 'string' ? uiMessage.content : '';
      // 可见内容判定：正文 / 思考 / 工具调用 / **截图片段**——只截了屏还
      // 没来得及说话就被中止的轮次，截图本身就是这一轮唯一的产出，
      // 移除消息等于把它连同记录一起丢掉
      const hasVisibleContent = hasVisibleLiveContent({
        content: contentText,
        reasoningContent: uiMessage.reasoning_content,
        toolCallCount: uiMessage.toolCalls.length,
        parts: uiMessage.parts,
      });
      if (!hasVisibleContent) {
        messages.value.splice(index, 1);
        break;
      }
      uiMessage.isThinking = false;
      // 终态收敛（响应式安全写法）：推理片段补齐自动收起（中止可能发生在
      // 任何自动收起时点之前，如纯思考阶段），耗时随同落列表项。运行源已
      // 删除、refreshUiMessage 是空操作，直接以替换列表项的方式写入快照；
      // 先清掉可能滞留的 rAF 刷新缓冲——其中快照不含本次收敛起误覆盖回放的可能
      pendingUiRefresh.delete(event.messageId);
      const settled = messages.value[index];
      messages.value.splice(index, 1, {
        ...settled,
        parts: uiMessage.parts.map(p =>
          p.type === 'reasoning' && !p.userToggled ? { ...p, collapsed: true } : p,
        ),
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      });
      break;
    }
    case 'guard': {
      // 守卫确认经 onLimitReached 回调处理，这里只负责记录
      console.warn(`[Conversation] 触发循环守卫: ${event.kind}`);
      break;
    }
    case 'compaction': {
      // 压缩进度写入直播消息的时间线（与引擎侧 record.parts 双写同一状态，
      // compaction-part 纯函数是两侧共用的唯一实现）。
      // 此前的独立气泡方案已废弃——气泡追加到列表尾部会把流式消息挤成
      // 「已结束」渲染（不再是最后一条 → isLive=false → 大折叠 + 复制/赞/踩
      // 提前出现），且气泡不随记录持久化、不支持展开查看压缩结果。
      isCompacting.value = event.phase === 'start';
      if (event.trigger === 'pre-run') {
        // 发送前压缩发生在助手记录创建之前（无 messageId）：缓冲结算结果，
        // assistant-start 时种子进新消息；引擎侧经 runtime.preRunCompaction
        // 持久化同一数据（载荷形状见 core/types 的 PreRunCompactionPayload）。
        // start 阶段无内容可缓冲（等待 done/failed 覆盖）。
        if (event.phase === 'done') {
          preRunCompactionSeed.set(event.chatId, {
            status: 'success',
            originalTokens: event.originalTokens,
            summaryTokens: event.summaryTokens,
            summary: event.summary,
            durationMs: event.durationMs,
          });
        } else if (event.phase === 'failed') {
          preRunCompactionSeed.set(event.chatId, {
            status: 'error',
            error: event.error,
            durationMs: event.durationMs,
          });
        }
        break;
      }
      // 运行中压缩：直播消息存在（assistant-start 先于任何运行中压缩），
      // 缺失时按异常时序安静跳过——引擎侧 record.parts 已承载同一状态，
      // 终态覆盖与历史重载都会还原压缩行
      const messageId = event.messageId;
      const compactingUi = messageId ? runningAssistantMessages.get(messageId) : undefined;
      if (!messageId || !compactingUi) break;
      if (event.phase === 'start') {
        compactingUi.parts = pushCompactionPart(compactingUi.parts, {
          trigger: 'runtime',
          originalTokens: event.originalTokens,
        });
      } else if (event.phase === 'done') {
        settleCompactionPart(compactingUi.parts, {
          status: 'success',
          originalTokens: event.originalTokens,
          summaryTokens: event.summaryTokens,
          summary: event.summary,
          durationMs: event.durationMs,
        });
      } else {
        settleCompactionPart(compactingUi.parts, { status: 'error', error: event.error, durationMs: event.durationMs });
      }
      refreshUiMessage(messageId);
      break;
    }
    case 'context-usage': {
      // 引擎每轮真实测量的全量上下文用量（含运行中工具结果与压缩后复测）：
      // 普通对话与学习/验证共用同一事件源，环上数字恒等于「最近一次请求的
      // 真实负载」。学习运行期间底部工具栏隐藏，同一数据经 learn.contextUsage
      // 在学习状态条呈现——两处展示口径不可能漂移。
      contextUsage.value = event.usage;
      break;
    }
  }
};

/**
 * 记录 → UI 消息的元数据映射（耗时 / 反馈）。
 * 历史加载（recordToUiMessage）与运行终态（assistant-complete 覆盖）共用，
 * 保证同一记录在两条路径上得出完全一致的 UI 口径。
 *
 * 防御：usage 存在但 durationMs 缺失/非数（脏数据、跨版本写入）一律不映射，
 * 渲染层按 undefined 隐藏耗时，绝不把 NaN 传到展示链路。
 */
const recordMetaOf = (
  record: ChatMessageRecord,
): Pick<ExtendedChatMessage, 'durationMs' | 'feedback' | 'toolRounds' | 'completionStatus'> => ({
  ...(typeof record.usage?.durationMs === 'number'
    ? { durationMs: record.usage.durationMs }
    : {}),
  toolRounds: record.usage?.toolRounds,
  completionStatus: record.status,
  ...(record.feedback ? { feedback: record.feedback } : {}),
});

/**
 * 会话内助手记录持有的全部图片引用（用于旧记录的用户上传反推）。
 *
 * 引擎注入的视口截图必然同时出现在对应的助手记录里（助手消息是它的
 * 展示主体）；旧记录没有 uploadImageRefs 字段，只能靠这个集合把
 * 「用户上传」与「引擎注入的截图」区分开。
 */
const assistantImageRefsOf = (records: readonly ChatMessageRecord[]): Set<string> => {
  const refs = new Set<string>();
  for (const record of records) {
    if (record.role !== 'assistant') continue;
    for (const ref of record.imageRefs ?? []) refs.add(ref);
  }
  return refs;
};

/** ChatMessageRecord（历史会话加载）→ UI 消息 */
const recordToUiMessage = (
  record: ChatMessageRecord,
  assistantImageRefs?: ReadonlySet<string>,
): ExtendedChatMessage => {
  // 关联图片随记录还原，渲染层据此展示图片区。用户消息走 userVisibleImageRefs
  // （只含用户上传）：落库归一化会把 modelMessages 里的 vision 首截图引用并入
  // imageRefs（GC 需要，不可去掉），直接展示会让同一截图在用户气泡底部与
  // 助手内联「查看屏幕」各出现一次——重载会话后尤为明显。
  // 助手消息保持完整 imageRefs（截图是它的合法展示主体）。
  const visibleImageRefs = record.role === 'user'
    ? userVisibleImageRefs(record, assistantImageRefs)
    : [...(record.imageRefs ?? [])];
  return {
    id: record.id,
    role: record.role,
    content: record.content,
    timestamp: record.createdAt,
    parts: record.parts,
    toolCalls: record.toolCalls,
    reasoning_content: record.reasoning,
    // 自动续跑的隐藏用户轮：保留在消息列表中（时效判定需要它占位），
    // 但渲染层按 isIgnore 跳过用户气泡
    ...(record.synthetic ? { isIgnore: true } : {}),
    // 执行时长与反馈随记录还原：耗时展示 / 赞踩状态跨重启持久（缺失 = 旧记录，隐藏展示）
    ...recordMetaOf(record),
    ...(visibleImageRefs.length > 0 ? { imageRefs: visibleImageRefs } : {}),
    // 网页引用随记录还原（气泡引用块的唯一来源；旧记录无此字段 → 不渲染）
    ...(record.pageQuote ? { pageQuote: record.pageQuote } : {}),
  };
};
// Escape 关闭面板后记住被忽略的触发符，直到触发序列中断（输入空格/删除），
// 避免 continues 输入过滤词时面板反复弹开
let dismissedTrigger: '@' | '/' | null = null;
const username = ref('');
const messageTextarea = ref<HTMLTextAreaElement | null>(null);
const isAiResponding = ref(false);

/**
 * 停止进行中（同步中止）。
 *
 * 用户点停止后，必须等**运行真正结算、正在执行的工具被强制中断、其中断结果
 * 写入模型上下文并落库**之后，才允许发送下一条消息——否则新消息会与上一轮
 * 迟到的工具结果交错，破坏上下文结构。期间该标记置位，发送入口据此排队
 * （用户输入保留，不丢弃）。
 */
const isStopping = ref(false);

/** 当前停止流程的收尾 Promise（并发停止复用同一实例；null = 未在停止） */
let stoppingPromise: Promise<void> | null = null;

/**
 * 等待「停止流程」真正结束。
 *
 * 循环而非单次 await：连点停止会让第二次停止排到第一次之后，单次 await 会在
 * 第一次结束时放行——那正是我们要避免的交错窗口。防御分支（无 Promise）避免
 * 理论上不成立的状态造成死等。
 */
const waitForStopSettled = async (): Promise<void> => {
  while (isStopping.value) {
    const pending = stoppingPromise;
    if (!pending) break;
    await pending.catch(() => undefined);
  }
};

// ──── 网站学习（配置 → 学习 → 验证 → 交付管理中心） ────
/**
 * 打开管理中心并定位到技能分区（草稿深链）。
 * 草稿走 chrome.storage 一次性传递（正文可达 15000 字符，进不了 URL），
 * hash 只负责「切到技能分区并触发预填」这一个信号，见 learn-draft-store。
 *
 * 标签页策略沿用 note-nav 的口径：已有 hub 标签则聚焦并更新其 hash
 * （页面监听 hashchange 响应），没有才新建——避免每次交付都堆一个标签。
 * 所有异常就地消化并返回结果：交付是导航性质的操作，失败只需降级提示，
 * 不应产生未处理的 Promise 拒绝，也不该让已写入的草稿随异常丢失语义。
 *
 * 调用方约定：返回 false 时必须给出提示（「没打开」与「打开成功但无草稿」
 * 必须可区分，收尾降级说明与成果兜底重试都靠这个结果分岔）。
 */
const openHubWithHash = async (hash: string): Promise<boolean> => {
  try {
    const pageUrl = chrome.runtime.getURL('hub.html');
    const tabs = await chrome.tabs.query({});
    const existingTab = tabs.find(tab => {
      if (!tab.url) return false;
      try { const url = new URL(tab.url), base = new URL(pageUrl); return url.protocol === base.protocol && url.host === base.host && url.pathname === base.pathname; }
      catch { return false; }
    });

    if (existingTab?.id !== undefined) {
      // 仅更新 hash 传递提示，保留查询参数与已挂载页面，不能刷新清空编辑。
      const target = new URL(existingTab.url!);
      target.hash = hash;
      await chrome.tabs.update(existingTab.id, { url: target.href, active: true });
      return true;
    }
    const created = await chrome.tabs.create({ url: `${pageUrl}${hash}`, active: true });
    return created?.id !== undefined;
  } catch (error) {
    console.warn('[LearnSession] 打开管理中心失败:', error);
    return false;
  }
};

const learn = useLearnSession({
  beginPageGlow: () => conversationEngine.beginLocalPageGlow(),
  observer: handleConversationEvent,
  notify: pushSystemNotice,
  showChat: () => {
    showChatMode.value = true;
  },
  setActiveChat: chatId => {
    // 学习使用新建的独立会话：切换 ID 的同时清空旧会话的展示与运行缓存，
    // 否则新会话的 user-message 会直接追加在上一会话的消息列表后面。
    pendingUiRefresh.clear();
    pendingImageRefs.clear();
    messages.value = [];
    activeSystemPromptSuffix.value = '';
    learnRecoverableDraft.value = null;
    // 会话级 UI 状态复位（运行源 / 直播登记 / 压缩种子与感知 / 用量）
    resetSessionScopedUiState({ clearContextUsage: true });
    isAiResponding.value = false;
    activeChatId.value = chatId;
    // 学习会话刚创建：其补充段此后只承载草稿回放数据（非 LLM 输入），
    // 装配侧必须按「学习会话」口径处理（不写普通 systemPromptSuffix、
    // 装配时置空补充段），否则草稿会被误当提示词拼进 systemPrompt
    activeSessionIsLearn = true;
  },
  setResponding: (chatId, responding) => {
    if (activeChatId.value !== chatId) return;
    isAiResponding.value = responding;
    // 学习路径不经 sendMessage 的统一收尾：阶段运行结束即兜底回落压缩
    // 感知（正常由 done/failed 事件先行复位，此处只兜事件丢失的异常时序）
    if (!responding) isCompacting.value = false;
  },
  requestToolApproval,
  dismissQuestions: chatId => {
    if (activeChatId.value === chatId) dismissConversationQuestions();
  },
  openHub: openHubWithHash,
  t,
});
let messageId = 0;
// 已保存工作流（onMounted 从 chrome.storage 恢复，供后续工作流功能使用）
const workflows = ref<any[]>([]);

/**
 * 取 MCP content 数组中第一个文本块的文字。
 * content 可能缺省（部分工具只返回业务字段），首块也可能是 image 等非文本类型。
 */
const firstTextContent = (
  blocks: readonly { type: string }[] | undefined | null
): string | undefined => {
  const block = blocks?.[0] as { type: string; text?: unknown } | undefined;
  if (!block || block.type !== 'text') return undefined;
  return typeof block.text === 'string' ? block.text : undefined;
};

// 新增：模式切换相关状态（状态存稳定 key，展示文案统一经 i18n 解析，保证语言切换一致）
type ChatMode = 'fast' | 'reasoning' | 'action';
const MODE_LABEL_KEYS: Record<ChatMode, MessageKey> = {
  fast: 'sidepanel.app.modeFast',
  reasoning: 'sidepanel.app.modeReasoning',
  action: 'sidepanel.app.modeAction',
};
const showModeSelector = ref(false);
const currentMode = ref<ChatMode>('fast');
const currentModeLabel = computed(() => t(MODE_LABEL_KEYS[currentMode.value]));

// WebSocket连接管理
const {
  wsConnectionStatus,
  toggleWebSocketConnection,
  initWebSocketListeners,
  checkWebsiteValidationAndConnect,
  cleanupWebSocketListeners,
} = useWebSocket();

// 会话内模型选择器：候选清单与当前生效模型来自模型注册表（跨渠道扁平清单，单一数据源）
// 切换后写回应用设置（activeModelRef），主对话/视觉/一次性 AI 工具随之生效；
// 会话级选择在发送时随 modelRef 落库，历史会话回显各自的选择
const modelOptions = ref<ModelOption[]>([]);
/** 当前生效模型键（modelRefKey；'' = 无可用模型） */
const activeModelKey = ref('');
const showModelSelectorMenu = ref(false);
/** 当前生效模型条目（null = 引用失效或未配置，此时走注册表回落链） */
const activeOption = computed<ModelOption | null>(
  () => modelOptions.value.find(option => option.key === activeModelKey.value) ?? null,
);
/** 当前生效模型展示名（选择器按钮文案） */
const activeChatModel = computed(() => activeOption.value?.label ?? '');
/** 当前生效模型引用（装配 / 会话落库使用；null = 让注册表按回落链解析） */
const activeModelRef = computed<ModelRef | null>(() => activeOption.value?.ref ?? null);

// ==================== 视觉能力守卫（三条交互链路的统一引导） ====================
//
// 需求：模型未声明视觉能力时，涉及图片 / 视觉智能体的操作必须先提示用户。
// 三条链路：上传图片、切换模型、选择智能体。判定口径集中在
// utils/chat/vision-capability-guard（单一事实源），此处只负责：
//   1. 采集三方状态（模型视觉声明 / 图片计数 / 智能体视觉需求）；
//   2. 按场景构造 i18n 文案；
//   3. 弹窗与用户选择的后续动作（含「前往设置」打开渠道与模型分区）。
//
// 用户选择语义（统一）：
//   - 'confirm'   → 执行用户原本的动作（上传 / 切换 / 选中）
//   - 'cancel'    → 放弃该动作，状态保持不变
//   - 'alternate' → 打开「渠道与模型」设置分区（引导用户补齐视觉声明），
//                   并放弃本次动作（设置完成后用户可重新发起）

/** 历史会话中用户上传的图片数量（0 = 无）。
 *  口径：用户消息的 imageRefs 已经过 userVisibleImageRefs 过滤，
 *  只含用户上传图（不含 vision 截图）——只有用户上传图才需要视觉能力。 */
const historyImageCount = computed<number>(() =>
  messages.value.reduce(
    (total, message) =>
      message.role === 'user' ? total + (message.imageRefs?.length ?? 0) : total,
    0,
  ),
);

/** 当前选中的智能体是否需要视觉能力（AgentConfig.vision 存在即需要） */
const selectedAgentRequiresVision = computed<boolean>(() => {
  const name = selectedAgent.value.trim();
  if (!name) return false;
  const agent = agentEngine.get(name) ?? agentEngine.getById(name);
  return agentRequiresVision(agent?.vision);
});

/** 当前选中的智能体展示名（提示文案用） */
const selectedAgentLabel = computed<string>(() => {
  const name = selectedAgent.value.trim();
  if (!name) return '';
  const agent = agentEngine.get(name) ?? agentEngine.getById(name);
  return agent ? displayNameOf(agent) : name;
});

/** 采集三方状态（守卫判定输入） */
const visionGuardContext = (
  overrides: Partial<VisionCapabilityContext> = {},
): VisionCapabilityContext => ({
  modelHasVision: activeOption.value?.vision ?? false,
  modelLabel: activeOption.value?.label ?? '',
  pendingImageCount: pendingAttachments.value.filter(att => att.kind === 'image').length,
  historyImageCount: historyImageCount.value,
  agentHasVision: selectedAgentRequiresVision.value,
  agentLabel: selectedAgentLabel.value,
  ...overrides,
});

/** 按场景构造提示文案（i18n 单一事实源；场景差异在文案而非判定） */
const visionGuardMessage = (
  scenario: VisionGuardScenario,
  context: VisionGuardContext,
): string => {
  // 模型名缺省（未配置 / 引用失效）用既有的「未配置模型」文案，
  // 不新造措辞——避免同一概念在两处表达不一致
  const model = context.modelLabel || t('sidepanel.app.noModelConfigured');
  switch (scenario) {
    case 'upload-image':
      return t('sidepanel.attachments.visionUploadNoVision', { model });
    case 'switch-model': {
      // 上下文说明：图片与视觉智能体按实际存在情况组合，避免堆砌无关提示
      const hasImages = context.imageCount > 0;
      const agent = context.agentLabel || '';
      const contextKey = hasImages && context.agentHasVision
        ? 'sidepanel.attachments.visionSwitchContextBoth'
        : hasImages
          ? 'sidepanel.attachments.visionSwitchContextImages'
          : 'sidepanel.attachments.visionSwitchContextAgent';
      const contextText = t(contextKey, { count: context.imageCount, agent });
      return t('sidepanel.attachments.visionSwitchNoVision', { model, context: contextText });
    }
    case 'select-agent':
      return t('sidepanel.attachments.visionAgentNoVision', {
        model,
        agent: context.agentLabel || t('common.unknown'),
      });
    default:
      return t('sidepanel.attachments.visionUploadNoVision', { model });
  }
};

/** 打开「渠道与模型」设置分区（视觉声明的修正入口） */
const openChannelSettings = (): void => {
  showSettingsModal.value = true;
  settingsInitialSection.value = 'channels';
};

/**
 * 视觉能力引导弹窗（三态结果）。
 *
 * @param scenario 交互场景
 * @param context 三方状态（可覆盖默认值）
 * @returns 用户选择：'confirm' 执行 / 'cancel' 放弃 / 'alternate' 去设置
 */
const requestVisionGuard = async (
  scenario: VisionGuardScenario,
  context: VisionCapabilityContext = visionGuardContext(),
): Promise<AppDialogResult> => {
  const verdict = evaluateVisionGuard(scenario, context, visionGuardMessage);
  if (!verdict.needsWarning) return 'confirm';
  const result = await showAction(
    verdict.message,
    t('sidepanel.attachments.visionGuardTitle'),
    'warn',
    scenario === 'upload-image'
      ? {
          confirmText: t('sidepanel.attachments.visionUploadConfirm'),
          cancelText: t('sidepanel.attachments.visionUploadCancel'),
          alternateText: t('sidepanel.attachments.visionOpenSettings'),
        }
      : scenario === 'switch-model'
        ? {
            confirmText: t('sidepanel.attachments.visionSwitchConfirm'),
            cancelText: t('sidepanel.attachments.visionSwitchCancel'),
          }
        : {
            confirmText: t('sidepanel.attachments.visionAgentConfirm'),
            cancelText: t('sidepanel.attachments.visionAgentCancel'),
          },
  );
  if (result === 'alternate') openChannelSettings();
  return result;
};

// ==================== 附件栏（守卫流程与状态见 composables/use-attachments） ====================
// 图片准入以「当前生效模型」的视觉能力声明为基准，经注入回调保持解耦；
// 压缩等长时操作的进度反馈走系统通知条
const attachmentManager = createAttachmentManager({
  isCurrentModelVision: () => activeOption.value?.vision ?? false,
  notify: message => pushSystemNotice(message),
  // 视觉能力引导：模型无视觉能力时弹三按钮确认（仍然上传 / 取消上传 / 前往设置）
  confirmImageWithoutVision: async modelLabel =>
    requestVisionGuard('upload-image', visionGuardContext({ modelLabel })),
  currentModelLabel: () => activeOption.value?.label ?? '',
});
const pendingAttachments = attachmentManager.attachments;
const deferredSendDrafts = new Map<string, { text: string; attachments: ChatAttachment[] }>();

function restoreSendDraft(chatId: string, text: string, attachments: ChatAttachment[]): void {
  if (activeChatId.value !== chatId) {
    deferredSendDrafts.set(chatId, { text, attachments });
    return;
  }
  if (!userInput.value.trim()) userInput.value = text;
  if (pendingAttachments.value.length === 0) pendingAttachments.value = attachments;
}

// ── 输入区拖拽上传（dragenter/dragleave 计数器：子元素间移动不闪烁） ──
// 仅响应「文件」拖拽（dataTransfer.types 含 Files）；文本选区拖动等
// 其它形态不激活高亮，也不拦截默认行为
const fileDragDepth = ref(0);
const isFileDragging = computed(() => fileDragDepth.value > 0);
const dragHasFiles = (event: DragEvent): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

const onFileDragEnter = (event: DragEvent): void => {
  if (!dragHasFiles(event)) return;
  fileDragDepth.value += 1;
};
const onFileDragOver = (event: DragEvent): void => {
  if (!dragHasFiles(event)) return;
  // preventDefault 是允许 drop 的必要条件（否则浏览器直接打开文件）
  event.preventDefault();
};
const onFileDragLeave = (event: DragEvent): void => {
  if (!dragHasFiles(event)) return;
  fileDragDepth.value = Math.max(0, fileDragDepth.value - 1);
};
const onFileDrop = (event: DragEvent): void => {
  event.preventDefault();
  fileDragDepth.value = 0;
  // 与附件按钮同口径：学习配置/运行期间输入区不可附加文件（学习面板承载全部交互）
  if (learn.isLearnActive.value || learn.isLearnRunning.value) return;
  if (attachmentManager.isAdding.value) return; // 解析/压缩进行中：丢弃本次放置（与选择器入口同口径）
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 0) {
    void attachmentManager.addFiles(files);
  }
};

// ==================== 模型品牌图标映射 ====================
// 规则：模型名（转小写）包含任一关键词即命中对应图标；关键词互不重叠，命中顺序无关
// 覆盖 public/ai 下全部 10 张品牌图标；未命中回退扩展默认图标 icon/96.png
const MODEL_ICON_RULES: ReadonlyArray<{ keywords: readonly string[]; icon: string }> = [
  { keywords: ['chatgpt', 'codex', 'gpt', 'openai'], icon: 'ai/chatgpt.png' },   // OpenAI 系（gpt-4o / codex 等）
  { keywords: ['claude', 'anthropic'], icon: 'ai/claude.png' },                  // Anthropic 系
  { keywords: ['deepseek'], icon: 'ai/deepseek.png' },                           // DeepSeek 系（含 deepseek-r1/v3）
  { keywords: ['doubao', 'seedance'], icon: 'ai/doubao.png' },                   // 字节系（豆包 / 即舞）
  { keywords: ['gemini'], icon: 'ai/gemini.png' },                               // Google Gemini 系
  { keywords: ['glm', 'chatglm', 'zhipu'], icon: 'ai/glm.png' },                 // 智谱系（glm-4.5 / chatglm）
  { keywords: ['mimo'], icon: 'ai/mimo.png' },                                   // 小米 MiMo
  { keywords: ['minimax', 'abab'], icon: 'ai/minimax.png' },                     // MiniMax 系（abab / M1）
  { keywords: ['ollama'], icon: 'ai/ollama.png' },                               // Ollama 本地模型
  { keywords: ['qwen', 'qwq', 'tongyi'], icon: 'ai/qwen.png' },                  // 阿里系（通义千问 / QwQ）
];

/** 未命中任何品牌规则时的兜底图标（扩展默认图标） */
const MODEL_ICON_FALLBACK = 'icon/96.png';

/** 根据模型名取图标 URL（大小写不敏感的包含匹配） */
const getModelIconUrl = (modelName: string): string => {
  const name = (modelName || '').trim().toLowerCase();
  const hit = name
    ? MODEL_ICON_RULES.find(rule => rule.keywords.some(kw => name.includes(kw)))
    : undefined;
  return chrome.runtime.getURL(hit ? hit.icon : MODEL_ICON_FALLBACK);
};

/** 底部栏按钮当前显示的图标（跟随当前生效模型） */
const currentModelIcon = computed(() => getModelIconUrl(activeChatModel.value));

/**
 * 从模型注册表刷新候选清单与当前生效模型。
 * 候选清单直接来自注册表的响应式状态（与可用性判定同源），
 * 此处只负责「当前会话选中了哪个」的收敛逻辑：
 *   当前键仍有效时保持不动（会话内已选择的模型不被设置保存冲掉）；
 *   失效（首装 / 模型被删或禁用）时优先回落全局默认，其次首个可用模型。
 */
const refreshModelOptions = () => {
  modelOptions.value = [...modelRegistry.options];
  const currentValid = modelOptions.value.some(option => option.key === activeModelKey.value);
  if (!currentValid) {
    const globalRef = appSettingsStore.getActiveModelRef();
    const globalKey = globalRef ? modelRefKey(globalRef) : '';
    activeModelKey.value = modelOptions.value.some(option => option.key === globalKey)
      ? globalKey
      : (modelOptions.value[0]?.key ?? '');
  }
};

/** 展开/收起模型下拉菜单 */
const toggleModelSelectorMenu = () => {
  showModelSelectorMenu.value = !showModelSelectorMenu.value;
  // 关闭其他面板
  if (showModelSelectorMenu.value) {
    showModeSelector.value = false;
  }
};

/**
 * 选择会话模型：立即生效并写回应用设置（全局默认引用 activeModelRef）
 * - 当次请求通过 runtime.modelRef 显式传入（不依赖保存时序）
 * - 写回全局默认：新会话、一次性 AI 工具（工作流）随之使用该模型
 * - 视觉能力守卫：目标模型未声明视觉能力，且当前会话存在图片（待发送附件
 *   或历史用户上传图）或已选中视觉智能体时，弹窗二次确认——
 *   「仍然切换」执行切换（附件全部保留，由用户自行处置），
 *   「取消切换」维持当前模型。
 */
const selectChatModel = async (option: ModelOption) => {
  if (!modelOptions.value.some(item => item.key === option.key)) return;

  // 守卫仅在「切到不同模型」时需要：点击当前生效模型视觉状态不变
  if (option.key !== activeModelKey.value && !option.vision) {
    // 守卫异常（弹窗层故障）不得让切换失控：保守按「取消切换」处理并告警，
    // 用户可再次点击重试
    let decision: AppDialogResult = 'cancel';
    try {
      // 上下文默认值即当前会话状态（图片计数 / 已选智能体视觉需求），
      // 此处只需覆盖目标模型的两项
      decision = await requestVisionGuard(
        'switch-model',
        visionGuardContext({ modelHasVision: false, modelLabel: option.label }),
      );
    } catch (error) {
      console.warn('[ModelSelector] 视觉能力守卫异常，取消本次切换:', error);
    }
    showModelSelectorMenu.value = false;
    if (decision !== 'confirm') {
      // 用户取消切换（或选择「前往设置」后放弃本次切换）：维持当前模型
      console.log(`[ModelSelector] 用户取消切换到 ${option.label}，维持当前模型`);
      return;
    }
    console.warn(`[ModelSelector] 用户确认切换到无视觉模型 ${option.label}（附件全部保留）`);
  }

  activeModelKey.value = option.key;
  showModelSelectorMenu.value = false;
  console.log(`[ModelSelector] 切换会话模型: ${option.label} (${option.key})`);
  try {
    const result = await appSettingsStore.save({ activeModelRef: option.ref });
    if (!result.ok) {
      // 校验失败（理论上被前端约束排除）：明示告警，当前会话仍按已选模型生效
      console.warn('[ModelSelector] 默认模型写入校验未通过（当前会话仍生效）:', result.errors);
    }
  } catch (error) {
    // 持久化失败不阻塞当前会话（本次请求已通过参数显式指定模型）
    console.warn('[ModelSelector] 模型切换持久化失败（当前会话仍生效）:', error);
  }
};

// 输入框可用性直接绑定注册表的响应式状态（单一事实源）。
// 任何渠道/设置变更（本上下文保存、跨上下文同步、备份恢复）都会自动刷新，
// 不再需要手动维护一份会与真实配置脱节的镜像 ref。
const isChatInputEnabled = computed(() => modelRegistry.configured);

/** 「未配置」时第一条具体原因的可读文案（空串 = 已配置或无原因可述） */
const apiBlockerHint = computed(() => livenessIssueText(modelRegistry.blockerIssue));

// 设置弹窗状态（统一入口：渠道与模型 / 高级参数 / 备份 / 语音识别；历史分区导航隐藏）
const showSettingsModal = ref(false);
// 设置弹窗打开时定位到的分区（语音「去配置」直达 ASR 页；Deep Search 警告直达已登录网站页，关闭后复位）
const settingsInitialSection = ref<'channels' | 'advanced' | 'asr' | 'websites'>('channels');
/**
 * 设置弹窗内的精确聚焦目标（守卫停止注记「修改设置」→ 高级参数里的轮次上限）。
 * null = 只切分区不聚焦；一次性使用，弹窗关闭即复位。
 */
const settingsFocusTarget = ref<'maxIterations' | null>(null);

/** 关闭设置弹窗并复位初始分区 */
const handleSettingsClose = () => {
  showSettingsModal.value = false;
  settingsInitialSection.value = 'channels';
  settingsFocusTarget.value = null;
  // 学习态模型候选的刷新已由 modelRegistry.subscribe 统一负责
  //（配置变更时自动刷新 configuring / confirming 两个阶段），此处无需重复处理
};

/** 从「语音未配置」提示弹窗跳转到设置弹窗的语音识别分区 */
const openAsrSettingsFromPrompt = () => {
  showAsrPrompt.value = false;
  settingsInitialSection.value = 'asr';
  showSettingsModal.value = true;
};

// Deep Search警告弹窗状态
const showDeepSearchWarning = ref(false);

// 语音录制管理（sendMessage 回调将在定义后绑定）
const voiceRecordingDeps = {
  userInput: userInput,
  sendMessage: async () => { /* 占位，将在 sendMessage 定义后绑定 */ },
};
const {
  showVoiceRecording,
  showAiProcessing,
  isRecording,
  recordingTime,
  maxRecordingTime,
  audioData,
  mediaRecorder,
  recordingTimer,
  showAsrPrompt,
  startVoiceRecording,
  stopVoiceRecording,
  cancelVoiceRecording,
  handleVoiceRecord,
  processAudioToText,
} = useVoiceRecording(voiceRecordingDeps);

// 语音助手模式管理（sendMessage 回调将在定义后绑定）
const voiceAssistantDeps = {
  userInput: userInput,
  sendMessage: async () => { /* 占位，将在 sendMessage 定义后绑定 */ },
  isAiResponding: isAiResponding,
  mediaRecorder: mediaRecorder,
  audioData: audioData,
};
const {
  showVoiceAssistantSettings,
  showVoiceAssistantCard,
  voiceAssistantAutoWake,
  voiceAssistantStatus,
  voiceAssistantConnectedTime,
  voiceAssistantTimer,
  voiceAssistantAudioLevel,
  voiceAssistantListening,
  toggleVoiceAssistantMode,
  confirmVoiceAssistantMode,
  cancelVoiceAssistantMode,
  exitVoiceAssistantMode,
  startVoiceAssistantListening,
  stopVoiceAssistantListening,
  startVoiceAssistantRecording,
  stopVoiceAssistantRecording,
  processVoiceAssistantAudio,
  formatConnectedTime,
  getVoiceAssistantStatusText,
  toggleAutoWake,
} = useVoiceAssistant(voiceAssistantDeps);

// 时段问候保持静态展示，每分钟校准，随语言切换更新。
type GreetingPeriod = 'lateNight' | 'dawn' | 'morning' | 'afternoon' | 'evening';

const GREETING_KEY: Record<GreetingPeriod, MessageKey> = {
  lateNight: 'sidepanel.app.greetingLateNight',
  dawn: 'sidepanel.app.greetingDawn',
  morning: 'sidepanel.app.greetingMorning',
  afternoon: 'sidepanel.app.greetingAfternoon',
  evening: 'sidepanel.app.greetingEvening',
};

// 依据当前小时划分五个问候时段（23–4 深夜 / 4–9 清晨 / 9–13 上午 / 13–17 下午 / 17–23 晚上）
const getGreetingPeriod = (): GreetingPeriod => {
  const hour = new Date().getHours();
  if (hour >= 23 || hour < 4) return 'lateNight';
  if (hour < 9) return 'dawn';
  if (hour < 13) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
};

const greetingPeriod = ref<GreetingPeriod>(getGreetingPeriod());
// 文案经 i18n 解析（key 派发），语言切换后自动跟随
const welcomeSentence = computed<MessageKey>(() => GREETING_KEY[greetingPeriod.value]);

// 侧边栏跨过整点时自动更新问候
let greetingTimer: ReturnType<typeof setInterval> | null = null;

const greetingLogoUrl = chrome.runtime.getURL('logo.png');
const greetingText = computed<string>(() => t(welcomeSentence.value));

// 网页引用状态（待引用 / 已引用）
// - pendingQuote：捕获到页面选区，等待用户点「确认引用」；新的选区会覆盖它。
// - confirmedQuote：用户已确认，原文固定且**不进输入框**；随本轮消息以
//   <page_quote> 信封发给模型（装配见 utils/chat/page-quote.ts）。
//   已引用态下页面再选别的内容不再响应（须先「取消引用」）。
const pendingQuote = ref<PageQuote | null>(null);
const confirmedQuote = ref<PageQuote | null>(null);

/** 确认引用：待引用 → 已引用（原文固定，不写入输入框） */
const confirmPageQuote = () => {
  if (!pendingQuote.value) return;
  confirmedQuote.value = pendingQuote.value;
  pendingQuote.value = null;
};

/** 放弃待引用（尚未确认的选区；用户可改选页面上的其它内容） */
const discardPendingQuote = () => {
  pendingQuote.value = null;
};

/** 取消引用：已引用 → 无引用；此后页面选区恢复响应 */
const cancelConfirmedQuote = () => {
  confirmedQuote.value = null;
};

// 截图相关状态
const capturedImage = ref('');
const showCapturedImage = ref(false);
const isCapturingScreen = ref(false);

// ──── 已登录网站（Deep Search 站点开关） ────
// 状态与持久化在 use-deep-search-sites 模块级单例：与设置弹窗「已登录网站」分区
// 共享同一份启用态（原底部工具栏下拉面板已迁入设置弹窗）；发送装配读 enabledWebsites
const { enabledWebsites } = useDeepSearchSites();

// 智能体配置（经引擎门面读取）
const agents = ref(agentEngine.list());

// 智能体展示文案（随界面语言切换；选中态仍用规范名 agent.name 作为存储键）
const { displayOf, displayNameOf } = useAgentDisplay();

/**
 * 注册表版本号：引擎内部表是普通 Map（非响应式），直接读引擎的计算属性
 * （如选中智能体上下文的可用技能清单）无法感知跨上下文同步；任何注册表
 * 变更（本上下文写入 / hub 跨上下文同步 / 面板开启对账）自增此版本，
 * 作为这些计算属性的显式响应式依赖。
 */
const registryVersion = ref(0);

// ──── @ / 触发符分化与过滤（@=智能体，/=技能） ────
/**
 * 检测输入末尾的触发符：@ 或 /，其后连续非空白字符作为过滤词。
 * 前置字符仅要求「不是 : @ /」：行首、空白后与普通文字后（如「帮我搜索@」）都能唤起，
 * 而 ":" 与连续触发符是 URL/路径的典型片段（如 https://），据此抑制误触发。
 * trigger 显式收窄为 '@' | '/'：正则捕获组只会产出这两个字符，
 * 下游（dismissedTrigger 等）可直接赋值无需再断言。
 */
const activeTrigger = computed<{ trigger: '@' | '/'; query: string } | null>(() => {
  const m = userInput.value.match(/(?:^|[^:@/])([@/])([^@/\s]*)$/);
  if (!m) return null;
  return { trigger: m[1] as '@' | '/', query: m[2].toLowerCase() };
});

/** 分类显示名（分组标题与触发词过滤共用同一解析规则，内置分类走 i18n） */
const categoryLabel = (categoryId: string): string =>
  agentEngine.categoryLabel(categoryId, key => t(key as MessageKey));

/**
 * 智能体面板列表（面板内搜索框按名称/描述/标签/分类名过滤；输入框不再按字过滤）。
 * 匹配用当前语言的展示文案——用户看到什么就搜得到什么。
 *
 * 已停用的智能体（管理中心关闭）不出现在选择列表中：停用即「不可被选中」。
 */
const matchedAgents = computed(() => {
  const enabled = filterEnabledAgents(agents.value);
  if (!showAgentSelector.value) return enabled;
  const q = agentSelectorQuery.value.trim().toLowerCase();
  if (!q) return enabled;
  return enabled.filter(a => {
    const { name, description, tags } = displayOf(a);
    return (
      name.toLowerCase().includes(q) ||
      description.toLowerCase().includes(q) ||
      tags.some(tag => tag.toLowerCase().includes(q)) ||
      categoryLabel(a.category).toLowerCase().includes(q)
    );
  });
});

/**
 * 智能体选择器的扁平条目：分组标题与智能体选项交替排列。
 * 扁平化的价值：selectedAgentIndex 直接作为数组下标参与高亮与键盘导航，
 * 标题项由 selectAgentAtIndex / moveAgentSelection 识别并跳过，无需维护二级索引。
 *
 * 每项带 display（当前语言的展示文案）：界面渲染用 display，
 * 选中仍用 agent.name（存储键，不随语言变化）。
 */
type AgentSelectorItem =
  | { type: 'header'; key: string; label: string }
  | { type: 'agent'; key: string; agent: AgentConfig; display: AgentDisplayText };

const agentSelectorItems = computed<AgentSelectorItem[]>(() =>
  agentEngine.groupForDisplay(matchedAgents.value).flatMap(group => [
    {
      type: 'header' as const,
      key: `category-${group.categoryId}`,
      label: group.labelKey ? t(group.labelKey as MessageKey) : group.categoryId,
    },
    ...group.agents.map(agent => ({
      type: 'agent' as const,
      key: agent.id,
      agent,
      display: displayOf(agent),
    })),
  ]),
);

/** 可被高亮/选中的条目下标集合（排除分组标题） */
const agentOptionIndexes = computed<number[]>(() =>
  agentSelectorItems.value.reduce<number[]>((indexes, item, index) => {
    if (item.type === 'agent') indexes.push(index);
    return indexes;
  }, []),
);

/** 按扁平下标选中（落在分组标题上时忽略） */
const selectAgentAtIndex = (index: number): void => {
  const item = agentSelectorItems.value[index];
  if (item && item.type === 'agent') {
    // 异步（视觉能力守卫可能弹窗）：显式 void 吞掉 Promise，
    // 内部异常已在 selectAgent 内收敛，不会逃逸成未处理拒绝
    void selectAgent(item.agent.plugin ? item.agent.id : item.agent.name);
  }
};

/** 上下移动高亮（自动跳过分组标题，到边界后停住） */
const moveAgentSelection = (delta: 1 | -1): void => {
  const indexes = agentOptionIndexes.value;
  if (indexes.length === 0) {
    selectedAgentIndex.value = 0;
    return;
  }
  const current = indexes.indexOf(selectedAgentIndex.value);
  const nextPosition =
    current === -1
      ? delta === 1
        ? 0
        : indexes.length - 1
      : Math.min(Math.max(current + delta, 0), indexes.length - 1);
  selectedAgentIndex.value = indexes[nextPosition];
};

/**
 * 技能面板可选集合 = 当前智能体在 hub 编辑页**显式关联**的启用技能
 * （声明顺序、按 id 去重；未选智能体 → 空数组，面板呈现「先选智能体」引导）。
 *
 * 与 runtime-builder 的「可用技能」口径刻意不同：面板回答「能选什么」，
 * 装配回答「注入什么」。预选技能经合成 load_skill 轮注入、不受可用清单
 * 限制，但可选范围收敛到智能体关联集——技能与智能体绑定选择，未关联的
 * 技能需先在 hub 智能体编辑页关联（面板底部常驻指引 + 「去关联」直达）。
 */
const selectableSkills = computed<SkillRecord[]>(() => {
  // 引擎读取非响应式：读一次 registryVersion 建立依赖，注册表任何同步后重算
  void registryVersion.value;
  const agent = selectedAgent.value ? agentEngine.get(selectedAgent.value) : null;
  return resolveAgentLinkedSkills(agent?.skills);
});

/** 技能面板过滤列表（面板内搜索框按名称/描述过滤；输入框不再按字过滤） */
const filteredSkills = computed(() => {
  const list = selectableSkills.value;
  if (!showSkillSelector.value) return list;
  const q = skillSelectorQuery.value.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
});

/**
 * 可见列表内重名的技能名（同名是常态）。
 * 重名条目在卡片上补显 id 消歧——两条 name/description 完全相同的行会让
 * 用户无法确定自己选中的是哪一个。
 */
const duplicatedVisibleSkillNames = computed(() => findDuplicateSkillNames(selectableSkills.value));

/** 卡片条目展示名：重名时追加「 · <id>」，其余情况原样展示 */
const skillCardLabel = (skill: SkillRecord): string =>
  duplicatedVisibleSkillNames.value.has(skill.name) ? `${skill.name} · ${skill.id}` : skill.name;

// 过滤列表收缩时钳制高亮索引：高亮必须始终落在某个智能体条目上（不能停在分组标题或越界）
watch(agentSelectorItems, list => {
  const stillValid = list.some(
    (item, index) => index === selectedAgentIndex.value && item.type === 'agent',
  );
  if (!stillValid) selectedAgentIndex.value = agentOptionIndexes.value[0] ?? 0;
});
watch(filteredSkills, list => {
  // 双侧钳制：空列表归 0（绝不留下负下标），越界回到末条——
  // 任一侧失守都会让回车取到 undefined 并在 .id 上抛错
  selectedSkillIndex.value =
    list.length === 0 ? 0 : Math.min(Math.max(selectedSkillIndex.value, 0), list.length - 1);
});
// 卡片内搜索词变化 → 高亮回到首条：否则高亮停在旧下标，回车选中的可能是
// 另一个条目（列表内容已随搜索词整体换血）
watch(agentSelectorQuery, () => {
  selectedAgentIndex.value = agentOptionIndexes.value[0] ?? 0;
});
watch(skillSelectorQuery, () => {
  selectedSkillIndex.value = 0;
});

// 监听AI回答状态变化
watch(isAiResponding, (newValue) => {
  if (!newValue && showVoiceAssistantCard.value) {
    // AI回答完毕，更新语音助手状态
    if (voiceAssistantStatus.value === 'executing') {
      voiceAssistantStatus.value = 'waiting';
      // 如果开启自动唤醒，重新开始监听
      if (voiceAssistantAutoWake.value) {
        startVoiceAssistantListening();
      }
    }
  }
});

// 方法
const toggleToolPanel = () => {
  showToolPanel.value = !showToolPanel.value;
};

const openSettings = () => {
  showSettingsModal.value = true;
};

// 打开内置笔记工作区
const openNotesPage = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('notes.html') });
};

const closeToolPanel = () => {
  showToolPanel.value = false;
};

// Deep Search警告弹窗处理方法
const closeDeepSearchWarning = () => {
  showDeepSearchWarning.value = false;
};

// 设置弹窗处理方法
const handleApiConfigSaved = async () => {
  showSettingsModal.value = false;
  // 重新加载渠道与应用设置，刷新模型选择器。
  // 加载失败时退化为内存态继续（保存已成功，内存即最新），
  // 绝不让弹窗关闭流程因对账读取失败而抛出。
  // 输入框可用性由注册表的响应式状态驱动，无需在此手动赋值。
  try {
    await modelRegistry.load();
  } catch (error) {
    console.warn('[App] 配置保存后对账加载失败（按内存态继续）:', error);
  }
  refreshModelOptions();
  // 模型阈值与生效模型可能已变：上下文预算随之重算（否则环上数字停留在旧阈值）
  void refreshContextUsage();
};

// 检查模型配置并显示/隐藏配置弹窗
const checkApiConfig = async () => {
  const result = await modelRegistry.loadWithResult();
  if (!result.ok) {
    // 加载失败不阻塞启动：按内存态判定（首装/存储故障 = 未配置 → 弹设置）
    console.error('[App] 模型配置加载失败:', result.issues);
  }
  refreshModelOptions();
  // 启动自愈：全局默认引用指向已失效模型时（配置在别处被改）回落到首个可用
  if (modelRegistry.configured) {
    void modelRegistry.healActiveRef().catch(error => {
      console.warn('[App] 默认模型启动自愈失败:', error);
    });
  } else {
    showSettingsModal.value = true;
  }
};

/** Deep Search 警告弹窗「站点设置」：直达设置弹窗的已登录网站分区 */
const goToWebsiteSettings = () => {
  showDeepSearchWarning.value = false;
  settingsInitialSection.value = 'websites';
  showSettingsModal.value = true;
};

const goToAgentSelector = () => {
  showDeepSearchWarning.value = false;
  showAgentSelector.value = true;
};

/**
 * 关闭 @ 卡片并进入「本触发序列内不再弹开」状态。
 * 空态取消按钮与 Escape（输入框 / 卡片内搜索框两条获焦路径）共用同一实现；
 * refocusInput 供「焦点在卡片内」的场景把焦点交还输入框（焦点已在输入框时为无操作）。
 */
const closeAgentSelector = (options: { refocusInput?: boolean } = {}): void => {
  dismissedTrigger = '@';
  showAgentSelector.value = false;
  if (options.refocusInput) messageTextarea.value?.focus();
};

const closeSkillSelector = (options: { refocusInput?: boolean } = {}): void => {
  dismissedTrigger = '/';
  showSkillSelector.value = false;
  if (options.refocusInput) messageTextarea.value?.focus();
};

/**
 * 空匹配提示卡上的取消按钮：关闭面板并忽略当前触发序列
 * （与 Escape 同语义：序列中断前不再弹开，重新输入 @ 或 / 可再次唤起）
 */
const dismissAgentSelector = (): void => closeAgentSelector();
const dismissSkillSelector = (): void => closeSkillSelector();

/**
 * 技能卡片底部「去关联」：直达 hub 智能体管理分区（复用学习交付的标签页策略：
 * 已有 hub 标签则聚焦并更新 hash，没有才新建）。卡片保持展开——hub 保存关联后
 * 经存储同步触发 handleRegistryChange，列表与选中态实时刷新，无需手动重开。
 */
const openAgentSkillLinking = async (): Promise<void> => {
  const opened = await openHubWithHash('#agents');
  if (!opened) toast.error(t('sidepanel.app.openHubFailed'));
};

/**
 * 处理输入变化：@ 唤起智能体卡片，/ 唤起技能卡片。
 *
 * 触发符之后继续打字 = 用户正在输入正文，此时直接收起卡片（而不是按字过滤）
 * ——过滤职责已移交卡片顶部的搜索框（agentSelectorQuery / skillSelectorQuery）。
 * 删回到只剩触发符时卡片重新展开，与「继续输入即收起」互为逆操作。
 */
const handleInputChange = () => {
  const trigger = activeTrigger.value;
  if (!trigger) {
    // 触发序列中断：重置忽略状态并关闭面板
    dismissedTrigger = null;
    showAgentSelector.value = false;
    showSkillSelector.value = false;
  } else if (trigger.trigger === '@') {
    showAgentSelector.value = dismissedTrigger !== '@' && trigger.query.length === 0;
    showSkillSelector.value = false;
    // 面板开启期间每次输入都把高亮复位到首个智能体条目：
    // 其一，分组标题占据下标 0，不复位则「打开即回车」落在标题上无效；
    // 其二，列表收缩时高亮跟随回到顶部（选择器通用交互）
    if (showAgentSelector.value) {
      selectedAgentIndex.value = agentOptionIndexes.value[0] ?? 0;
    }
  } else {
    showSkillSelector.value = dismissedTrigger !== '/' && trigger.query.length === 0;
    showAgentSelector.value = false;
    // 与 @ 卡片对称：每次打开把高亮复位到首条，避免停在上一次的下标上
    //（上一次的下标可能属于一个已经不存在的过滤结果）
    if (showSkillSelector.value) {
      selectedSkillIndex.value = 0;
    }
  }

  // 自动调整textarea高度
  if (messageTextarea.value) {
    messageTextarea.value.style.height = 'auto';
    messageTextarea.value.style.height = messageTextarea.value.scrollHeight + 'px';
  }
};

/**
 * 上下移动技能高亮：空列表时归 0（绝不产生负下标），到边界后停住。
 * 与 moveAgentSelection 对称——两处钳制策略必须一致，否则空态下回车会取到 undefined。
 */
const moveSkillSelection = (delta: 1 | -1): void => {
  const last = filteredSkills.value.length - 1;
  if (last < 0) {
    selectedSkillIndex.value = 0;
    return;
  }
  selectedSkillIndex.value = Math.min(Math.max(selectedSkillIndex.value + delta, 0), last);
};

/** 选中当前高亮技能（列表为空或下标越界时静默忽略，绝不抛错） */
const selectCurrentSkill = (): void => {
  const skill = filteredSkills.value[selectedSkillIndex.value];
  if (skill) selectSkill(skill.id);
};

/**
 * 选择器通用导航键（↑ / ↓ / Escape）：输入框与卡片内搜索框两条获焦路径共用一份实现，
 * 杜绝两处键盘逻辑各自演化。
 * @returns true = 已消费该按键，调用方无需再处理
 */
const handleSelectorNavKey = (event: KeyboardEvent, which: '@' | '/'): boolean => {
  const isOpen = which === '@' ? showAgentSelector.value : showSkillSelector.value;
  if (!isOpen) return false;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (which === '@') moveAgentSelection(1);
    else moveSkillSelection(1);
    return true;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (which === '@') moveAgentSelection(-1);
    else moveSkillSelection(-1);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (which === '@') closeAgentSelector({ refocusInput: true });
    else closeSkillSelector({ refocusInput: true });
    return true;
  }
  return false;
};

// 处理键盘事件（输入框获焦路径）
const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (showAgentSelector.value && agentOptionIndexes.value.length > 0) {
      selectAgentAtIndex(selectedAgentIndex.value);
    } else if (showSkillSelector.value) {
      // 技能面板开启期间回车一律由面板消费：列表非空选中高亮项，空列表
      //（未选智能体 / 无关联技能 / 搜索无果）静默忽略——绝不落入 sendMessage，
      // 否则输入框里残留的触发符「/」会被当作正文发出（与卡片内搜索框
      // 「无条件拦下回车」的口径一致）
      if (filteredSkills.value.length > 0) selectCurrentSkill();
    } else {
      sendMessage();
    }
    return;
  }
  if (handleSelectorNavKey(event, '@')) return;
  handleSelectorNavKey(event, '/');
};

// 处理智能体选择器键盘事件（卡片内搜索框获焦路径；导航键与输入框共用实现）
const handleAgentSelectorKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    // 无条件拦下回车：卡片内输入框不承担提交语义（空列表时也只是不选中）
    event.preventDefault();
    if (agentOptionIndexes.value.length > 0) selectAgentAtIndex(selectedAgentIndex.value);
    return;
  }
  handleSelectorNavKey(event, '@');
};

// 处理技能选择器键盘事件（卡片内搜索框获焦路径；导航键与输入框共用实现）
const handleSkillSelectorKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    selectCurrentSkill();
    return;
  }
  handleSelectorNavKey(event, '/');
};

/** 移除输入末尾的触发符及其后缀（保留触发符之前的全部内容），如 "你好 /" → "你好 "、"你好/bil" → "你好" */
const stripActiveTrigger = () => {
  userInput.value = userInput.value.replace(/[@/][^@/\s]*$/, '');
};

/**
 * 选择智能体（单选，再次选择即切换）
 *
 * 视觉能力守卫：当前模型未声明视觉能力、而所选智能体需要视觉能力时，
 * 弹窗二次确认——「仍然选中」执行选中，「取消选中」维持原选择。
 * 守卫判定用「所选智能体」自身的视觉需求（不是当前已选智能体的）。
 */
const selectAgent = async (agentName: string) => {
  const agent = agentEngine.get(agentName) ?? agentEngine.getById(agentName);
  if (agent && agentRequiresVision(agent.vision)) {
    // 守卫异常（弹窗层故障）不得让选择彻底失败：保守按「维持原选择」处理，
    // 并告警——用户可再次点击重试，绝不静默改变行为
    let decision: AppDialogResult = 'cancel';
    try {
      // 模型两项与默认值一致（当前生效模型）；覆盖的是目标智能体的视觉状态
      decision = await requestVisionGuard(
        'select-agent',
        visionGuardContext({
          agentHasVision: true,
          agentLabel: displayNameOf(agent),
        }),
      );
    } catch (error) {
      console.warn('[AgentSelector] 视觉能力守卫异常，取消本次选择:', error);
      return;
    }
    if (decision !== 'confirm') {
      console.log(`[AgentSelector] 用户取消选中智能体 ${agentName}，维持原选择`);
      return;
    }
    console.warn(`[AgentSelector] 用户确认选中需要视觉能力的智能体 ${agentName}（当前模型无视觉能力）`);
  }
  // 技能选择与智能体绑定：切换到不同智能体时已选技能全部取消——
  // 各智能体的关联集合独立，跨智能体保留选中只会留下「选了但已不可选」的悬挂态；
  // 重复选择当前智能体不视为切换，已选技能保持
  if (selectedAgent.value !== agentName) selectedSkills.value = [];
  selectedAgent.value = agentName;
  stripActiveTrigger();
  dismissedTrigger = null;
  showAgentSelector.value = false;
};

// 选择技能（多选：面板中再次点击已选技能视为取消；值为技能 id）
const selectSkill = (skillId: string) => {
  // 防御：只接受当前智能体关联集合内的技能。面板本身只渲染关联技能，
  // 此处拦截的是竞态（点击瞬间注册表同步换掉关联集）与未来的误用调用
  if (!selectableSkills.value.some(skill => skill.id === skillId)) {
    console.warn(`[SkillSelector] 技能 "${skillId}" 不在当前智能体的关联集合内，忽略本次选择`);
    return;
  }
  const idx = selectedSkills.value.indexOf(skillId);
  if (idx === -1) {
    selectedSkills.value.push(skillId);
  } else {
    selectedSkills.value.splice(idx, 1);
  }
  stripActiveTrigger();
  dismissedTrigger = null;
  showSkillSelector.value = false;
};

// 移除选中的智能体（无智能体即无合法技能选择——与面板「先选智能体再激活技能」同口径）
const removeSelectedAgent = () => {
  selectedAgent.value = '';
  selectedSkills.value = [];
};

// 移除单个选中的技能（徽标上的 ×；入参为技能 id）
const removeSelectedSkill = (skillId: string) => {
  selectedSkills.value = selectedSkills.value.filter(id => id !== skillId);
};

/** 技能 id → 展示名称（技能被删时回落 id 原文，保证徽标不出现空白） */
const skillDisplayName = (skillId: string): string => {
  return skillEngine.get(skillId)?.name ?? skillId;
};

// ==================== 已选智能体/技能胶囊条（工具栏中部；横向滚动 + 渐隐提示 + 展开管理） ====================

/** 胶囊条条目：智能体恒排首位，其后为按选中顺序排列的技能 */
type SelectionStripChip =
  | { kind: 'agent'; key: string; label: string; avatar?: AgentConfig['avatar'] }
  | { kind: 'skill'; key: string; label: string; id: string };

/** 技能胶囊的固定图标 path（闪电；智能体用自身头像） */
const SELECTION_STRIP_SKILL_ICON_PATH = 'M7,2H17L15,9H21L11,22L13,13H6L7,2Z';

/** 胶囊条数据：已选智能体 + 已选技能（技能展示名经 skillDisplayName 解析，被删时回落 id 原文） */
const selectionStripChips = computed<SelectionStripChip[]>(() => {
  const chips: SelectionStripChip[] = [];
  if (selectedAgent.value) {
    // 胶囊标题用当前语言的展示名；key 仍用规范名（存储键，不随语言变化）
    const agent = agentEngine.get(selectedAgent.value);
    chips.push({
      kind: 'agent',
      key: `agent:${selectedAgent.value}`,
      label: agent ? displayNameOf(agent) : selectedAgent.value,
      avatar: agent?.avatar,
    });
  }
  // 已选技能中的重名集合：重名胶囊补显 id，否则两个一模一样的胶囊
  // 会让用户点 × 时无法确定移除的是哪一个
  const duplicatedNames = findDuplicateSkillNames(
    selectedSkills.value
      .map(id => skillEngine.get(id))
      .filter((skill): skill is SkillRecord => !!skill),
  );
  for (const id of selectedSkills.value) {
    const name = skillDisplayName(id);
    chips.push({
      kind: 'skill',
      key: `skill:${id}`,
      label: duplicatedNames.has(name) ? `${name} · ${id}` : name,
      id,
    });
  }
  return chips;
});

/** 胶囊条视口元素（滚动与测量的基准；无选中时胶囊条整体 v-if 卸载，ref 回落 null） */
const selectionStripViewport = ref<HTMLDivElement | null>(null);

/** 单个胶囊的几何缓存（内容坐标系：left/right 由 offsetLeft/offsetWidth 得出） */
interface SelectionStripChipBox {
  left: number;
  right: number;
}

const stripChipBoxes = ref<SelectionStripChipBox[]>([]);
/** 视口宽度 / 内容总宽 / 当前横向滚动偏移（+N 计数与边缘渐隐的判定输入） */
const stripViewportWidth = ref(0);
const stripContentWidth = ref(0);
const stripScrollLeft = ref(0);

/** 视口右缘之外（完全未滚入）的胶囊数：驱动「+N」提示徽标与展开管理入口 */
const selectionStripOverflowCount = computed(() => {
  if (stripViewportWidth.value <= 0) return 0;
  const visibleRight = stripScrollLeft.value + stripViewportWidth.value;
  return stripChipBoxes.value.filter(box => box.left > visibleRight - 1).length;
});

/** 左/右是否还有未滚入的内容（驱动边缘渐隐提示） */
const selectionStripCanScrollLeft = computed(() => stripScrollLeft.value > 1);
const selectionStripCanScrollRight = computed(
  () =>
    stripViewportWidth.value > 0 &&
    stripScrollLeft.value + stripViewportWidth.value < stripContentWidth.value - 1,
);

/**
 * 测量胶囊几何与视口/内容宽度：选中集或视口尺寸变化后调用。
 * 视口 position:relative 使其成为胶囊的 offsetParent——offsetLeft 是布局值，
 * 滚动不改变它，因此一次测量即可支撑后续滚动位的纯数值判定。
 */
const measureSelectionStrip = async (): Promise<void> => {
  await nextTick();
  const viewport = selectionStripViewport.value;
  if (!viewport) {
    stripChipBoxes.value = [];
    stripViewportWidth.value = 0;
    stripContentWidth.value = 0;
    stripScrollLeft.value = 0;
    return;
  }
  stripChipBoxes.value = Array.from(
    viewport.querySelectorAll<HTMLElement>('[data-strip-chip]'),
  ).map(el => ({ left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth }));
  stripViewportWidth.value = viewport.clientWidth;
  stripContentWidth.value = viewport.scrollWidth;
  stripScrollLeft.value = viewport.scrollLeft;
};

/** 滚动位变化 → 只更新偏移量（几何缓存不重测，高频滚动零 DOM 读取） */
const onSelectionStripScroll = (): void => {
  const viewport = selectionStripViewport.value;
  if (viewport) stripScrollLeft.value = viewport.scrollLeft;
};

// 选中集变化（@ 面板选择、徽标移除、注册表同步清理、历史会话回显）→ 重测几何；
// 技能数组是原地变更，join 成字符串作 watch 源保证增删都能触发
watch(
  [selectedAgent, () => selectedSkills.value.join('\u0000')],
  () => {
    void measureSelectionStrip();
  },
);

// 活跃会话变化（历史会话打开 / 新建会话 / 删除重置 / 首次发送建号）→ 同步
// 计划存储的兜底绑定：plan_tool 无执行上下文时按此定位会话，PlanBoard 也随
// activeChatId prop 切换自动回显对应会话的计划（会话级隔离）
watch(activeChatId, chatId => {
  setActivePlanChat(chatId);
});

// 视口尺寸变化（侧栏拖宽/收窄、工具栏按钮显隐）→ 实时重测；胶囊条卸载时断开观察
let selectionStripResizeObserver: ResizeObserver | null = null;
watch(selectionStripViewport, viewport => {
  selectionStripResizeObserver?.disconnect();
  selectionStripResizeObserver = null;
  if (!viewport) return;
  selectionStripResizeObserver = new ResizeObserver(() => {
    void measureSelectionStrip();
  });
  selectionStripResizeObserver.observe(viewport);
});

/** 悬浮态与点击固定态：悬浮「+N」或弹层本体时展开管理；点击「+N」固定，点遮罩任意处解除 */
const selectionStripHovered = ref(false);
const selectionStripPinned = ref(false);

/** 管理弹层是否展示：有选中且（已固定 或 悬浮且存在折叠） */
const showSelectionStripPopover = computed(
  () =>
    selectionStripChips.value.length > 0 &&
    (selectionStripPinned.value ||
      (selectionStripHovered.value && selectionStripOverflowCount.value > 0)),
);

/** 点击「+N」：固定/解除管理弹层（固定期间由全局透明遮罩兜底点击关闭） */
const toggleSelectionStripPin = (): void => {
  selectionStripPinned.value = !selectionStripPinned.value;
};

/** 移除胶囊条/弹层中的单个条目（智能体或技能） */
const removeSelectionStripChip = (chip: SelectionStripChip): void => {
  if (chip.kind === 'agent') removeSelectedAgent();
  else removeSelectedSkill(chip.id);
};

/** 一键清空全部选中（智能体 + 技能） */
const clearAllSelections = (): void => {
  selectedAgent.value = '';
  selectedSkills.value = [];
};

// 全部移除后解除固定态（弹层随空数据消失，固定的遮罩条件不应残留）
watch(selectionStripChips, chips => {
  if (chips.length === 0) selectionStripPinned.value = false;
});


// 刷新技能列表
const refreshSkills = () => {
  skills.value = skillEngine.list();
};

// 刷新智能体列表
const refreshAgents = () => {
  agents.value = agentEngine.list();
};

/**
 * 注册表主动对账：@ / 面板每次开启时调用。
 * 正常路径靠 chrome.storage.onChanged 事件推送（subscribeStorageKey），
 * 此处再补一次同步重读 + 权威源拉取——hub 管理页新增/删除的智能体与技能
 * 在下一次 @ / 唤起时必然可见，事件漏投（极端环境/时序）时依旧最新；
 * 对账若有差异会经引擎 notify → handleRegistryChange 完成列表刷新。
 */
const resyncRegistries = (): void => {
  refreshAgents();
  refreshSkills();
  registryVersion.value += 1;
  void restoreCustomAgentsFromStorage();
  void restoreCustomSkillsFromStorage();
};

watch(showAgentSelector, open => {
  if (open) {
    // 每次打开都从空搜索词开始：残留的过滤词会让卡片「打开即空列表」
    agentSelectorQuery.value = '';
    resyncRegistries();
  }
});
watch(showSkillSelector, open => {
  if (open) {
    skillSelectorQuery.value = '';
    resyncRegistries();
  }
});

// 返回主页（新建会话）
// 运行中拒绝：直接终止会话会丢失进行中的任务与半成品输出——改为弹窗告知，
// 用户可等待任务自然结束，或先用停止按钮手动终止后再新建。
// 学习中同样拒绝：学习会话由编排层独占（草稿、验收报告、会话绑定都在其中），
// 切走会让成果停在半路且界面与后台状态分裂——沿用同一形态的告知弹窗，
// 让用户等待学习完成，或先中断学习后再试。
// force=true 用于内部强制切换（会话被删除等本就需要重建界面的路径），
// 不弹提示也不受守卫拦截。
// 返回是否真正完成切换（false = 被运行中守卫拦截，界面保持原状）
const goHome = async (options?: { force?: boolean }): Promise<boolean> => {
  if (isAiResponding.value) {
    await showAlert(
      t('sidepanel.app.newChatBlockedMessage'),
      t('sidepanel.app.newChatBlockedTitle'),
      'warn',
    );
    return false;
  }

  // 学习运行中（含配置、确认、学习、验证、落盘）：拒绝切换会话。
  // isLearnActive 覆盖除 idle / done 外的全部阶段；done 是交付后的静止态，
  // 此时新建会话是合法的。
  if (!options?.force && learn.isLearnActive.value) {
    const validating = learn.phase.value === 'validating';
    await showAlert(
      t(
        validating
          ? 'sidepanel.learn.newChatBlockedValidatingMessage'
          : 'sidepanel.learn.newChatBlockedMessage',
      ),
      t('sidepanel.learn.newChatBlockedTitle'),
      'warn',
    );
    return false;
  }

  showChatMode.value = false;
  messages.value = [];
  userInput.value = '';
  // 待发送附件属于输入区草稿，随新会话一并清空（尚未提交给任何会话）
  attachmentManager.clearAttachments();
  selectedAgent.value = '';
  showAgentSelector.value = false;
  selectedSkills.value = [];
  showSkillSelector.value = false;
  // 清除会话级 systemPrompt 补充段：新会话从「无补充段」重新开始
  activeSystemPromptSuffix.value = '';
  // 清除从历史会话读回的技能草稿：它只属于那个会话，新会话不该带着旧成果
  learnRecoverableDraft.value = null;
  activeSessionIsLearn = false;
  // 结束当前会话：下次发送将创建新会话（历史会话仍保留在转录库，可从历史抽屉打开）
  activeChatId.value = '';
  // 缓存随之清空，避免已结束会话的记录常驻内存（会话删除场景由 handleSessionDeleted 传入 chatId 精准清理）
  clearSessionContextCache();
  // 会话级 UI 状态复位（运行源 / 直播登记 / 压缩种子与感知 / 用量）
  resetSessionScopedUiState({ clearContextUsage: true });
  return true;
};

// ──── 学习成果兜底（草稿随消息回放） ────

/**
 * 当前会话里可取回的技能草稿（站点学习会话专属）。
 *
 * 来源：learning 段 submit_skill 的提交体随消息持久化在 systemPromptSuffix
 * （见 transcriptEngine.setSystemPromptSuffix 的约束说明），loadHistorySession
 * 读回后存在这里。它只服务「手动创建技能」兜底：正常路径的草稿已随
 * 暂存（chrome.storage）交给管理中心，读回只是冗余副本，绝不自动重复创建。
 *
 * 必须是 ref：它直接驱动模板里的 v-if，用普通变量会导致提示条的显示与
 * 隐藏要等到别处的重渲染才生效（打开会话时兜底条可能迟迟不出现）。
 */
const learnRecoverableDraft = ref<SkillDraft | null>(null);
/** 当前会话是否为站点学习会话（kind 由转录引擎落库；决定补充段的语义与保护策略） */
let activeSessionIsLearn = false;

/** 解析会话补充段里的技能草稿；形态不符（旧会话 / 损坏数据）一律按无草稿处理 */
function parseLearnDraft(raw: string | undefined | null): SkillDraft | null {
  if (!raw || !raw.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as SkillDraft;
    // 与 submit_skill 共用完整校验，损坏的恢复数据不能进入交接队列。
    return asSkillDraft(parsed);
  } catch {
    return null;
  }
}

const retryingLearnDraft = ref(false);
const learnRecoverySource = computed(() => {
  const chatId = activeChatId.value;
  if (!chatId) return null;
  const draft = learn.recovery.value?.chatId === chatId ? learn.recovery.value.draft : learnRecoverableDraft.value;
  return draft ? { chatId, draft } : null;
});
const learnRecoveryState = useLearnRecovery(learnRecoverySource);
function currentLearnRecovery(): SkillDraft | null {
  return learnRecoveryState.visible.value ? learnRecoverySource.value?.draft ?? null : null;
}

function downloadLearnRecovery(): void {
  const draft = currentLearnRecovery();
  if (!draft) return;
  const text = `---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description)}\ncategory: ${JSON.stringify(draft.category)}\ntags: ${JSON.stringify(draft.tags)}\nallowed-tools: ${draft.allowedTools.join(' ')}\n${draft.summary ? `x-learning-summary: ${JSON.stringify(draft.summary)}\n` : ''}---\n\n${draft.body}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${draft.name || 'learning-recovery'}.md`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Retry the same durable receipt; no empty-editor fallback when handoff fails. */
async function retryCreateSkillFromLearn(): Promise<void> {
  if (retryingLearnDraft.value) return;
  const source = learnRecoverySource.value;
  if (!source) return;
  retryingLearnDraft.value = true;
  try {
    if (!await learnRecoveryState.canCreate(source)) {
      if (learnRecoveryState.syncError.value) toast.error(t('sidepanel.learn.recoverySyncFailed'));
      return;
    }
    const saved = await saveLearnDraft(source.draft, source.chatId);
    if (!saved.ok) { toast.error(t('sidepanel.learn.draftSaveDegraded')); return; }
    if (!await learnRecoveryState.canCreate(source)) return;
    const opened = await openHubWithHash(learnDraftHash(saved.id));
    if (!opened) toast.error(t('sidepanel.learn.openHubFailed'));
    else toast.info(t('sidepanel.learn.handoffDone'));
  } finally { retryingLearnDraft.value = false; }
}

// ==================== 历史会话抽屉 ====================

const showHistoryDrawer = ref(false);

/**
 * 从历史抽屉加载会话：切换 activeChatId、重建 UI 消息、回显该会话持久化的
 * 智能体 / 技能 / 模型 / 系统提示词设置，并按回显结果立即重算上下文预算。
 */
const loadHistorySessionData = async (chatId: string) => {
  // 正在回答时先中止当前运行（同步：等工具中断与上下文写入完成再切换）
  if (isAiResponding.value || isStopping.value) {
    await stopAiResponse();
  }
  try {
    const meta = await transcriptEngine.getSession(chatId);
    if (!meta) {
      // 会话已在别处删除（抽屉列表过期）：保持当前界面不变，不切换到不存在的会话
      console.warn(`[App] 会话 ${chatId} 不存在（可能已在别处删除），本次切换取消`);
      showHistoryDrawer.value = false;
      return;
    }
    // 一次读取带回「压缩摘要 + 记录 + systemPrompt 补充段」，与发送时读取的是同一入口
    const effective = await transcriptEngine.getEffectiveContext(chatId);

    activeChatId.value = chatId;
    // 站点学习会话：把会话里持久化的技能草稿（submit_skill 的提交体）读回来。
    // 转录仅提供恢复副本；是否待创建由共享交接回执决定。
    // 已保存或明确忽略的成果不会因为重开历史会话再次显示恢复入口。
    activeSessionIsLearn = meta.kind === 'site-learn';
    learnRecoverableDraft.value = activeSessionIsLearn
      ? parseLearnDraft(effective.systemPromptSuffix)
      : null;
    // 补充段按会话类型分岔：
    //   - 普通会话：落库值就是 LLM 补充段，回填给装配与预算重算；
    //   - 学习会话：库里是草稿回放数据（非 LLM 输入），装配一律用空，
    //     否则草稿 JSON 会被拼进 systemPrompt 污染请求
    activeSystemPromptSuffix.value = activeSessionIsLearn ? '' : effective.systemPromptSuffix;
    // 会话级 UI 状态复位（含压缩感知——压缩事件按 chatId 投递，切到别的会话
    // 后旧会话的 done/failed 会被会话守卫丢弃，不显式复位则新会话的圆环
    // 会永远呼吸在「正在压缩对话记忆…」）
    resetSessionScopedUiState();
    // 旧记录的用户上传反推需要全会话的助手引用集合（一次性计算后逐条映射）
    const assistantRefs = assistantImageRefsOf(effective.records);
    // 展示归一：运行中压缩的 pending 片段可能随 2s 快照落库后进程崩溃，
    // 历史加载时结算为可读的中断说明（零拷贝快路径见 historyDisplayParts；
    // 仍在运行的会话走 attach 的引擎快照，不经此归一）
    messages.value = effective.records.map(record => {
      const ui = recordToUiMessage(record, assistantRefs);
      return { ...ui, parts: historyDisplayParts(ui.parts ?? [], t('sidepanel.chat.compactionInterrupted')) };
    });
    showChatMode.value = messages.value.length > 0;
    showHistoryDrawer.value = false;
    // 切换到的会话与输入区附件草稿无关：清空避免「附件跟着切换」的错位
    attachmentManager.clearAttachments();
    const deferredDraft = deferredSendDrafts.get(chatId);
    if (deferredDraft) {
      deferredSendDrafts.delete(chatId);
      restoreSendDraft(chatId, deferredDraft.text, deferredDraft.attachments);
    }

    // ── 回显该会话最近使用的设置（已不存在/已停用的自动忽略，绝不阻断会话加载）──
    // 智能体回显：优先按稳定 ID 解析（智能体改名后仍能正确回显），
    // ID 失配（智能体已被删除）再按名称兜底；两者皆无则清空选择，绝不阻断会话加载。
    // 展示用解析结果的当前名称，保证标签与最新命名一致
    const boundAgent = agentEngine.resolveRef(meta.agentId, meta.agentName);
    selectedAgent.value = boundAgent ? (boundAgent.plugin ? boundAgent.id : boundAgent.name) : '';
    // 技能回显：历史会话可能存技能 id（v2）或技能名（v1），统一经 getSkillById
    // 三态解析为当前记录，取其 id 存入选中态（停用/已删除的静默剔除）；
    // 并按当前智能体的关联集合过滤（回显口径与面板可选口径一致：未关联的
    // 技能不回显，旧会话在新规则下不制造悬挂选中）；同一技能的多形态引用
    //（id 与名称/模型标识并存）解析后按 id 去重，避免重复胶囊、
    // 选择签名漂移与「取消一次删不干净」的边缘问题
    const linkedIds = new Set(resolveAgentLinkedSkills(boundAgent?.skills).map(skill => skill.id));
    const restoredSkillIds = new Set<string>();
    selectedSkills.value = (Array.isArray(meta.skillNames) ? meta.skillNames : [])
      .map(ref => skillEngine.get(ref))
      .filter((skill): skill is SkillRecord => !!skill && skill.enabled)
      .filter(skill => linkedIds.has(skill.id))
      .filter(skill => {
        if (restoredSkillIds.has(skill.id)) return false;
        restoredSkillIds.add(skill.id);
        return true;
      })
      .map(skill => skill.id);
    // 模型回显：会话存的是稳定引用（渠道 + 模型 id 对）——
    // 引用仍可用时回显该会话的选择；引用已失效（渠道/模型被删除或禁用）时
    // 沿用当前生效模型并给出系统提示，绝不阻断会话加载、也不静默换模型
    const sessionModelRef = normalizeModelRef(meta.modelRef);
    if (sessionModelRef) {
      const sessionKey = modelRefKey(sessionModelRef);
      if (modelOptions.value.some(option => option.key === sessionKey)) {
        activeModelKey.value = sessionKey;
      } else {
        pushSystemNotice(t('sidepanel.channels.sessionModelUnavailable'));
        // 空会话 + 失效引用的极端组合：上面的 showChatMode 判定发生在回显之前，
        // 此处补开，保证提示可见
        showChatMode.value = true;
      }
    }

    storeEffectiveContext(chatId, effective);
    // 回显后的选择即刻反映到上下文预算圆环（与发送时同口径）
    void refreshContextUsage();
  } catch (error) {
    console.warn('[App] 加载历史会话失败:', error);
  }
};

const loadHistorySession = async (chatId: string) => {
  if (isAiResponding.value) stopAiResponse();
  const options = {
    observer: handleConversationEvent,
    onLimitReached: (kind: GuardKind, info: { iterations?: number; minutes?: number; consecutiveFailures?: number }) =>
      new Promise<boolean>(resolve => openGuardConfirm({
        kind,
        count: kind === 'tool-failures' ? info.consecutiveFailures : info.iterations,
        minutes: info.minutes,
      }, resolve)),
    onToolApproval: requestToolApproval,
  };
  await conversationEngine.attach(chatId, options, async snapshot => {
    await loadHistorySessionData(chatId);
    if (activeChatId.value !== chatId) return;
    if (snapshot.record) {
      // Replace a possibly newer disk snapshot with the atomic attach snapshot;
      // buffered events then advance it exactly once, in their original order.
      const record = snapshot.record;
      // 助手记录：保留完整 imageRefs（截图是它的合法展示主体）；
      // 旧记录反推集合只影响用户消息，此处不需要
      const live = recordToUiMessage(record) as RunningAssistantMessage;
      live.parts ??= [];
      live.toolCalls ??= [];
      live.isThinking = !record.content && !record.reasoning && !record.toolCalls.length;
      runningAssistantMessages.set(record.id, live);
      if (snapshot.running) liveAssistantMessageId.value = record.id;
      const index = messages.value.findIndex(message => message.id === record.id);
      if (index < 0) messages.value.push(live);
      else messages.value.splice(index, 1, live);
    }
    isAiResponding.value = snapshot.running;
    isCompacting.value = snapshot.compacting;
    showChatMode.value = snapshot.running || messages.value.length > 0;
  });
};

conversationEngine.onSettled = (chatId, summary, error) => {
  // 发送前压缩缓冲清理：运行已落定，未消费的种子（如引擎准备失败、
  // assistant-start 未发出）不再属于任何消息，防止种进同会话的下一次运行。
  // 清理不设活跃会话门槛——后台会话的种子同样会滞留内存。
  preRunCompactionSeed.delete(chatId);
  if (activeChatId.value !== chatId) return;
  isAiResponding.value = false;
  isCompacting.value = false;
  liveAssistantMessageId.value = null;
  settleGuard(false);
  dismissConversationQuestions();
  if (error && !sendInFlight.value) pushSystemNotice(error);
  if (summary?.contextUsage) contextUsage.value = summary.contextUsage;
  void syncSessionContextCache(chatId);
};

// Remember only within this browser session; a browser restart opens the welcome page.
watch(activeChatId, chatId => {
  void rememberActiveChat(chatId).catch(error => {
    console.warn('[App] 保存当前会话选择失败:', error);
  });
}, { flush: 'sync' });

/**
 * 按「当前会话 + 当前选择」重算上下文预算（输入栏圆环数据）。
 *
 * 触发点：智能体/技能/模型切换、会话切换、API 配置保存（阈值或模型列表变化）。
 * 口径与真实请求完全一致（runtimeBuilder 装配 + measureContextUsage 全量计量），
 * 因此环上数字始终等于「下一次发送将占用的预算」，无需真的发一次消息。
 * 失败（模型未配置/装配异常）置空降级为环空态，绝不抛错打断交互。
 */
let contextUsageRefreshSeq = 0;
const refreshContextUsage = async (options: { force?: boolean } = {}): Promise<void> => {
  // 发送流程会写入「含本轮输入」的更精确用量，并发测量会把环覆盖回旧估算值。
  // force 供发送收尾时使用（那时需要按运行期间被改动的选择重新对齐环上数据）
  if (!options.force && sendInFlight.value) return;
  const token = ++contextUsageRefreshSeq;
  const chatId = activeChatId.value;
  const cached = chatId ? sessionContextCache.get(chatId) : undefined;
  // 已切换会话但其有效上下文尚未载入：本轮跳过，加载完成后的那次调用负责补齐
  if (chatId && !cached) return;

  try {
    const runtime = await runtimeBuilder.build({
      chatId,
      userInput: '',
      agentName: selectedAgent.value || null,
      skillNames: [...selectedSkills.value],
      modelRef: activeModelRef.value,
      systemPromptSuffix: activeSystemPromptSuffix.value,
      priorRecords: cached?.records ?? [],
      contextSummary: cached?.summary || undefined,
      contextSummaryAt: cached?.compactedAt || undefined,
    });
    const usage = measureContextUsage({
      systemPrompt: runtime.systemPrompt,
      toolIds: runtime.advertisedToolIds ?? runtime.toolIds,
      // 合成激活轮同样是「下一次发送将占用的预算」的一部分：
      // 预选技能的 load_skill 正文随会话注入，漏计会让环上数字系统性偏低
      messages: [...runtime.initialContext, ...runtime.activationContext],
      threshold: runtime.model.contextThreshold,
    });
    // 异步间隙防串扰：等待期间选择或会话已变化时丢弃本次结果，由最新一次负责
    if (token !== contextUsageRefreshSeq) return;
    contextUsage.value = usage;
  } catch (error) {
    if (token !== contextUsageRefreshSeq) return;
    console.warn('[App] 上下文预算重算失败:', error);
    contextUsage.value = null;
  }
};

// ──── 选择变化 → 即时刷新上下文预算 ────
// 智能体决定 systemPrompt 与工具集、技能决定预授权工具、模型决定端点与窗口阈值，
// 三者任一变化都会改变下一次发送的预算占用；必须立刻反映在圆环上，
// 否则用户只有真正发送后才能看到切换智能体带来的成本差异。
// 补充段与会话也纳入触发源：前者改变 systemPrompt，后者改变待计量的历史记录。
watch(
  () => [selectionSignature(), activeSystemPromptSuffix.value, activeChatId.value] as const,
  () => {
    void refreshContextUsage();
  },
);

/** 历史抽屉「新会话」：回到主页并新建（运行中被拦截时保持抽屉开启，用户可先处理运行） */
const startNewChatFromDrawer = async () => {
  const switched = await goHome();
  if (switched) showHistoryDrawer.value = false;
};

/** 删除会话时清理其缓存；删除的正是当前活跃会话时重置界面与 activeChatId，防止后续发送产生无会话元信息的孤儿记录 */
const handleSessionDeleted = (chatId: string) => {
  deferredSendDrafts.delete(chatId);
  // 会话已删除：立即中止其仍在进行的运行。否则引擎会跑到自然结束，
  // 期间每 2s 的快照落库全部命中「会话已不存在」丢弃分支并重复告警，
  // 模型也会基于一个用户已放弃的会话继续消耗请求
  if (conversationEngine.isRunning(chatId)) {
    void conversationEngine.abortAndWait(chatId)
      .catch(error => console.warn('中止被删会话的运行失败:', error));
    // 该会话若挂起守卫确认（删除发生在确认期间），同步收敛防止悬停
    settleGuard(false);
  }
  clearSessionContextCache(chatId);
  // 发送前压缩的种子缓冲一并清除：被删会话的 assistant-start 永远不会到达，
  // 残留条目只会在内存里滞留（onSettled 的清理按活跃会话过滤，覆盖不到这里）
  preRunCompactionSeed.delete(chatId);
  // 缓冲区里该会话的首截图引用一并清除（assistant-start 尚未到达的竞态窗口）
  for (const [messageId, entry] of pendingImageRefs) {
    if (entry.chatId === chatId) pendingImageRefs.delete(messageId);
  }
  // 级联清理该会话的计划（会话级隔离：会话不在则计划不留）
  dropPlan(chatId);
  if (chatId === activeChatId.value) {
    // 删掉的正是当前活跃会话。删在学习会话上意味着它的载体已不存在，
    // 让学习继续跑只会产出孤儿记录（且草稿会带着一份已删会话的上下文落库）：
    // 先中止学习并清理草稿，再强制回到主页重建界面（force 绕过新建会话守卫，
    // 这里的切换是删除动作的必然收尾，不是用户主动发起的新建会话）。
    if (learn.isLearnRunning.value) void learn.cleanupSession();
    void goHome({ force: true });
    showHistoryDrawer.value = false;
  }
};

// 新增：模式切换相关方法
const toggleModeSelector = () => {
  showModeSelector.value = !showModeSelector.value;
};

const selectMode = (mode: ChatMode) => {
  currentMode.value = mode;
  showModeSelector.value = false;
  console.log('切换到模式:', mode);
};

// 推理按钮已由会话内模型选择器替换（见 model-select-wrap）

// 关闭所有面板
const closeAllPanels = () => {
  showModeSelector.value = false;
  showModelSelectorMenu.value = false;
  selectionStripPinned.value = false;
};

// 处理容器点击事件
const handleContainerClick = () => {
  // 关闭搜索模式切换菜单与模型选择菜单
  showModeSelector.value = false;
  showModelSelectorMenu.value = false;
  selectionStripPinned.value = false;
};

// 处理文件上传
/** 附件 chip 悬浮提示：文件名 + 提取形态 + 体积/页数（图片含压缩前后体积） */
const attachmentChipTitle = (att: ChatAttachment): string => {
  const kindText =
    att.source === 'workspace'
      ? t('sidepanel.attachments.sourceWorkspace')
      : att.source === 'office'
      ? t('sidepanel.attachments.sourceOffice')
      : att.source === 'image'
        ? t('sidepanel.attachments.sourceImage')
        : t('sidepanel.attachments.sourceText');
  if (att.kind === 'text') {
    return `${att.name}\n${kindText} · ${formatBytes(att.sizeBytes)} · ${att.totalPages ?? '?'} ${t('sidepanel.attachments.pagesUnit')} · ${formatCharsK(att.chars)} ${t('sidepanel.attachments.charsUnit')}`;
  }
  const compressed =
    att.displayBytes !== undefined && att.displayBytes !== att.sizeBytes
      ? ` → ${formatBytes(att.displayBytes)}（${t('sidepanel.attachments.compressedTag')}）`
      : '';
  return `${att.name}\n${kindText} · ${formatBytes(att.sizeBytes)}${compressed}`;
};

/** 附件 chip 元信息：文本类显示页数，图片显示（压缩后）体积 */
const attachmentChipMeta = (att: ChatAttachment): string =>
  att.kind === 'text'
    ? `${att.totalPages ?? '?'} ${t('sidepanel.attachments.pagesUnit')}`
    : formatBytes(att.displayBytes ?? att.sizeBytes);

const handleFileUpload = (event: MouseEvent) => {
  if (attachmentManager.isAdding.value) return;
  const chatId = activeChatId.value;
  const workspaceOnly = event.shiftKey;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length > 0 && activeChatId.value === chatId) {
      void attachmentManager.addFiles(files, workspaceOnly);
    }
  };
  input.click();
};

// 截图相关方法
const handleScreenCapture = async () => {
  try {
    isCapturingScreen.value = true;
    
    // 向当前活动标签页发送截图请求
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'START_SCREEN_CAPTURE' });
    }
  } catch (error) {
    console.error('启动截图失败:', error);
    isCapturingScreen.value = false;
  }
};

const clearCapturedImage = () => {
  capturedImage.value = '';
  showCapturedImage.value = false;
};

// 原有的简单发送消息函数（保留作为备用）
const sendSimpleMessage = () => {
  if (userInput.value.trim()) {
    // 添加用户消息
    messages.value.push({
      id: `msg_${messageId++}`,
      role: 'user',
      content: userInput.value
    });
    
    // 切换到聊天模式
    showChatMode.value = true;
    
    // 模拟AI回复
    setTimeout(() => {
      messages.value.push({
        id: `msg_${messageId++}`,
        role: 'assistant',
        content: t('sidepanel.app.simpleReply', { input: userInput.value })
      });
    }, 1000);
    
    userInput.value = '';
  }
};

// ==================== 停止链路（全阶段可中止） ====================

/**
 * 运行轮次纪元（单调递增）：跨越运行边界的异步交互（停止二次确认弹窗）
 * 的防串扰令牌。每次发送流程进入响应态时 +1；确认弹窗 await 归来后校验
 * 纪元未变，防止「确认的是上一轮运行、执行的却是新一轮运行的停止」。
 */
let runEpoch = 0;

/**
 * 预运行阶段（发送前压缩 → 引擎运行登记前）的中止控制器；null = 无预运行在途。
 * 引擎运行前的间隙（尤其发送前压缩的一次完整 LLM 调用）引擎尚未登记运行，
 * engine.abort 是空操作——此通道补齐该阶段的中止能力。
 */
let preRunAbortController: AbortController | null = null;

/**
 * 停止按钮入口：二次确认（应用内非阻塞弹窗，与全应用弹窗风格统一）。
 * 确认期间任务照常运行；await 归来后校验「同一轮运行仍在进行」——
 * 弹窗期间运行已自然结束（完成/出错/中止）或新一轮已开始时，本次确认
 * 按过期作废，绝不误杀后续运行。
 */
const confirmStopResponse = async (): Promise<void> => {
  if (!isAiResponding.value) return;
  const epochAtPrompt = runEpoch;
  const confirmed = await showConfirm(
    t('sidepanel.chat.stopConfirmMessage'),
    t('sidepanel.chat.stopConfirmTitle'),
    'warn',
    {
      confirmText: t('sidepanel.chat.stopResponding'),
      cancelText: t('common.cancel'),
    },
  );
  if (!confirmed) return;
  if (!isAiResponding.value || epochAtPrompt !== runEpoch) {
    console.info('[Stop] 确认弹窗期间运行状态已变化，本次停止作废');
    return;
  }
  await stopAiResponse();
};

// 中止AI回答函数（对外入口）
//
// 同步语义：停止不是「发个信号就返回」，而是**等真正停下来**才返回——
// 运行级中止 + 强制中断该会话所有正在执行的工具 + 中断结果写入模型上下文并落库。
// isStopping 期间发送入口排队，因此用户的下一条消息绝不会与上一轮交错。
//
// 职责分离：本函数只管**闸门**（并发去重 + 放行），具体的停止动作在
// performStop 里——两者混在一起会让 try/finally 的缩进失真，也难以单测。
const stopAiResponse = async () => {
    // 0. 停止期间锁住发送入口（并发调用复用同一 Promise，只真正走一遍收尾）
    if (isStopping.value) {
      await waitForStopSettled();
      return;
    }
    isStopping.value = true;
    let release!: () => void;
    stoppingPromise = new Promise<void>(resolve => { release = resolve; });

    try {
      await performStop();
    } finally {
      // 放开发送闸门：停止流程已真正完成（运行结算、工具中断、上下文写入、
      // 落库），此后的下一条消息不会再与上一轮交错
      isStopping.value = false;
      stoppingPromise = null;
      release();
    }
};

/**
 * 停止的具体动作（由 stopAiResponse 的闸门调用）。
 *
 * 顺序刻意如此：先让界面立刻回到「可输入」态（1），再收敛各类挂起物
 * （守卫 / 提问 / 审批），再中止预运行与引擎运行，最后做界面清理。
 */
const performStop = async (): Promise<void> => {
    console.log('开始中止AI回答...');

    // 1. 立即设置状态，防止新的请求
    isAiResponding.value = false;

    // 1.5 收敛挂起的守卫确认（若有）：引擎正 await 该 Promise，不收敛会让运行永久悬停
    settleGuard(false);

    // 收敛 interact（含排队询问）及工具审批；停止后不留弹窗和悬挂回调。
    dismissConversationQuestions();

    // 1.8 中止预运行阶段（发送前压缩/装配期）：引擎尚未登记运行，
    // engine.abort 对其无效；压缩的 LLM 请求经该 signal 真正取消，
    // sendMessageInner 捕获后按「用户停止」善后（恢复输入 + 可读提示）
    if (preRunAbortController) {
      const preRun = preRunAbortController;
      preRunAbortController = null;
      try {
        preRun.abort();
      } catch (error) {
        // AbortController.abort 不应抛错；防御性捕获（已 abort 的重复调用也是 no-op）
        console.warn('[Stop] 预运行中止信号触发失败:', error);
      }
    }
    
    // 2. 同步中止：强制中断该会话所有正在执行的工具，并等待其结算、
    //    结果写入模型上下文并落库。resolve 之前 isStopping 保持 true，
    //    发送入口排队——这是「必须真正停了才允许发新消息」的时序闸门。
    if (activeChatId.value) {
      try {
        await conversationEngine.abortAndWait(activeChatId.value);
        console.log('会话已停止，工具已强制中断并结算完毕');
      } catch (error) {
        console.warn('中止会话引擎失败:', error);
      }
    }

    // 3. 移除页面效果
    try {
        console.log('已移除页面发光效果');
    } catch (error) {
        console.warn('移除页面发光效果失败:', error);
    }

    // 4. 移除思考中的消息（仅当它尚无任何可见内容——正文/推理/工具卡片都算
    //    可见：工具执行期间停止时保留消息，用户才能看到哪些调用已执行、
    //    哪些以「用户主动中断」收尾；引擎的 aborted 事件随后会把该消息
    //    的 isThinking 置 false 并按可见内容决定去留）
    try {
        const thinkingIndex = messages.value.findIndex(msg => msg.isThinking);
        if (thinkingIndex !== -1) {
            const thinking = messages.value[thinkingIndex];
            const hasVisibleContent =
                !!(typeof thinking.content === 'string' && thinking.content.trim()) ||
                !!thinking.reasoning_content?.trim() ||
                (thinking.toolCalls?.length ?? 0) > 0;
            if (!hasVisibleContent) {
                messages.value.splice(thinkingIndex, 1);
                console.log('已移除思考中的消息');
            }
        }
    } catch (error) {
        console.warn('移除思考中消息失败:', error);
    }

    // 5. 清理可能的定时器和监听器
    try {
        // 发送消息到content script清理定时器
        const tabs = await new Promise<chrome.tabs.Tab[]>((resolve) => {
            chrome.tabs.query({ active: true, currentWindow: true }, resolve);
        });
        
        if (tabs[0]?.id) {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEANUP_TIMERS' }).catch(() => {
                // 忽略发送失败的错误
            });
        }
    } catch (error) {
        console.warn('清理定时器失败:', error);
    }
    
    console.log('AI回答中止完成');
};

const stripThinkTags = (content: string) => content
  .replace(/<think>[\s\S]*?<\/think>/g, '')
  .replace(/<think>[\s\S]*$/g, '')
  .trim();

const cleanupAssistantMessages = (messageList: ExtendedChatMessage[]): ExtendedChatMessage[] => {
  return messageList
    .map((message: ExtendedChatMessage) => {
      if (message.role !== 'assistant') {
        return message;
      }

      const cleanedParts = (message.parts || [])
        .map((part: MessagePart) => {
          if (part.type !== 'text' || !part.content) {
            return part;
          }

          const cleanedContent = stripThinkTags(part.content);
          if (!cleanedContent) {
            return null;
          }

          return {
            ...part,
            content: cleanedContent,
          };
        })
        .filter((part): part is MessagePart => part !== null);

      const cleanedContent = typeof message.content === 'string'
        ? stripThinkTags(message.content)
        : message.content;

      return {
        ...message,
        content: cleanedContent,
        parts: cleanedParts,
      };
    })
    .filter((message: ExtendedChatMessage) => {
      if (message.role !== 'assistant') {
        return true;
      }

      const hasReasoning = !!message.reasoning_content?.trim();
      const hasTextContent = typeof message.content === 'string'
        ? !!message.content.trim()
        : Array.isArray(message.content)
          ? message.content.length > 0
          : false;
      const hasParts = !!message.parts?.length;
      const hasToolCalls = !!message.toolCalls?.length;

      return hasReasoning || hasTextContent || hasParts || hasToolCalls || message.isThinking;
    });
};

// AI对话相关函数（薄壳：前置交互 + runtime 装配 + 引擎驱动，循环细节见 core/conversation）
// 本轮 LLM 用户消息的构造与计量统一使用 core 导出的 composeLlmUserMessage（与引擎逐字同源）
// 实际流程体；对外入口 sendMessage 另加在途锁包装（见下方定义）
/** Present preparation failures through the same retryable transcript row. */
const reportSendError = async (error: unknown, retry?: ApiErrorRetryRequest): Promise<void> => {
  if (retry && activeChatId.value !== retry.chatId) return;
  const errorBlock = toApiErrorBlock(error);
  if (retry) {
    try {
      const records = await transcriptEngine.loadSessionRecords(retry.chatId);
      if (activeChatId.value !== retry.chatId) return;
      const record = structuredClone(records.at(-1));
      if (record?.id === retry.messageId && record.role === 'assistant' &&
          record.content === retry.content && record.status === 'error' &&
          isResumeTailCurrent(retry.messageId, record.parts.length - 1, retry.content)) {
        record.content += '\n\n' + errorBlock;
        record.parts.push({ type: 'text', content: errorBlock });
        record.status = 'error';
        record.error = errorBlock;
        await transcriptEngine.flush(record);
        if (activeChatId.value !== retry.chatId) return;
        pendingUiRefresh.delete(record.id);
        const index = messages.value.findIndex(message => message.id === record.id);
        if (index !== -1) messages.value.splice(index, 1, recordToUiMessage(record));
        return;
      }
      await showAlert(t('sidepanel.chat.apiErrorRetryExpired'));
      return;
    } catch (persistenceError) {
      console.warn('[Retry] 无法保存准备阶段异常:', persistenceError);
    }
  }
  if (retry && activeChatId.value !== retry.chatId) return;
  messages.value.push({
    id: 'send_err_' + crypto.randomUUID(), role: 'assistant', content: errorBlock,
    timestamp: Date.now(), parts: [{ type: 'text', content: errorBlock }], toolCalls: [],
  });
  showChatMode.value = true;
};

const sendMessageInner = async (
  beginGlow: () => void,
  retry?: ApiErrorRetryRequest,
  guardContinue?: GuardContinueRequest,
  capture?: { text: string; chatId: string },
) => {
    // 恢复类入口（API 错误重试 / 守卫停止继续）共用同一套「不触碰草稿」语义：
    // 用户当前输入、附件与引用一律不读取、不清空、不恢复。
    const isResume = !!retry || !!guardContinue;
    if (capture && capture.chatId !== activeChatId.value) return;
    const submittedText = capture?.text ?? userInput.value;
    console.log(`[SendMessage] 入口触发, isAiResponding=${isAiResponding.value}, input="${userInput.value.trim().substring(0, 50)}", msgCount=${messages.value.length}`);

    // 停止进行中（同步中止）：必须等上一轮真正停下（工具已强制中断、中断结果
    // 已写入模型上下文并落库）才允许发起新一轮，否则新消息会与上一轮迟到的
    // 工具结果交错。排队等待而不是拒绝：用户输入不丢弃，闸门一开即继续发送。
    if (isStopping.value) {
      console.info('[SendMessage] 上一轮正在停止，排队等待其真正结束');
      await waitForStopSettled();
    }
    if (capture && capture.chatId !== activeChatId.value) return;

    // 继续入口的二次闸门：等待停止结束期间用户可能已产生新输出或切换会话。
    // 与点击时同源判定，确保「中断后无任何新操作」这一前提始终成立。
    if (guardContinue) {
      if (
        activeChatId.value !== guardContinue.chatId ||
        !isGuardContinueCurrent(
          guardContinue.messageId,
          guardContinue.partIndex,
          guardContinue.expectedNotice,
        )
      ) {
        await showAlert(t('sidepanel.chat.guardContinueExpired'));
        return;
      }
    }

    // 前置检查：是否已有可用模型（渠道 + 模型齐全）
    if (!modelRegistry.configured) {
      console.warn(`[SendMessage] 尚无可用模型, 弹出配置弹窗`);
      showSettingsModal.value = true;
      return;
    }

    // 附件解析在途（含等待用户确认弹窗）时忽略发送：此刻附件列表尚不稳定，
    // 快照会漏掉正在确认的文件（其将在确认后残留为下一轮草稿），且弹窗期间
    // 输入框仍可回车触发发送——统一在此收敛
    if (!isResume && !capture && attachmentManager.isAdding.value) {
      console.warn(`[SendMessage] 附件解析进行中，忽略本次发送`);
      pushSystemNotice(t('sidepanel.attachments.busyParsing'));
      return;
    }

    // 空输入拦截：用户正文、附件、已确认引用、历史消息四者皆无 → 无可发内容。
    // 已确认引用计入：「只引用一段网页原文、不另写文字」本身是一条完整请求。
    if (!submittedText.trim() && pendingAttachments.value.length === 0 && !confirmedQuote.value && messages.value.length === 0) {
      console.warn(`[SendMessage] 输入为空且无历史消息, 跳过`);
      return;
    }

    // 视觉能力兜底提示：图片附件存在而当前模型未声明视觉能力时，告知本次
    // 请求的图片可能无法被识别——但**不阻断发送**。
    //
    // 口径说明：用户在上传图片时已做过二次确认（「仍然上传 / 取消上传 /
    // 前往设置」），选择放行即表示接受「带图请求会被拒绝」的后果；此处的
    // 提示只覆盖「未经该确认路径」的带图情形（如历史会话恢复的附件、
    // 切换模型后残留的附件），保证后果始终可见，但不重复阻断用户已决断的操作。
    const hasImageAttachment = !isResume && !capture && pendingAttachments.value.some(att => att.kind === 'image');
    if (hasImageAttachment && !(activeOption.value?.vision ?? false)) {
      console.warn(
        `[SendMessage] 当前模型 ${activeChatModel.value || '(未配置)'} 无视觉能力，本次请求携带图片附件（继续发送，由服务端裁决）`,
      );
      pushSystemNotice(
        t('sidepanel.attachments.visionSendNoVision', {
          model: activeChatModel.value || t('sidepanel.app.noModelConfigured'),
          count: pendingAttachments.value.filter(att => att.kind === 'image').length,
        }),
      );
    }

    // 同一会话同时只允许一个运行
    if (activeChatId.value && conversationEngine.isRunning(activeChatId.value)) {
      console.warn(`[SendMessage] 会话 ${activeChatId.value} 已有运行中的任务，忽略本次发送`);
      return;
    }

    // 输入长度限制：单条消息最长 20K 字符（超长粘贴会瞬间占满上下文预算）
    // 恢复类入口不读取用户草稿；继续轮使用固定指令，长度恒安全。
    const inputLength = retry ? 0 : guardContinue ? t('sidepanel.chat.guardContinuePrompt').length : submittedText.length;
    if (inputLength > MAX_USER_INPUT_CHARS) {
      console.warn(`[SendMessage] 输入超长（${inputLength} 字符），拒绝发送`);
      pushSystemNotice(
        t('sidepanel.chat.inputTooLong', { limit: MAX_USER_INPUT_CHARS, current: inputLength }),
      );
      return;
    }

    beginGlow();
    if (!retry) messages.value = cleanupAssistantMessages(messages.value as ExtendedChatMessage[]);

    // --- 1. 默认智能体兜底：新会话首条消息且用户未选智能体时自动选中默认智能体 ---
    // 默认智能体可在设置「高级设置 → 默认智能体」配置（缺省文本通用助手）；
    // 必须先于会话创建与 runtime 装配：选中结果既要写入会话元信息（供后续会话切换回显），
    // 也要进入本次请求的 systemPrompt 与工具集。用户显式选择过则绝不覆盖。
    if (!isResume && !activeChatId.value && !selectedAgent.value.trim()) {
      const defaultAgent = agentEngine.getDefaultSessionAgent();
      if (defaultAgent) {
        selectedAgent.value = defaultAgent.name;
        console.info(`[SendMessage] 未选择智能体，已自动选中默认智能体 "${defaultAgent.name}"`);
        // 视觉能力兜底：默认智能体需要视觉而当前模型未声明视觉能力时告知后果。
        // 系统自动选中路径没有经过用户的显式确认（selectAgent 的守卫不覆盖此处），
        // 与发送兜底同口径——通知不阻断，用户可切换模型或换智能体后重试
        if (agentRequiresVision(defaultAgent.vision) && !(activeOption.value?.vision ?? false)) {
          console.warn(`[SendMessage] 默认智能体 ${defaultAgent.name} 需要视觉能力，当前模型无视觉声明`);
          pushSystemNotice(
            t('sidepanel.attachments.visionDefaultAgentNoVision', {
              agent: displayNameOf(defaultAgent),
              model: activeChatModel.value || t('sidepanel.app.noModelConfigured'),
            }),
          );
        }
      } else {
        console.warn('[SendMessage] 默认智能体不可用，本轮以无智能体模式发送');
      }
    }

    // --- 2. Deep Search 前置交互（保持原有行为：无已开启网站弹窗并保留输入） ---
    // 置于会话创建之前：前置交互不满足时直接返回，不留下 0 条消息的空会话；
    // 同时让 systemPrompt 补充段在写会话元信息时就位，一次落库
    const agentConfig = selectedAgent.value ? agentEngine.get(selectedAgent.value) : null;
    const extraToolIds: string[] = [];
    let systemPromptSuffix = isResume ? activeSystemPromptSuffix.value : '';

    if (agentConfig?.id === 'deep-search') {
      // 已开启站点读共享单例（与设置弹窗「已登录网站」分区同一份状态）。
      // 恢复类入口（重试 / 继续）直接沿用既有会话配置，不再弹前置警告中断流程。
      if (!isResume && enabledWebsites.value.length === 0) {
        showDeepSearchWarning.value = true;
        return;
      }

      // 自动建工作笔记，笔记信息作为提示词后缀注入（不再原地修改智能体共享配置）。
      // 站点清单显式并入后缀：预设提示词要求「platform 只在 <supplementary-context>
      // 列出的已开启站点中选择」——此前清单只写进笔记正文，模型必须先读笔记才能
      // 知道可用平台，属传递断链；此处补齐（笔记正文保留清单供用户查看）
      if (!isResume) {
        try {
          console.log('Deep Search智能体：自动触发 note_tool 创建工作笔记');
          // 经工具执行引擎执行：笔记存储是跨会话共享的写入目标，与后台会话里
          // 正在跑的工具并发写入会交错。这里是「发送前装配」发起的调用，不进
          // 模型上下文（不是模型给出的 tool_call），故以临时轮次排队执行。
          // 会话 id：此刻尚未创建会话时退化为空串（note_tool 不感知会话）。
          const noteChatId = activeChatId.value || '';
          const noteOutcome = await toolExecutionEngine.runSolo({
            chatId: noteChatId,
            call: {
              callId: `deep_search_note_${Date.now().toString(36)}`,
              toolName: 'note_tool',
              rawArgs: {
                action: 'create',
                title: `Deep Search - ${new Date().toLocaleString()}`,
                content: `用户查询: ${submittedText}\n\n搜索时间: ${new Date().toLocaleString()}\n\n已开启的搜索站点: ${enabledWebsites.value.map(site => site.name).join('、')}\n\n---\n\n`,
              },
            },
            timeoutMs: 30_000,
            execute: (call, ctx) =>
              openaiToolsConverter.executeTool(call.toolName, call.rawArgs, {
                chatId: noteChatId,
                signal: ctx.signal,
              }),
          });
          const createNoteResult = noteOutcome.result;
          if (noteOutcome.status === 'success' && createNoteResult && !createNoteResult.isError) {
            const noteInfo = firstTextContent(createNoteResult.content) || '';
            const enabledSiteLine = `已开启的搜索站点（platform_search 的 platform 只能从中选择）：${enabledWebsites.value.map(site => site.platform).join('、')}`;
            systemPromptSuffix = noteInfo ? `${noteInfo}\n${enabledSiteLine}` : enabledSiteLine;
          } else {
            console.error('note_tool 创建笔记失败:', noteOutcome.error ?? createNoteResult);
          }
        } catch (error) {
          console.error('自动触发 note_tool 失败:', error);
        }
      }

      // 按已开启网站动态追加站点工具（单一事实来源：config/deep-search-sites 注册表，
      // 含 scraper 配对校验与未知 id 防御，见该模块注释）
      extraToolIds.push(...resolveDeepSearchToolIds(enabledWebsites.value.map(site => site.id)));
    }

    // --- 3. 会话管理：无活跃 chatId 时新建（历史会话切换由历史抽屉负责） ---
    // DB 故障兜底：IndexedDB 不可用（隐私模式/配额/损坏）时以可读错误落入对话流，
    // 而不是让未处理的 Promise 拒绝静默丢失本次发送
    let effective: EffectiveContext;
    if (capture && capture.chatId !== activeChatId.value) return;
    const preparingChatId = activeChatId.value;
    const preparingDraft = {
      text: isResume ? '' : submittedText,
      attachments: isResume || capture ? [] : [...pendingAttachments.value],
    };
    let runChatId = preparingChatId;
    try {
      if (!preparingChatId) {
        const session = await transcriptEngine.createSession({
          // agentId 是稳定引用（改名不变），恢复会话时优先按它解析；agentName 作为可读别名
          agentId: agentConfig?.id ?? '',
          agentName: selectedAgent.value,
          skillNames: selectedSkills.value,
          modelRef: activeModelRef.value,
          systemPromptSuffix,
        });
        runChatId = session.chatId;
        if (activeChatId.value !== preparingChatId) {
          if (!isResume && !capture) restoreSendDraft(runChatId, preparingDraft.text, preparingDraft.attachments);
          pushSystemNotice(t('sidepanel.chat.sessionSwitchedDraftSaved'));
          return;
        }
        activeChatId.value = runChatId;
      } else {
        // 学习会话的补充段承载草稿回放数据（非 LLM 输入，见 setSystemPromptSuffix），
        // 绝不能被普通发送生成的 systemPromptSuffix 覆盖——那会抹掉成果兜底；
        // 其余字段（智能体/技能/模型）照常回显，与普通会话无异
        await transcriptEngine.updateSessionUsage(runChatId, {
          agentId: agentConfig?.id ?? '',
          agentName: selectedAgent.value,
          skillNames: selectedSkills.value,
          modelRef: activeModelRef.value,
          ...(activeSessionIsLearn ? {} : { systemPromptSuffix }),
        });
      }
      // 有效上下文 = 压缩摘要 + 压缩点之后的记录（用户面转录仍为全量）+ systemPrompt 补充段
      effective = await transcriptEngine.getEffectiveContext(runChatId);
      if (activeChatId.value !== runChatId) {
        if (!isResume && !capture) restoreSendDraft(runChatId, preparingDraft.text, preparingDraft.attachments);
        pushSystemNotice(t('sidepanel.chat.sessionSwitchedDraftSaved'));
        return;
      }
      // 回填 UI 侧补充段：以库里实际落盘的为准（元信息写入静默失败时退回本轮生成值），
      // 保证后续选择变化触发的预算重算与本次请求用的是同一份 systemPrompt。
      // 学习会话除外：库里的补充段是草稿回放数据（非 LLM 输入），带进装配
      // 会污染 systemPrompt；它的兜底读取只发生在 loadHistorySession，装配一律用空
      if (activeSessionIsLearn) {
        activeSystemPromptSuffix.value = '';
      } else {
        activeSystemPromptSuffix.value = effective.systemPromptSuffix || systemPromptSuffix;
      }
      storeEffectiveContext(runChatId, effective);
      if (retry) {
        const lastRecord = effective.records.at(-1);
        if (lastRecord?.id !== retry.messageId || lastRecord.status !== 'error' || lastRecord.content !== retry.content) {
          await showAlert(t('sidepanel.chat.apiErrorRetryExpired'));
          return;
        }
      }
      // 继续入口的**落库层**校验：等待/压缩/装配期间可能已有新记录落库，
      // 与引擎运行开始时的复核同构，先把明显失效的请求挡在用户消息入档之前。
      if (guardContinue) {
        const lastRecord = effective.records.at(-1);
        const parts = lastRecord?.parts ?? [];
        const noticePart = parts[guardContinue.partIndex];
        if (
          lastRecord?.id !== guardContinue.messageId ||
          lastRecord.role !== 'assistant' ||
          lastRecord.status !== 'done' ||
          guardContinue.partIndex !== parts.length - 1 ||
          noticePart?.type !== 'notice' ||
          noticePart.noticeAction !== 'guard-stop' ||
          (noticePart.content ?? '') !== guardContinue.expectedNotice ||
          !lastRecord.content.trimEnd().endsWith(guardContinue.expectedNotice)
        ) {
          await showAlert(t('sidepanel.chat.guardContinueExpired'));
          return;
        }
      }
    } catch (sessionError) {
      console.error('[SendMessage] 会话存取失败:', sessionError);
      if (runChatId && activeChatId.value !== runChatId) {
        if (!isResume && !capture) restoreSendDraft(runChatId, preparingDraft.text, preparingDraft.attachments);
        pushSystemNotice(t('sidepanel.chat.sessionSwitchedDraftSaved'));
        return;
      }
      // 结构化错误卡片（分类徽章 + 完整原始信息 + 一键复制报告）：
      // 与运行期错误的呈现协议完全一致，用户自查与提交 issue 的体验统一
      await reportSendError(sessionError, retry);
      return;
    }

    // 本轮运行归属的会话：后续所有异步间隙（压缩 / 装配 / 请求）一律使用该值，
    // 而不是届时的 activeChatId——用户在这些间隙里切换会话时，
    // 用 activeChatId 会把本轮回复写进错误的会话
    // --- 4. 初始准备（用户消息入档与 UI 展示由引擎 user-message 事件完成） ---
    showAgentSelector.value = false;
    showSkillSelector.value = false;
    showChatMode.value = true;

    // 快照本轮输入与附件后即刻清空输入区（发送失败时按原样恢复，见装配 catch）。
    // 恢复类入口（重试 / 继续）不读取、不清空用户草稿：继续轮使用固定指令，
    // 用户正在编辑的内容必须原样保留。
    const currentInput = guardContinue
      ? t('sidepanel.chat.guardContinuePrompt')
      : retry
        ? ''
        : submittedText;
    const currentAttachments: ChatAttachment[] = isResume || capture ? [] : [...pendingAttachments.value];
    const selectedModel = activeModelRef.value;
    const selectedThreshold = activeOption.value?.contextThreshold ?? CONTEXT_THRESHOLD_DEFAULT;
    const selectedAgentName = selectedAgent.value || null;
    const selectedSkillNames = [...selectedSkills.value];
    // 已确认的网页引用随本轮消息发送：装配层从引用数据派生两路产物——
    // 模型面 <page_quote> 信封（进本轮用户消息）+ 用户面引用块（随消息落库，
    // 气泡据此渲染）。原文不进输入框。快照后即清空（与输入/附件同口径）：
    // 发送失败时按原样恢复（restoreQuote）。
    const currentQuote = isResume || capture ? undefined : confirmedQuote.value ?? undefined;
    if (!isResume && !capture) {
      userInput.value = '';
      attachmentManager.clearAttachments();
      confirmedQuote.value = null;
    }

    /** 发送失败时把已确认引用放回引用条（与输入/附件的回填同口径）。
     *  发送在途期间用户若已主动「取消引用」，不回填——用户的后续决断优先。 */
    const restoreQuote = (): void => {
      if (currentQuote && !confirmedQuote.value) confirmedQuote.value = currentQuote;
    };

    // 附件派生（三条通道，与既有「时间戳只进模型侧」的口径一致）：
    //   - 转录可见摘要标记：并入 userInput 落库（用户能查到本轮带了哪些附件）
    //   - 模型侧 <upload_file> 信封 attachmentPrompt：文本附件注册会话文件库
    //     （8 位短 id + 确定性分页）后只内联第 1 页（预算封顶，见
    //     upload-file-envelope），全文由 read_file 按页续读；信封只进 LLM
    //     请求，转录侧不落信封本体
    //   - 图片附件：data URL 列表走多模态 image_url（模型可见、转录不落库）
    const textAttachmentBlocks = currentAttachments.filter(att => att.kind === 'text');
    const currentUserImages = currentAttachments
      .filter(att => att.kind === 'image' && typeof att.dataUrl === 'string')
      .map(att => att.dataUrl as string);

    console.log(`[SendMessage] 进入主流程, input="${currentInput.substring(0, 50)}", 文本附件 ${textAttachmentBlocks.length} 个, 图片附件 ${currentUserImages.length} 张`);

    if (!isResume && !capture && messageTextarea.value) {
        messageTextarea.value.style.height = 'auto';
    }

    // --- 5. 文件注册 + runtime 装配（systemPrompt XML 分区 + 工具 Set 去重 + 模型配置 + AI 面历史上下文） ---
    // 装配封装为函数：文本附件先注册进会话文件库（分配 8 位短 id + 分页元
    // 信息），再装配 <upload_file> 信封（只内联第 1 页，预算封顶）并构建
    // runtime。注册 / 装配可能抛错（存储不可用 / 智能体被并发删除 / 模型
    // 配置残缺）：此时消息尚未进入引擎，用户输入已在第 4 步被清空——先还原
    // 输入再上抛，由外层 sendMessage 兜底 catch 呈现错误，用户不必为一次
    // 可修复的失败重新敲一遍全文
    const registerFilesAndBuildRuntime = async (): Promise<ConversationRuntime> => {
      const workspacePaths = await importWorkspaceFiles(
        runChatId,
        currentAttachments.flatMap(att => att.rawFile ? [{ id: att.id, file: att.rawFile }] : []),
      );
      const attachmentSummary = currentAttachments.map(att => {
        const label = att.kind === 'image'
          ? `[图片附件] ${att.name}`
          : att.kind === 'text'
            ? `[附件] ${att.name}（共 ${att.totalPages ?? '?'} 页，AI 可按页读取全文）`
            : t('sidepanel.attachments.workspaceAttachment', { name: att.name });
        const path = workspacePaths.get(att.id);
        return path ? `${label}\n${t('sidepanel.attachments.workspacePath', { path: JSON.stringify(path) })}` : label;
      });
      let envelopePrompt = '';
      if (textAttachmentBlocks.length > 0) {
        const envelopeEntries: UploadFileEnvelopeEntry[] = [];
        for (const att of textAttachmentBlocks) {
          const cached = att.previewFile?.chatId === runChatId
            ? await conversationFileStore.get(att.previewFile.id)
            : null;
          const record = cached?.chatId === runChatId ? cached : await conversationFileStore.register(
            runChatId,
            {
              name: att.name,
              ext: att.ext,
              source: att.source === 'office' ? 'office' : 'plain',
              mimeType: att.mimeType,
              sizeBytes: att.sizeBytes,
            },
            att.text ?? '',
          );
          att.previewFile = { chatId: runChatId, id: record.id };
          envelopeEntries.push({
            id: record.id,
            name: record.name,
            ext: record.ext,
            source: record.source,
            totalPages: record.totalPages,
            page1: att.page1 ?? '',
          });
          console.log(`[SendMessage] 文件已注册: ${record.id}（${att.name}，共 ${record.totalPages} 页）`);
        }
        // 信封预览预算按当前生效模型的上下文阈值封顶（与运行链路同源的
        // 模型级阈值；硬兜底仍是发送前的消息体积守卫）
        envelopePrompt = buildUploadFileEnvelope(
          envelopeEntries,
          selectedThreshold,
        );
      }
      return runtimeBuilder.build({
        chatId: runChatId,
        userInput: attachmentSummary.length ? `${currentInput}\n\n${attachmentSummary.join('\n')}` : currentInput,
        userImages: currentUserImages,
        attachmentPrompt: envelopePrompt,
        pageQuote: currentQuote,
        agentName: selectedAgentName,
        skillNames: selectedSkillNames,
        modelRef: selectedModel,
        extraToolIds,
        systemPromptSuffix,
        priorRecords: effective.records,
        contextSummary: effective.summary || undefined,
        contextSummaryAt: effective.compactedAt || undefined,
      });
    };
    let runtime: ConversationRuntime;
    try {
      runtime = await registerFilesAndBuildRuntime();
    } catch (error) {
      if (!isResume && !capture) restoreSendDraft(runChatId, currentInput, currentAttachments);
      restoreQuote();
      if (activeChatId.value !== runChatId) {
        console.warn('[SendMessage] 上一个会话装配失败:', error);
        pushSystemNotice(t('sidepanel.chat.sessionSwitchedDraftSaved'));
        return;
      }
      throw error;
    }
    if (activeChatId.value !== runChatId) {
      if (!isResume && !capture) restoreSendDraft(runChatId, currentInput, currentAttachments);
      restoreQuote();
      pushSystemNotice(t('sidepanel.chat.sessionSwitchedDraftSaved'));
      return;
    }

    // 继续必须以「点击瞬间」的最新应用设置为准（用户可能刚在设置里调大/调小
    // 轮次上限）。runtimeBuilder.build 每次都会读 appSettingsStore；这里再
    // 显式对齐一次，防止未来引入 runtime 缓存/快照后静默沿用旧预算。
    if (guardContinue) {
      const liveMaxIterations = appSettingsStore.get().maxIterations;
      if (Number.isFinite(liveMaxIterations) && liveMaxIterations > 0) {
        runtime.limits = { ...runtime.limits, maxIterations: liveMaxIterations };
      }
    }

    if (retry) {
      const last = messages.value.at(-1);
      if (
        activeChatId.value !== retry.chatId ||
        !isResumeTailCurrent(retry.messageId, (last?.parts?.length ?? 0) - 1, retry.content)
      ) {
        await showAlert(t('sidepanel.chat.apiErrorRetryExpired'));
        return;
      }
      runtime.retryTarget = { messageId: retry.messageId, content: retry.content };
    }
    if (guardContinue) {
      if (
        activeChatId.value !== guardContinue.chatId ||
        !isGuardContinueCurrent(
          guardContinue.messageId,
          guardContinue.partIndex,
          guardContinue.expectedNotice,
        )
      ) {
        await showAlert(t('sidepanel.chat.guardContinueExpired'));
        return;
      }
      runtime.hiddenUserInput = true;
      runtime.guardContinueTarget = {
        messageId: guardContinue.messageId,
        partIndex: guardContinue.partIndex,
        expectedNotice: guardContinue.expectedNotice,
      };
    }

    // --- 6. 上下文用量测量（全量口径）；发送前压缩由后台统一执行 ---
    // 本轮用户消息按真实请求口径计量（正文 + <upload_file> 信封 + 系统注入
    // 上下文 <system_context> + 图片体积，与引擎构造的 LLM 消息逐字同源，
    // 图片按固定 token 计量）；激活网页取发送时刻标签页，与引擎侧各自取值
    //（时间戳本就逐调用取当前时刻，允许亚秒级差异）
    const activePage = await queryActivePageInfo();
    const measureCurrent = () =>
      measureContextUsage({
        systemPrompt: runtime.systemPrompt,
        toolIds: runtime.advertisedToolIds ?? runtime.toolIds,
        messages: [
          // 与引擎组装顺序逐字同源：初始上下文 → 本轮用户消息 → 合成激活轮
          ...runtime.initialContext,
          ...(runtime.userInput || runtime.attachmentPrompt || runtime.pageQuotePrompt || runtime.userImages.length > 0
            ? [composeLlmUserMessage(runtime.userInput, runtime.attachmentPrompt, runtime.userImages, runtime.pageQuotePrompt, false, activePage)]
            : []),
          ...runtime.activationContext,
        ],
        threshold: runtime.model.contextThreshold,
      });
    contextUsage.value = measureCurrent();

    // --- 6.5 当前消息体积防御：本轮用户消息的 token 估算超过「阈值 − systemPrompt」
    // 时，ContextWindowGuard 的从新到旧保留策略会把它整组丢弃——模型将收不到
    // 当前消息。此处前置拦截：还原输入与附件并明确告知。计量与窗口守卫同用
    // token-estimate（图片按固定 1200 token/张，与 base64 体积解耦）---
    {
      const currentUserMessage = composeLlmUserMessage(
        runtime.userInput,
        runtime.attachmentPrompt,
        runtime.userImages,
        runtime.pageQuotePrompt,
        false,
        activePage,
      );
      const messageTokens = estimateMessageTokens(currentUserMessage);
      const systemTokens = estimateTextTokens(runtime.systemPrompt);
      // 装配层已将 contextThreshold 钳制为有限正数，此处可直接参与运算
      const availableBudget = Math.max(0, runtime.model.contextThreshold - systemTokens);
      if (messageTokens > availableBudget) {
        console.warn(
          `[SendMessage] 本轮消息体积 ${messageTokens} token 超过可用预算 ${availableBudget} token（阈值−systemPrompt），阻断发送`,
        );
        if (!isResume && !capture) restoreSendDraft(runChatId, currentInput, currentAttachments);
        restoreQuote();
        await showAlert(
          t('sidepanel.attachments.messageExceedsContext', {
            size: formatTokensK(messageTokens),
            budget: formatTokensK(availableBudget),
          }),
          t('sidepanel.attachments.promptTitle'),
          'warn',
        );
        return;
      }
    }

    // --- 6.8 提前展示响应态；后台中止通道同时覆盖压缩与会话循环 ---
    // 本地 controller 只记录停止意图，供发送入口的异常/输入恢复路径判定。
    const preRunAbort = new AbortController();
    preRunAbortController = preRunAbort;
    runEpoch += 1;
    // 记录本轮运行时的选择签名：运行结束后用于判定「用户是否在运行期间换了智能体/技能/模型」
    const runSelectionKey = selectionSignature();
    isAiResponding.value = true;

    /** 预运行阶段（用户消息尚未入档）被停止的善后：恢复输入附件并给出可读提示 */
    const settlePreRunStop = (): void => {
      // 输入框为空才回填原输入：用户在间隙里已敲了新内容时，以他们正在编辑的内容为准
      if (!isResume && !capture) restoreSendDraft(runChatId, currentInput, currentAttachments);
      restoreQuote();
      // 会话已切换时通知不落入新会话视图（被停止的是旧会话的发送流程，
      // 与引擎事件流的 chatId 守卫同语义）
      if (activeChatId.value === runChatId) {
        pushSystemNotice(t('sidepanel.chat.stoppedByUser'));
      }
    };

    try {
      // 发送前压缩由后台执行；关闭侧边栏不会中断这次模型请求。
      console.log(`[SendMessage] runtime 装配完成, 可用工具: [${runtime.toolIds.join(', ')}], agent: ${agentConfig?.id || 'default'}, 模型: ${runtime.model.model}, 历史消息: ${runtime.initialContext.length} 条`);

      // --- 7. 引擎驱动（「思考中」占位由 assistant-start 事件创建） ---
      try {
        const summary = await conversationEngine.run(runtime, {
          observer: handleConversationEvent,
          // 循环守卫确认：应用内非阻塞确认条（60s 未确认自动停止），
          // 停止按钮 / 会话切换 / 倒计时归零均按停止收敛——取代阻塞线程的 window.confirm
          onLimitReached: (kind, info) =>
            new Promise<boolean>(resolve => {
              openGuardConfirm(
                {
                  kind,
                  count:
                    kind === 'max-iterations'
                      ? (info.iterations ?? runtime.limits.maxIterations)
                      : kind === 'tool-failures'
                        ? (info.consecutiveFailures ?? 0)
                        : undefined,
                  minutes:
                    kind === 'max-duration'
                      ? (info.minutes ?? Math.round(runtime.limits.maxDurationMs / 60000))
                      : undefined,
                },
                resolve,
              );
            }),
          // 工具审批：破坏性/不可逆工具（如 delete_note）执行前的用户放行。
          // 弹窗 + 60s 超时自动拒绝（安全侧：无人值守不执行破坏性操作）；
          // 拒绝结果以可控失败回传模型，模型可说明意图或换路径
          onToolApproval: request =>
            requestToolApproval(request),
        });
        // 引擎侧测量的是最后一次真实请求的全量上下文（含本轮用户消息与工具结果），
        // 比发送前估算更接近现状，优先回填到环上
        if (summary.contextUsage) contextUsage.value = summary.contextUsage;
        console.log(`[SendMessage] 会话运行结束: status=${summary.status}, 轮数=${summary.iterations}, 耗时=${summary.durationMs}ms, 压缩=${summary.compactions}次`);
      } catch (engineError) {
        if (engineError instanceof Error && engineError.message === API_ERROR_RETRY_EXPIRED) {
          await showAlert(t('sidepanel.chat.apiErrorRetryExpired'));
          return;
        }
        // 引擎复核发现继续目标已过期（等待期间已有新输出落库）：不落任何记录，
        // 仅给出与重试失效同口径的提示
        if (engineError instanceof Error && engineError.message === API_ERROR_CONTINUE_EXPIRED) {
          await showAlert(t('sidepanel.chat.guardContinueExpired'));
          return;
        }
        // 用户停止在引擎内已按 aborted 语义收尾并经事件流呈现（不抛出到此）；
        // 到达此处的中止伴随异常只可能是引擎准备阶段抛出（用户消息可能已入档）——
        // 按停止语义善后而非错误卡片，且不恢复输入（避免与已入档消息重复）
        if (preRunAbort.signal.aborted) {
          console.info('[SendMessage] 用户在引擎准备阶段停止，本轮中止:', engineError);
          return;
        }
        // 防御：引擎级异常（并发冲突/空输入校验等通常已被上游拦截，到达此处属非典型失败）
        // 以结构化错误卡片落入对话流（与运行期错误呈现协议一致），避免未处理的 Promise 拒绝
        console.error('[SendMessage] 会话引擎异常:', engineError);
        await reportSendError(engineError, retry);
      }
    } catch (preRunError) {
      // 预运行兜底：压缩 / 装配段之外未预料的异常若伴随用户停止，按停止善后；
      // 其余原样上抛，由外层 sendMessage 包装层以结构化错误卡片呈现
      if (preRunAbort.signal.aborted) {
        console.info('[SendMessage] 用户在预运行阶段停止:', preRunError);
        settlePreRunStop();
        return;
      }
      throw preRunError;
    } finally {
      // ── 响应态与运行资源的统一收尾（6.8 提前建立的都在此回落）──
      // 错误与中止已通过事件流 / 通知呈现；finally 单出口保证任意路径
      // （自然完成 / 出错 / 用户停止 / 会话切换）都完整清理
      if (preRunAbortController === preRunAbort) preRunAbortController = null;
      isAiResponding.value = false;
      // 压缩感知兜底回落：正常路径由 done/failed 事件复位；此处兜住「事件
      // 丢失」的异常时序（如通道在压缩进行中断裂），绝不让呼吸动画悬停
      isCompacting.value = false;
      // 本轮新增记录已落库（引擎 finalize 内 await flush），同步进缓存：
      // 之后切换智能体/技能/模型重算预算时，读到的是含本轮结果的真实历史
      await syncSessionContextCache(runChatId);
      // 运行期间用户改动了选择：环上仍是本轮运行的用量，按最新选择重算，
      // 避免「标签已是新智能体、圆环却还是旧智能体的用量」的错位
      if (selectionSignature() !== runSelectionKey) {
        void refreshContextUsage({ force: true });
      }
      console.log("对话流程结束。");
    }
};

/**
 * 发送入口（在途锁包装）：sendMessageInner 的前置阶段（会话建立、Deep Search
 * 前置交互、发送前上下文压缩）是数秒级异步过程且引擎尚未登记运行——此前的
 * isRunning 防线不生效，两次快速触发会并发执行双压缩与冲突写入。
 * 在途锁保证同一时刻最多一次发送流程；后续轮次由引擎自身的 ChatBusyError 兜底。
 */
const sendInFlight = ref(false);
const executeSend = async (retry?: ApiErrorRetryRequest, guardContinue?: GuardContinueRequest, capture?: { text: string; chatId: string }) => {
  if (sendInFlight.value) {
    console.warn('[SendMessage] 已有发送流程在途，忽略本次触发');
    return;
  }
  sendInFlight.value = true;
  let endPreparingGlow: (() => void) | undefined;
  try {
    await sendMessageInner(
      () => { endPreparingGlow = conversationEngine.beginPreparingGlow(); },
      retry,
      guardContinue,
      capture,
    );
  } catch (error) {
    // 兜底呈现：主流程内的分段异常（会话存取 / 压缩 / 引擎驱动）各有针对性
    // catch，到达此处的是装配、测量等未分段异常（如智能体被并发删除、
    // 模型配置残缺触发的 runtime 装配抛错）——以结构化错误卡片落入对话流
    // （完整原始信息 + 一键复制报告），而不是变成无用户反馈的未处理 Promise 拒绝
    console.error('[SendMessage] 发送流程异常:', error);
    await reportSendError(error, retry);
  } finally {
    endPreparingGlow?.();
    sendInFlight.value = false;
  }
};

// UI callbacks accept no retry payload (Vue may pass a DOM event).
const sendMessage = async () => executeSend();
const createSkillFromPractice = async (request: { messageId: string; extra: string }) => {
  const chatId = activeChatId.value;
  if (!chatId || isAiResponding.value || sendInFlight.value || !messages.value.some(message => message.id === request.messageId && message.role === 'assistant')) return;
  const extra = request.extra.trim().slice(0, 3000);
  const text = t('sidepanel.chat.skillCaptureUserMessage') + (extra ? '\n\n' + t('sidepanel.chat.skillCaptureExtraPrefix') + '\n' + extra : '');
  await executeSend(undefined, undefined, { chatId, text });
};

// 绑定语音录制 composable 的 sendMessage 回调
voiceRecordingDeps.sendMessage = sendMessage;
// 绑定语音助手 composable 的 sendMessage 回调
voiceAssistantDeps.sendMessage = sendMessage;

/**
 * 统一恢复时效判定（API 错误重试 / 守卫停止继续共用）。
 *
 * 只有同时满足以下条件才允许恢复：
 *  1. 目标消息仍是当前时间线的最后一条（任何后续用户消息、模型输出或系统
 *     注记都会使其失效——隐藏的自动续跑轮同样在 messages 中占位）；
 *  2. 目标消息是助手消息（流式占位不会被误判为可恢复）；
 *  3. 目标片段是 parts 的最后一段（后补任何片段即失效）；
 *  4. expectedText 恰好是消息正文的结尾（正文追加任何输出即失效）。
 *
 * 这里只做纯 UI 视图判定；引擎在运行开始时还会按最新落库记录复核一次。
 */
const isResumeTailCurrent = (messageId: string, partIndex: number, expectedText: string): boolean => {
  if (!messageId || partIndex < 0 || !expectedText) return false;
  const last = messages.value.at(-1);
  if (!last || last.id !== messageId || last.role !== 'assistant') return false;
  const parts = last.parts ?? [];
  if (partIndex >= parts.length || partIndex !== parts.length - 1) return false;
  const content = typeof last.content === 'string' ? last.content : '';
  // 正文若确实包含期望文本，则它之后不允许再有内容；若正文因历史快照/展示
  // 归一而缺失该文本，则退回片段层判定（片段是结构化的唯一数据源），
  // 不能因为展示层与记录层的短暂不一致而误判失效。
  const at = content.lastIndexOf(expectedText);
  if (at === -1) return true;
  return content.slice(at + expectedText.length).trim() === '';
};

/**
 * 守卫停止注记的继续资格：必须精确定位到末尾那段可交互 notice。
 *
 * 与重试共享「目标仍是最后一条、之后无任何输出」的语义，但对**展示层**
 * 的漂移更宽容：
 *  - 片段下标因展示过滤（空文本/思考剥离）漂移时，回退为按内容查找；
 *  - 注记之后允许图片 / 压缩等非对话输出片段（迟到截图、压缩状态），
 *    但任何正文、推理、工具调用或新系统注记都视为新的后续输出并失效。
 */
const isGuardContinueCurrent = (
  messageId: string,
  partIndex: number,
  expectedNotice: string,
): boolean => {
  const last = messages.value.at(-1);
  if (!last || last.id !== messageId || last.role !== 'assistant' || last.isSystemNotice) return false;
  const parts = last.parts ?? [];
  const matches = (part: MessagePart | undefined): boolean =>
    part?.type === 'notice' &&
    part.noticeAction === 'guard-stop' &&
    (part.content ?? '') === expectedNotice;
  let index = partIndex;
  if (!matches(parts[index])) index = parts.findIndex(part => matches(part));
  if (index < 0) return false;
  const hasLaterOutput = parts.slice(index + 1).some(part => {
    if (part.type === 'text' || part.type === 'reasoning') return !!(part.content ?? '').trim();
    return part.type === 'tool' || part.type === 'notice';
  });
  if (hasLaterOutput) return false;
  const content = typeof last.content === 'string' ? last.content : '';
  const at = content.lastIndexOf(expectedNotice);
  // 正文若记录了注记，则其后不允许再有输出；未记录时以片段结构为准
  return at === -1 || content.slice(at + expectedNotice.length).trim() === '';
};

const retryFromErrorCard = async (target: ApiErrorRetryTarget): Promise<void> => {
  const last = messages.value.at(-1);
  const parts = last?.parts?.filter(part => part.content?.trim() || part.type !== 'text') ?? [];
  const tail = parts.at(-1);
  const content = typeof last?.content === 'string' ? last.content : '';
  const errors = [...(tail?.content ?? content).matchAll(/<api-error\b[^>]*>[\s\S]*?<\/api-error>/g)];
  const latestError = errors.at(-1)?.[0] ?? '';
  if (!target.messageId || !latestError ||
      target.errorIndex !== errors.length - 1 ||
      !isResumeTailCurrent(target.messageId, target.partIndex, latestError) ||
      (tail && (tail.type !== 'text' || !tail.content?.trimEnd().endsWith(latestError)))) {
    await showAlert(t('sidepanel.chat.apiErrorRetryExpired'));
    return;
  }
  if (isAiResponding.value || sendInFlight.value || isStopping.value) {
    await showAlert(t('sidepanel.chat.apiErrorRetryBusy'));
    return;
  }
  if (activeSessionIsLearn) {
    await showAlert(t('sidepanel.chat.apiErrorRetryLearnBlocked'));
    return;
  }
  if (!activeChatId.value || !messages.value.some(message => message.role === 'user')) {
    await showAlert(t('sidepanel.chat.apiErrorRetryNoContext'));
    return;
  }
  await executeSend({ chatId: activeChatId.value, messageId: target.messageId, content });
};
setApiErrorRetryHandler(retryFromErrorCard);

/**
 * 守卫停止注记的「继续」：与重试完全同构的入口守卫。
 *
 * 通过后原样复用发送主流程，只把用户轮替换为隐藏的「继续」指令；任何新
 * 输出、在途运行、学习态或空上下文都在这里被友好拒绝。
 */
const handleGuardContinue = async (messageId: string, partIndex: number): Promise<void> => {
  const last = messages.value.at(-1);
  const parts = last?.parts ?? [];
  const isGuardNotice = (part: MessagePart | undefined): boolean =>
    part?.type === 'notice' && part.noticeAction === 'guard-stop' && !!part.content;
  // 优先信任点击时携带的原始下标；若因展示层过滤发生漂移，回退到消息内
  // 最后一段守卫注记（同一助手消息最多一条，防御历史脏数据）。后续请求
  // 一律携带**解析后的真实下标**，保证落库层/引擎层定位一致。
  const clicked = parts[partIndex];
  let resolvedIndex = isGuardNotice(clicked) ? partIndex : -1;
  if (resolvedIndex < 0) {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (isGuardNotice(parts[i])) {
        resolvedIndex = i;
        break;
      }
    }
  }
  const expectedNotice = resolvedIndex >= 0 ? (parts[resolvedIndex].content ?? '') : '';
  if (!expectedNotice || !isGuardContinueCurrent(messageId, resolvedIndex, expectedNotice)) {
    await showAlert(t('sidepanel.chat.guardContinueExpired'));
    return;
  }
  if (
    isAiResponding.value ||
    sendInFlight.value ||
    isStopping.value ||
    (!!activeChatId.value && conversationEngine.isRunning(activeChatId.value))
  ) {
    await showAlert(t('sidepanel.chat.guardContinueBusy'));
    return;
  }
  if (activeSessionIsLearn) {
    await showAlert(t('sidepanel.chat.guardContinueLearnBlocked'));
    return;
  }
  if (!activeChatId.value || !messages.value.some(message => message.role === 'user' && !message.isIgnore)) {
    await showAlert(t('sidepanel.chat.guardContinueNoContext'));
    return;
  }
  await executeSend(undefined, {
    chatId: activeChatId.value,
    messageId,
    partIndex: resolvedIndex,
    expectedNotice,
  });
};

/**
 * 守卫停止注记的「修改设置」：直达高级参数并聚焦轮次上限。
 *
 * 时长上限当前不暴露为用户配置项，因此只定位分区；轮次上限则精确聚焦
 * 对应输入，避免用户在长表单里自行寻找。
 */
const handleGuardOpenSettings = (guardKind: MessagePart['guardKind']): void => {
  settingsInitialSection.value = 'advanced';
  settingsFocusTarget.value = guardKind === 'max-iterations' ? 'maxIterations' : null;
  showSettingsModal.value = true;
};

// 工具调用展开/收起功能
// 双写策略：列表项（messages.value 中的副本，立即生效）+ 运行源对象
// （runningAssistantMessages，流式刷新 refreshUiMessage 以源为准替换列表项）。
// 只写副本会被下一次流式刷新覆盖回默认收起——这是"输出中展开详情被强制
// 收起"的根因；同步写源后用户选择在全流期间稳定保持
const toggleToolCallExpansion = (messageId: string, toolCallId: string) => {
  const applyToggle = (toolCall: { expanded?: boolean } | undefined): boolean => {
    if (!toolCall) return false;
    toolCall.expanded = !toolCall.expanded;
    return true;
  };

  const source = runningAssistantMessages.get(messageId);
  if (source) {
    const sourceToolPart = source.parts.find(
      part => part.type === 'tool' && part.toolCall?.id === toolCallId,
    );
    const toggledInSource = applyToggle(sourceToolPart?.toolCall) || applyToggle(source.toolCalls.find(tc => tc.id === toolCallId));
    if (toggledInSource) {
      refreshUiMessage(messageId);
      return;
    }
  }

  const message = messages.value.find(msg => msg.id === messageId);
  if (message) {
    // 优先处理parts数组中的工具调用
    if (message.parts) {
      const toolPart = message.parts.find(part =>
        part.type === 'tool' && part.toolCall?.id === toolCallId
      );
      if (toolPart && toolPart.toolCall) {
        toolPart.toolCall.expanded = !toolPart.toolCall.expanded;
        return;
      }
    }

    // 兼容旧版本：处理toolCalls数组
    if (message.toolCalls) {
      const toolCall = message.toolCalls.find(tc => tc.id === toolCallId);
      if (toolCall) {
        toolCall.expanded = !toolCall.expanded;
      }
    }
  }
};

/**
 * 压缩片段展开/收起（partIndex 定位 message.parts 原始下标）。
 * 与工具展开同一双写策略：列表副本（已结束消息，立即生效）+ 运行源对象
 * （直播消息，流式刷新以源为准）。展开状态随 record.parts 持久化，
 * 历史会话重载后还原。
 */
const toggleCompactionCollapse = (messageId: string, partIndex: number) => {
  const source = runningAssistantMessages.get(messageId);
  if (source && toggleCompactionExpanded(source.parts, partIndex)) {
    refreshUiMessage(messageId);
    return;
  }
  const index = messages.value.findIndex(msg => msg.id === messageId);
  if (index === -1) return;
  const message = messages.value[index];
  if (!message.parts || !toggleCompactionExpanded(message.parts, partIndex)) return;
  // 深拷贝触发响应式（parts 数组内的片段对象是列表项快照）
  const updatedParts = message.parts.map((p, i) => (i === partIndex ? { ...p } : p));
  messages.value.splice(index, 1, { ...messages.value[index], parts: updatedParts });
};

/**
 * 切换 reasoning part 的收起/展开状态。
 * userToggled 标记：置位后流式期间到达的新内容（正文/工具调用）不再
 * 自动收起该片段——用户明确要看的过程内容优先于自动收起约定。
 * 同样双写列表副本与运行源对象（reasoning 片段在源对象上原地更新，
 * 不再整表深拷贝替换，降低高频切换的开销）。
 */
const toggleReasoningCollapse = (messageId: string, partIndex: number) => {
  const source = runningAssistantMessages.get(messageId);
  const sourcePart = source?.parts[partIndex];
  if (source && sourcePart?.type === 'reasoning') {
    sourcePart.collapsed = !sourcePart.collapsed;
    sourcePart.userToggled = true;
    refreshUiMessage(messageId);
    return;
  }
  const message = messages.value.find(msg => msg.id === messageId);
  if (message?.parts && message.parts[partIndex]?.type === 'reasoning') {
    const target = message.parts[partIndex];
    target.collapsed = !target.collapsed;
    target.userToggled = true;
    // 深拷贝触发响应式
    const idx = messages.value.findIndex(msg => msg.id === messageId);
    if (idx !== -1) {
      const updatedParts = message.parts.map((p, i) =>
        i === partIndex ? { ...p, collapsed: target.collapsed, userToggled: true } : p
      );
      messages.value.splice(idx, 1, { ...messages.value[idx], parts: updatedParts });
    }
  }
};

/** 用户手动切换过 legacy reasoning_content 收起状态的消息 id 集合（流式自动收起跳过它们） */
const legacyReasoningUserToggled = new Set<string>();

/**
 * 模型消息反馈（赞/踩）：乐观上屏 + 字段级落库。
 * 反馈只在消息结束后可点（渲染层按 isLive 隐藏），此时运行源已移除，
 * 直接改列表项即为最终状态，不会再被流式刷新覆盖。
 * 落库结果三态处理：'missing'（合成消息，如错误卡片）静默；
 * 'failed'（DB 故障）弹可读 toast——UI 保持本次会话内的选择并告知失效范围。
 */
const handleFeedbackChange = (messageId: string, feedback: MessageFeedback | null): void => {
  const index = messages.value.findIndex(msg => msg.id === messageId);
  if (index === -1) return;
  // messages 为深度响应式 ref：对列表项的属性赋值/删除即触发重渲染
  const target = messages.value[index];
  if (feedback) target.feedback = feedback;
  else delete target.feedback;
  void transcriptEngine.setMessageFeedback(messageId, feedback).then(result => {
    if (result === 'failed') toast.error(t('sidepanel.chat.feedbackSaveFailed'));
  });
};

/** 切换向后兼容 reasoning_content 的收起/展开状态 */
const toggleReasoningContentCollapse = (messageId: string) => {
  legacyReasoningUserToggled.add(messageId);
  const source = runningAssistantMessages.get(messageId);
  if (source) {
    source._reasoningContentCollapsed = !source._reasoningContentCollapsed;
    refreshUiMessage(messageId);
    return;
  }
  const idx = messages.value.findIndex(msg => msg.id === messageId);
  if (idx !== -1) {
    messages.value.splice(idx, 1, {
      ...messages.value[idx],
      _reasoningContentCollapsed: !messages.value[idx]._reasoningContentCollapsed
    });
  }
};

// 初始化配置
let validationWatcher: { stop: () => void } | null = null;

// ──── 注册表跨上下文同步：hub 管理页保存后即时刷新面板与选择状态 ────
// 防御：被选中的智能体/技能在 hub 被删除或停用时，自动清除对应选择，避免悬挂引用
const handleRegistryChange = () => {
  refreshAgents();
  refreshSkills();
  // 非响应式引擎读取的计算属性（如选中智能体上下文的可用技能）依赖此版本号重算
  registryVersion.value += 1;
  if (selectedAgent.value && !agentEngine.get(selectedAgent.value)) {
    console.warn(`[RegistrySync] 已选智能体 "${selectedAgent.value}" 不存在，自动清除选择`);
    selectedAgent.value = '';
  }
  // 技能引用存在性经三态解析（id / 模型标识 / 名称）判定，而非裸 id 集合：
  // v1 会话与旧数据以名称持久化引用，裸 id 判定会把它们误判为悬挂而清除；
  // 单次遍历完成「检出 + 过滤」，每个悬挂引用告警一次便于定位来源
  //（hub 删除 / 存储同步覆盖），避免静默清除无从排查
  const validSkillRefs = selectedSkills.value.filter(ref => {
    if (skillEngine.get(ref)) return true;
    console.warn(`[RegistrySync] 已选技能 "${ref}" 不存在或已删除，自动清除选择`);
    return false;
  });
  if (validSkillRefs.length !== selectedSkills.value.length) {
    selectedSkills.value = validSkillRefs;
  }
  // 关联性修剪：hub 编辑智能体的技能关联后，已选技能可能已不属于当前智能体
  //（含上方「智能体被删除 → 清空选择」后的整体非法态）。按当前关联集合修剪，
  // 维持「选中 ⊆ 当前智能体关联集」不变量——registryVersion 已自增，
  // selectableSkills 在此处读到的必然是新注册表下的结果
  if (selectedSkills.value.length > 0) {
    const linkedIds = new Set(selectableSkills.value.map(skill => skill.id));
    const stillLinked = selectedSkills.value.filter(id => linkedIds.has(id));
    if (stillLinked.length !== selectedSkills.value.length) {
      console.warn(
        `[RegistrySync] ${selectedSkills.value.length - stillLinked.length} 个已选技能不再关联当前智能体，自动取消选中`,
      );
      selectedSkills.value = stillLinked;
    }
  }
};

const unsubscribeAgentEngine = agentEngine.onChange(handleRegistryChange);
const unsubscribeSkillEngine = skillEngine.onChange(handleRegistryChange);
// 模型注册表变更（本上下文保存设置 / 其它上下文经备份恢复写入）→ 刷新选择器清单；
// 当前键仍有效时 refreshModelOptions 不会改动它，会话内选择不受影响。
// 自愈全局默认引用：healActiveRef 自身幂等（引用有效时零副作用、不写盘），
// 无需额外防抖；订阅触发时状态已由注册表重算完毕。
const unsubscribeModelRegistry = modelRegistry.subscribe(() => {
  refreshModelOptions();
  void modelRegistry.healActiveRef().catch(error => {
    console.warn('[App] 默认模型自愈失败:', error);
  });
  // 学习配置面板开着时同步刷新候选：用户可能刚在设置里补了视觉模型，
  // 不刷新会让「无可用模型 → 去设置」的引导形成死循环
  if (learn.phase.value === 'configuring' || learn.phase.value === 'confirming') {
    learn.refreshModels();
  }
});
onUnmounted(() => {
  setApiErrorRetryHandler(null);
  conversationEngine.detach();
  window.removeEventListener('beforeunload', detachConversationView);
  unsubscribeAgentEngine();
  unsubscribeSkillEngine();
  unsubscribeModelRegistry();
  // 时段问候定时器随组件销毁清除
  if (greetingTimer) {
    clearInterval(greetingTimer);
    greetingTimer = null;
  }
  // 守卫确认收敛（清倒计时定时器）+ 持久化降级订阅退订
  settleGuard(false);
  unsubscribePersistenceIssues();
  // 胶囊条折叠测量的尺寸观察随组件销毁断开
  selectionStripResizeObserver?.disconnect();
  selectionStripResizeObserver = null;
});

const detachConversationView = () => conversationEngine.detach();
onMounted(async () => {
  window.addEventListener('beforeunload', detachConversationView);
  // 时段问候定时校准
  greetingTimer = setInterval(() => {
    greetingPeriod.value = getGreetingPeriod();
  }, 60_000);

  // 加载渠道与应用设置（持久化），刷新模型选择器
  await checkApiConfig();

  // 初始化技能存储（localStorage 同步恢复已在模块加载完成，此处做 chrome.storage 对账兜底）
  await skillEngine.restore();
  refreshSkills();

  // 会话计划对账（localStorage 缓存已同步恢复，此处补 chrome.storage 权威源）
  await restorePlansFromStorage();

  try {
    const lastChatId = await readActiveChat();
    if (lastChatId) {
      if (await transcriptEngine.getSession(lastChatId)) await loadHistorySession(lastChatId);
      else await rememberActiveChat('');
    }
  } catch (error) {
    console.warn('[App] 恢复侧边栏会话失败:', error);
  }

  // 加载已保存的工作流
  try {
    const result = await chrome.storage.local.get(['workflows']);
    if (result.workflows && Array.isArray(result.workflows)) {
      workflows.value = result.workflows;
      console.log('已加载工作流:', workflows.value.length, '个');
    }
  } catch (error) {
    console.error('加载工作流失败:', error);
  }

  // 初始化 WebSocket 监听器
  initWebSocketListeners();
  
  // 检查网站验证存储标记，若已验证则尝试自动连接
  await checkWebsiteValidationAndConnect();
  
  // 监听来自content script的录制消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TEXT_SELECTED') {
      // 页面选区 → 待引用。
      // 已引用态下不再响应新的选区：用户须先「取消引用」，否则随手一选就会
      // 把已确认的引用顶掉（引用是用户明确确认过的内容，不该被顺带的手势覆盖）。
      if (confirmedQuote.value) {
        console.log('已有已确认引用，忽略新的文字选择（需先取消引用）');
        return;
      }
      const raw = typeof message.text === 'string' ? message.text.trim() : '';
      if (!raw) return;
      // 超长选区在入口即归一（与 <page_quote> 信封同源的 8000 字上限）：
      // 引用条、落库记录、气泡、信封四个下游共用同一份结果，大选区不会
      // 撑爆转录库（引用条本身另有三行 + 块内滚动的展示封顶）
      const text = normalizeQuoteText(raw);
      if (!text) return;
      console.log('收到文字选择消息', text);
      // 来源优先取标签页顶层 URL/标题（选区可能发生在 iframe 内，用户看到的
      // 是顶层页面）；content script 自报的地址仅作兜底。
      // 用 || 而非 ??：标签页地址缺失时是 undefined/空串，两种都该回落到兜底值。
      pendingQuote.value = {
        text,
        source: normalizePageQuoteSource(
          sender?.tab?.url || message.url,
          sender?.tab?.title || message.title,
        ),
      };
    } else if (message.type === 'TEXT_DESELECTED') {
      // 页面取消选区 → 清掉待引用。
      // 已引用态下忽略：引用已被用户确认并固定，页面选区变化不应动它。
      if (confirmedQuote.value) return;
      console.log('收到文字取消选择消息');
      pendingQuote.value = null;
    } else if (message.type === 'SCREEN_CAPTURED') {
      // 处理截图完成
      console.log('收到截图完成消息');
      capturedImage.value = message.dataUrl;
      showCapturedImage.value = true;
      isCapturingScreen.value = false;
    } else if (message.type === 'SCREEN_CAPTURE_CANCELLED') {
      // 处理截图取消
      console.log('截图已取消');
      isCapturingScreen.value = false;
    } else if (message.type === SESSION_BRIDGE_MSG.OPEN_IN_SIDEPANEL) {
      // 管理中心「会话管理」：请求侧边栏打开指定会话。
      // **应答方唯一**：只有侧边栏应答该类型（后台与管理中心都忽略）——
      // Chrome 的 sendMessage 是「先应答者胜」，多应答方会让结果随机来自
      // 错误的上下文。
      const targetChatId = typeof message.chatId === 'string' ? message.chatId : '';
      if (!targetChatId) {
        sendResponse({ ok: false });
        return;
      }
      void (async () => {
        try {
          await loadHistorySession(targetChatId);
          sendResponse({ ok: true });
        } catch (error) {
          console.warn('[App] 按管理中心请求切换会话失败:', error);
          sendResponse({ ok: false });
        }
      })();
      return true; // 异步应答
    } else if (message.type === SESSION_BRIDGE_MSG.DELETED) {
      // 管理中心删除了某个会话：正打开它时按侧边栏内部的删除收尾逻辑复位
      // （清缓存 / 中止运行 / 回主页），与侧边栏自己删除时的行为完全一致。
      const deletedChatId = typeof message.chatId === 'string' ? message.chatId : '';
      if (deletedChatId) handleSessionDeleted(deletedChatId);
    }
  });

  // 启动网站自动验证与监听，成功一次后自动停止并建立WebSocket连接
  validationWatcher = startWebsiteValidationWatcher(async () => {
    if (wsConnectionStatus.value !== ConnectionStatus.CONNECTED) {
      await toggleWebSocketConnection();
    }
  }, { initialRun: true });
});

onUnmounted(() => {
  try {
    validationWatcher?.stop();
  } catch {
    // 停止验证监听失败时静默忽略（组件即将销毁，无需处理）
  }
  // 清理 WebSocket 相关监听器
  cleanupWebSocketListeners();
});
</script>

<style scoped>
@import '../styles/app.css';

</style>
