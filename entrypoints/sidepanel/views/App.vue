<template>
  <div class="app-container" @click="handleContainerClick">
    <!-- WebSocket 状态栏 -->
    <WebSocketStatusBar 
      :status="wsConnectionStatus" 
      :is-dev="isDev"
      @toggle-connection="toggleWebSocketConnection" 
      @toggle-debug="toggleToolPanel" 
    />
    
    <!-- 工作笔记按钮 -->
    <button class="settings-btn" @click="openNotesPage" style="top: 12px;left: 12px;" v-tip="t('sidepanel.app.notesButton')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M7,7H17V9H7V7M7,11H17V13H7V11M7,15H13V17H7V15Z" fill="currentColor"/>
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
        <!-- 问候语区域 -->
        <div class="greeting-container">
          <!-- 时段动态表情暂时注释：样式与时段逻辑均保留，取消注释即可恢复
          <div class="greeting-emoji" :class="`is-${greetingPeriod}`" aria-hidden="true">
            <span class="greeting-emoji-char">{{ greetingEmoji }}</span>
          </div>
          -->
          <!-- 品牌 logo：打字机文案的视觉锚点，配色与 logo 的蓝紫渐变同源 -->
          <div class="greeting-brand" aria-hidden="true">
            <span class="greeting-logo-halo"></span>
            <img
              class="greeting-logo"
              :src="greetingLogoUrl"
              alt=""
              width="42"
              height="42"
            />
          </div>
          <h1 class="greeting-title" :aria-label="greetingText">
            <!-- 定宽占位：整行宽度恒等于最终文案，打字过程中不左右跳动 -->
            <span class="greeting-title-ghost">{{ greetingText }}</span
            ><span
              class="greeting-title-live"
              :class="{ 'is-rollout': isRollout }"
              :key="passId"
              aria-hidden="true"
              ><span class="greeting-text-run" :class="`is-style-${styleIndex}`"
                ><span v-for="(ch, i) in typedChars" :key="i" class="greeting-char">{{ ch }}</span
              ></span
              ><span class="greeting-caret" :class="{ 'is-idle': typingDone }"></span
            ></span>
          </h1>
        </div>
      </div>
    </div>

    <!-- 聊天模式 -->
    <ChatMessageList 
      :messages="messages" 
      :show-chat-mode="showChatMode" 
      :is-ai-responding="isAiResponding"
      @toggle-tool-call-expansion="toggleToolCallExpansion"
      @toggle-reasoning-collapse="toggleReasoningCollapse"
      @toggle-reasoning-content-collapse="toggleReasoningContentCollapse"
      @feedback-change="handleFeedbackChange"
    />

    <!-- 底部输入区域 -->
    <div class="bottom-section">
      <div class="bottom-toolbar">
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
                <svg class="strip-chip-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path
                    :d="chip.kind === 'agent' ? (chip.iconPath || DEFAULT_AGENT_ICON_PATH) : SELECTION_STRIP_SKILL_ICON_PATH"
                    fill="currentColor"
                  />
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
                  <svg class="strip-chip-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path
                      :d="chip.kind === 'agent' ? (chip.iconPath || DEFAULT_AGENT_ICON_PATH) : SELECTION_STRIP_SKILL_ICON_PATH"
                      fill="currentColor"
                    />
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1115.6 12 3.611 3.611 0 0112 15.6z" fill="currentColor"/>
            </svg>
          </button>
          <button class="icon-btn" v-tip="t('sidepanel.app.historyDrawer')" @click="showHistoryDrawer = true">
            <svg t="1753196772574" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" width="18" height="18"><path d="M512 128c212.064 0 384 153.6 384 341.312 0 187.712-171.936 341.312-384 341.312-38.944 0-77.056-5.28-113.376-15.552l-107.2 60.96a32 32 0 0 1-47.936-31.616l11.776-96.768C173.28 683.632 128 579.808 128 469.312 128 281.6 299.936 128 512 128z m0 64c-176.448 0-320 124.288-320 277.312 0 92.896 40.704 177.76 111.904 234.4a32 32 0 0 1 11.84 26.944l-7.52 61.792 68.736-39.12a32 32 0 0 1 25.216-2.816c35.232 10.816 72.32 16.128 109.824 16.128 176.448 0 320-124.224 320-277.312S688.448 192 512 192zM352 432a48 48 0 1 1 0 96 48 48 0 0 1 0-96z m160 0a48 48 0 1 1 0 96 48 48 0 0 1 0-96z m160 0a48 48 0 1 1 0 96 48 48 0 0 1 0-96z" fill="currentColor"/></svg>
          </button>
          <button class="icon-btn" v-tip="t('sidepanel.app.newChat')" @click="goHome">
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
        @continue="settleGuard(true)"
        @stop="settleGuard(false)"
      />

      <div class="input-section">
        <!-- 选中文字展示 -->
        <div v-if="showSelectedText && selectedText" class="selected-text-display">
          <div class="selected-text-content">
            <div class="selected-text-body">
              <span class="selected-text-label">{{ t('sidepanel.app.selectedText') }}</span>
              <span class="selected-text-value">{{ selectedText }}</span>
            </div>
            <div class="selected-text-actions">
              <button class="quote-btn" @click="quoteSelectedText" :title="t('sidepanel.app.quoteToInput')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14,17H17L19,13V7H13V13H16M6,17H9L11,13V7H5V13H8L6,17Z" fill="currentColor"/>
                </svg>
                {{ t('sidepanel.app.quote') }}
              </button>
              <button class="close-selected-text" @click="clearSelectedText" :title="t('sidepanel.app.clearSelectedText')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        
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
          <div v-if="attachmentBudgetCap > 0" class="attachment-budget">
            {{ t('sidepanel.attachments.budgetUsage', { used: formatCharsK(attachmentManager.totalChars.value), cap: formatCharsK(attachmentBudgetCap) }) }}
          </div>
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
          @stop="learn.requestAbort()"
        />

        <div v-else class="input-container">
          <!-- 原输入框，暂时隐藏 -->
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
              <path d="M12 1.5L14.35 9.65L22.5 12L14.35 14.35L12 22.5L9.65 14.35L1.5 12L9.65 9.65L12 1.5Z" fill="#3b82f6"/>
            </svg>
            <span>{{ t('sidepanel.learn.statusHint') }}</span>
          </div>

          <!-- 站点学习会话：成果兜底（草稿随消息回放）。
               降级说明之外的第二重保障——暂存失败或未在管理中心确认时，
               打开该会话即可把草稿重新送去创建，成果不再随暂存时效消失 -->
          <div
            v-else-if="activeChatId && learnRecoverableDraft"
            class="input-disabled-notice learn-recover-notice"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right: 8px; flex: 0 0 auto;" aria-hidden="true">
              <path d="M12 1.5L14.35 9.65L22.5 12L14.35 14.35L12 22.5L9.65 14.35L1.5 12L9.65 9.65L12 1.5Z" fill="#3b82f6"/>
            </svg>
            <span>{{ t('sidepanel.learn.recoverHint') }}</span>
            <button type="button" class="learn-recover-btn" @click="retryCreateSkillFromLearn">
              {{ t('sidepanel.learn.recoverAction') }}
            </button>
          </div>

          <!-- 禁用提示信息（可点击打开配置弹窗） -->
          <div v-if="!isChatInputEnabled && !learn.isLearnActive.value" class="input-disabled-notice" @click="showSettingsModal = true" style="cursor: pointer;" :title="t('sidepanel.app.configureApiHint')">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="margin-right: 8px;">
              <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="#ff9800"/>
            </svg>
            <span>{{ t('sidepanel.app.apiNotConfiguredPrefix') }}<span style="color: #3b82f6; text-decoration: underline;">{{ t('sidepanel.app.apiNotConfiguredLink') }}</span>{{ t('sidepanel.app.apiNotConfiguredSuffix') }}</span>
          </div>
          

          
          <!-- 学习态下隐藏整个工具栏：发送/模型选择/附件在学习流程期间一律不可达，
               入口按钮也随之让位（配置面板与状态条承载全部交互） -->
          <div class="bottom-bar" v-if="!learn.isLearnActive.value">
            <div class="left-actions">
              <!-- 网站学习入口（最左侧、高亮常驻）：点击打开配置面板。
                   运行中禁用——状态条上已有终止入口，避免两个入口并存引发歧义 -->
              <button
                class="input-action-btn learn-entry-btn"
                type="button"
                :disabled="learn.isLearnRunning.value"
                :title="t('sidepanel.learn.entryTip')"
                :aria-label="t('sidepanel.learn.entryTip')"
                @click="learn.openModal()"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <path
                    d="M12 1.5L14.35 9.65L22.5 12L14.35 14.35L12 22.5L9.65 14.35L1.5 12L9.65 9.65L12 1.5Z"
                    fill="currentColor"
                  />
                </svg>
              </button>

              <!-- 会话内模型选择器（替换原推理切换按钮）：从已配置的模型列表中切换当前生效模型 -->
              <div class="model-select-wrap">
                <button
                  class="model-select-btn"
                  :class="{ 'no-model': !activeChatModel }"
                  :title="activeChatModel ? t('sidepanel.app.switchModel') : t('sidepanel.app.noModelsHint')"
                  @click.stop="toggleModelSelectorMenu"
                >
                  <img class="model-select-logo" :src="currentModelIcon" alt="" />
                  <span class="model-select-name">{{ activeChatModel || t('sidepanel.app.noModelConfigured') }}</span>
                  <svg class="dropdown-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M7,10L12,15L17,10H7Z" fill="currentColor"/>
                  </svg>
                </button>

                <!-- 上下文用量圆环（模型选择器右侧；悬浮展示全量成分明细） -->
                <ContextUsageRing :usage="contextUsage" :compacting="isCompacting" />

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
              <button class="input-action-btn" :disabled="!isChatInputEnabled" v-tip="t('sidepanel.app.attachment')" @click="handleFileUpload">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M16.5,6V17.5A4,4 0 0,1 12.5,21.5A4,4 0 0,1 8.5,17.5V5A2.5,2.5 0 0,1 11,2.5A2.5,2.5 0 0,1 13.5,5V15.5A1,1 0 0,1 12.5,16.5A1,1 0 0,1 11.5,15.5V6H10V15.5A2.5,2.5 0 0,0 12.5,18A2.5,2.5 0 0,0 15,15.5V5A4,4 0 0,0 11,1A4,4 0 0,0 7,5V17.5A5.5,5.5 0 0,0 12.5,23A5.5,5.5 0 0,0 18,17.5V6H16.5Z" fill="currentColor"/>
                </svg>
              </button>
              <button class="input-action-btn" v-tip="t('sidepanel.app.voice')" @click="handleVoiceRecord">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z" fill="currentColor"/>
                </svg>
              </button>
              <button class="send-button" v-tip="isAiResponding ? t('sidepanel.chat.stopResponding') : t('sidepanel.chat.sendMessage')" @click="isAiResponding ? confirmStopResponse() : sendMessage()" :disabled="!isAiResponding && !userInput.trim() && !pendingAttachments.length" :class="{ 'stop-button': isAiResponding }">
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
              <div class="agent-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path :d="item.agent.iconPath || DEFAULT_AGENT_ICON_PATH" fill="currentColor"/>
                </svg>
              </div>
              <div class="agent-info">
                <div class="agent-name">{{ item.agent.name }}</div>
                <div class="agent-desc">{{ item.agent.description }}</div>
                <div v-if="item.agent.tags.length" class="agent-tags">
                  <span v-for="tag in item.agent.tags" :key="tag" class="agent-tag">{{ tag }}</span>
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

        <!-- 技能选择卡片（/ 触发，多选；系统内全部启用技能，关联给当前智能体的排前；
             搜索在卡片内搜索框完成，输入框继续打字即收起） -->
        <div v-if="showSkillSelector" class="agent-selector skill-selector" @keydown="handleSkillSelectorKeyDown">
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
              <div class="agent-name">{{ skill.name }}</div>
              <div class="agent-desc">{{ skill.description }}</div>
            </div>
          </div>
          <div v-if="!filteredSkills.length" class="skill-empty">
            <span class="skill-empty-text">{{ t('sidepanel.app.noSkillsHint') }}</span>
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
    <LearnDialog :view="learn.dialog.value" @answer="learn.answerDialog($event)" />

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
import ToolComponent from './Tool.vue';
// 组件按功能域从 barrel 引入（chat / modals / voice / feedback）
import { ChatMessageList, ChatHistoryDrawer, ContextUsageRing, GuardConfirmBar, PlanBoard } from '../components/chat';
import { SiteLearnModal, LearnDialog, LearnStatusBar, LearnDegradedNotice } from '../components/learn';
import { useLearnSession } from '../composables/use-learn-session';
import { SettingsModal, AsrConfigPrompt, DeepSearchWarning } from '../components/modals';
import { VoiceAssistantCard, VoiceAssistantSettings, VoiceRecordingModal } from '../components/voice';
import { AiProcessingOverlay, AppDialog, InteractDialog, MessageContainer, WebSocketStatusBar } from '../components/feedback';
// 全局 Toast（轻量可读提示：反馈落库失败 / 复制失败 / API 错误；宿主见模板 MessageContainer）
import { message as toast } from '../utils/chat/message';

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
// 核心引擎层：会话由引擎驱动，App 层只负责事件渲染与前置交互；
// 智能体/技能的读取一律经引擎门面，不直连底层存储
import {
  runtimeBuilder,
  transcriptEngine,
  conversationEngine,
  composeLlmUserMessage,
  agentEngine,
  skillEngine,
  contextCompactor,
  measureContextUsage,
  COMPACTION_PRE_RUN_RATIO,
  type ConversationEvent,
  type ConversationRuntime,
  type ChatMessageRecord,
  type ContextUsage,
  type EffectiveContext,
  type AgentConfig,
  type SkillRecord,
  type ToolApprovalRequest,
  type GuardKind,
  DEFAULT_AGENT_ICON_PATH,
} from '../core';
// Deep Search 站点注册表：站点开关列表与动态工具注入的单一事实来源
// （站点启用态与 UI 开关在 use-deep-search-sites 单例，见「已登录网站」注释）
import { resolveDeepSearchToolIds } from '../config/deep-search-sites';
// 网站学习成果兜底：草稿（SkillDraft）暂存 + 深链 hash（与 use-learn-session 同源）
import { saveLearnDraft } from '@/utils/learn/learn-draft-store';
import { LEARN_DRAFT_HASH, type SkillDraft } from '@/utils/learn/learn-types';
// 注册表权威源对账入口（@ / 面板开启时主动与 chrome.storage 同步，兜底跨上下文 onChanged 事件漏投）
import { restoreCustomAgentsFromStorage } from '@/utils/agents/agent-store';
import { restoreCustomSkillsFromStorage } from '@/utils/skills/skill-store';
// 会话计划（plan_tool 产物）：活跃会话绑定 / 删除级联 / chrome.storage 对账
import { setActivePlanChat, dropPlan, restorePlansFromStorage } from '@/utils/plan/plan-store';
import { convertAudioToText } from '../utils/ai/voice-to-text';
// 附件栏：文件分类/解析在纯逻辑层，守卫流程与状态在 composable
import { ATTACHMENT_ACCEPT } from '../utils/chat/attachment-parser';
import {
  createAttachmentManager,
  formatBytes,
  TOTAL_BUDGET_RATIO,
  type ChatAttachment,
} from '../composables/use-attachments';
import { showAlert, showConfirm, openDialogWithHandle, settleDialogById } from '../composables/use-app-dialog';
import { dismissPendingInteracts } from '../composables/use-interact';
import { toApiErrorBlock } from '../utils/stream/errors';
import { escapeXmlText } from '../utils/xml-entities';
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
import { usePageEffects } from '../composables/usePageEffects';
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
 */
const formatTokensK = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  return tokens < 1024 ? `${Math.round(tokens)}` : `${(tokens / 1024).toFixed(1)}K`;
};

/**
 * 推送一条轻量系统通知到对话流（仅 UI 展示，不入转录/不入模型上下文）。
 * 用于输入超限与压缩进度等用户可感知事件。
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
  dismissPendingInteracts();
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
    const timer = window.setTimeout(() => finish(false), TOOL_APPROVAL_TIMEOUT_SECONDS * 1000);
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
    // result 永不 reject（use-app-dialog 契约：任何路径都 resolve），无拒绝分支
    void handle.result.then(approved => finish(approved));
  });

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

/** 按事件定位/创建 UI 助手消息：首个内容事件到达时把「思考中」占位转换为真实消息 */
const ensureAssistantMessage = (messageId: string, isThinkingConversion = false): RunningAssistantMessage | null => {
  let uiMessage = runningAssistantMessages.get(messageId);
  if (!uiMessage) return null;
  const listIndex = messages.value.findIndex(msg => msg.id === messageId);
  if (listIndex === -1) return null;

  if (isThinkingConversion && uiMessage.isThinking) {
    uiMessage.isThinking = false;
    uiMessage.parts = [];
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
    parts: source.parts.map(p => (p.type === 'tool' && p.toolCall ? { ...p, toolCall: { ...p.toolCall } } : p)),
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
      messages.value.push({
        id: event.record.id,
        role: 'user',
        content: event.record.content,
        timestamp: event.record.createdAt,
        parts: [{ type: 'text', content: event.record.content }],
        toolCalls: [],
        // 用户上传图片以引用形态随消息展示（可查看 / 放大 / 下载）
        ...(event.record.imageRefs && event.record.imageRefs.length > 0
          ? { imageRefs: [...event.record.imageRefs] }
          : {}),
      });
      break;
    }
    case 'assistant-start': {
      // 「思考中」占位（与旧实现一致的 UI 状态）
      const thinking: RunningAssistantMessage = {
        id: event.messageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        parts: [{ type: 'text', content: '' }],
        toolCalls: [],
        isThinking: true,
      };
      // 首截图的 message-image 事件先于 assistant-start 到达（引擎准备阶段顺序）：
      // 此时 UI 消息尚不存在，事件被缓冲在 pendingImageRefs，这里合并落地。
      // 部件置于片段流最前——首截图发生在任何正文与工具调用之前
      const pending = pendingImageRefs.get(event.messageId);
      pendingImageRefs.delete(event.messageId);
      if (pending && pending.refs.length > 0) {
        thinking.imageRefs = [...pending.refs];
        thinking.parts = [
          ...pending.refs.map(ref => ({ type: 'image' as const, imageRef: ref })),
          ...thinking.parts,
        ];
      }
      runningAssistantMessages.set(event.messageId, thinking);
      messages.value.push(thinking);
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
      const current = target.imageRefs ?? [];
      if (!current.includes(event.imageRef)) {
        target.imageRefs = [...current, event.imageRef];
      }
      target.parts.push({ type: 'image', imageRef: event.imageRef });
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
      // 以独立系统信息条渲染（notice 类型片段）；终态覆盖时引擎记录已含同片段
      const uiMessage = runningAssistantMessages.get(event.messageId);
      if (!uiMessage) break;
      uiMessage.parts.push({ type: 'notice', content: event.text });
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
      if (index === -1) messages.value.push(finalMessage);
      else messages.value.splice(index, 1, finalMessage);
      runningAssistantMessages.delete(record.id);
      // 终态兜底：正常路径下缓冲已在 assistant-start 合并，此处保证异常时序也不滞留
      pendingImageRefs.delete(record.id);
      break;
    }
    case 'assistant-error': {
      const uiMessage = ensureAssistantMessage(event.messageId, true);
      if (!uiMessage) break;
      const errorText = `\n\n${event.error}`;
      const lastPart = uiMessage.parts.length > 0 ? uiMessage.parts[uiMessage.parts.length - 1] : null;
      if (lastPart && lastPart.type === 'text') lastPart.content = (lastPart.content || '') + errorText;
      else uiMessage.parts.push({ type: 'text', content: errorText });
      uiMessage.content += errorText;
      // 失败轮次同样计时（事件在 finalize 后发射）：写入运行源后经 refresh 快照上屏
      if (event.durationMs !== undefined) uiMessage.durationMs = event.durationMs;
      refreshUiMessage(event.messageId);
      runningAssistantMessages.delete(event.messageId);
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
      pendingImageRefs.delete(event.messageId);
      if (!uiMessage) break;
      const index = messages.value.findIndex(msg => msg.id === event.messageId);
      if (index === -1) break;
      const contentText = typeof uiMessage.content === 'string' ? uiMessage.content : '';
      const hasVisibleContent =
        !!contentText.trim() ||
        !!uiMessage.reasoning_content?.trim() ||
        uiMessage.toolCalls.length > 0;
      if (!hasVisibleContent) {
        messages.value.splice(index, 1);
        break;
      }
      uiMessage.isThinking = false;
      // 中止耗时直接落到列表项：运行源已从缓存移除，refreshUiMessage 在此是空操作，
      // 写运行源不会上屏（列表里是流式期间快照出的独立对象）
      if (event.durationMs !== undefined) messages.value[index].durationMs = event.durationMs;
      refreshUiMessage(event.messageId);
      break;
    }
    case 'guard': {
      // 守卫确认经 onLimitReached 回调处理，这里只负责记录
      console.warn(`[Conversation] 触发循环守卫: ${event.kind}`);
      break;
    }
    case 'compaction': {
      // 运行时压缩进度（发送前压缩由 sendMessage 直接通知，不经引擎事件）
      if (event.phase === 'start') {
        pushSystemNotice(t('sidepanel.chat.compactionStart'));
        isCompacting.value = true;
      } else if (event.phase === 'done') {
        isCompacting.value = false;
        pushSystemNotice(
          t('sidepanel.chat.compactionDone', {
            from: formatTokensK(event.originalTokens ?? 0),
            to: formatTokensK(event.summaryTokens ?? 0),
          }),
        );
      } else {
        isCompacting.value = false;
        pushSystemNotice(
          t('sidepanel.chat.compactionFailed', { reason: event.error ?? '未知原因' }),
        );
      }
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
): Pick<ExtendedChatMessage, 'durationMs' | 'feedback'> => ({
  ...(typeof record.usage?.durationMs === 'number'
    ? { durationMs: record.usage.durationMs }
    : {}),
  ...(record.feedback ? { feedback: record.feedback } : {}),
});

/** ChatMessageRecord（历史会话加载）→ UI 消息 */
const recordToUiMessage = (record: ChatMessageRecord): ExtendedChatMessage => ({
  id: record.id,
  role: record.role,
  content: record.content,
  timestamp: record.createdAt,
  parts: record.parts,
  toolCalls: record.toolCalls,
  reasoning_content: record.reasoning,
  // 执行时长与反馈随记录还原：耗时展示 / 赞踩状态跨重启持久（缺失 = 旧记录，隐藏展示）
  ...recordMetaOf(record),
  // 关联图片（用户上传 / vision 自动截图）随记录还原，渲染层据此展示图片区
  ...(record.imageRefs && record.imageRefs.length > 0 ? { imageRefs: [...record.imageRefs] } : {}),
});
// Escape 关闭面板后记住被忽略的触发符，直到触发序列中断（输入空格/删除），
// 避免 continues 输入过滤词时面板反复弹开
let dismissedTrigger: '@' | '/' | null = null;
const username = ref('');
const messageTextarea = ref<HTMLTextAreaElement | null>(null);
const isAiResponding = ref(false);

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
    const existingTab = tabs.find(
      tab => tab.url === pageUrl || tab.url?.startsWith(`${pageUrl}#`),
    );

    if (existingTab?.id !== undefined) {
      // 聚焦 + 更新 URL：hash 变化会触发 hub 侧的 hashchange 重新消费草稿；
      // 只聚焦不改 URL 会让「草稿已换新」却停在旧视图上
      await chrome.tabs.update(existingTab.id, { url: `${pageUrl}${hash}`, active: true });
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
  observer: handleConversationEvent,
  notify: pushSystemNotice,
  showChat: () => {
    showChatMode.value = true;
  },
  setActiveChat: chatId => {
    activeChatId.value = chatId;
    // 学习会话刚创建：其补充段此后只承载草稿回放数据（非 LLM 输入），
    // 装配侧必须按「学习会话」口径处理（不写普通 systemPromptSuffix、
    // 装配时置空补充段），否则草稿会被误当提示词拼进 systemPrompt
    activeSessionIsLearn = true;
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

// 页面视觉效果 composable
const {
  addPageGlow,
  removePageGlow,
  addPageBorderEffect,
  removePageBorderEffect,
  startBorderEffectManagement,
  stopBorderEffectManagement,
  getCurrentTabId,
  injectBorderControllerScript,
  sendBorderMessage,
} = usePageEffects();

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

// ==================== 附件栏（守卫流程与状态见 composables/use-attachments） ====================
// 图片准入与文本预算都以「当前生效模型」为基准（模型级阈值），经注入回调保持解耦
const attachmentManager = createAttachmentManager({
  isCurrentModelVision: () => activeOption.value?.vision ?? false,
  getContextThreshold: () => activeOption.value?.contextThreshold ?? CONTEXT_THRESHOLD_DEFAULT,
});
const pendingAttachments = attachmentManager.attachments;
/** 文本附件累计预算上限（字符；随当前生效模型的上下文阈值联动，50% 口径） */
const attachmentBudgetCap = computed(() =>
  Math.floor((activeOption.value?.contextThreshold ?? CONTEXT_THRESHOLD_DEFAULT) * TOTAL_BUDGET_RATIO),
);

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
 * 从模型注册表刷新候选清单与当前生效模型（启动加载、配置保存、跨上下文变更后调用）。
 * 当前键仍有效时保持不动（会话内已选择的模型不被设置保存冲掉）；
 * 失效（首装 / 模型被删或禁用）时优先回落全局默认，其次首个可用模型。
 */
const refreshModelOptions = () => {
  modelOptions.value = modelRegistry.listOptions();
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
 * - 图片附件守卫：目标模型未声明视觉能力且存在图片附件时弹窗二选一——
 *   确认（切换并移除图片）或取消（保留图片、维持当前模型）
 */
const selectChatModel = async (option: ModelOption) => {
  if (!modelOptions.value.some(item => item.key === option.key)) return;

  // 图片守卫仅在「切到不同模型」时需要：点击当前生效模型视觉状态不变
  if (option.key !== activeModelKey.value && !option.vision) {
    const imageCount = pendingAttachments.value.filter(att => att.kind === 'image').length;
    if (imageCount > 0) {
      const dropAndSwitch = await showConfirm(
        t('sidepanel.attachments.switchModelDropsImages', { name: option.label, count: imageCount }),
        t('sidepanel.attachments.promptTitle'),
        'warn',
        {
          confirmText: t('sidepanel.attachments.switchDropImages'),
          cancelText: t('sidepanel.attachments.switchKeepImages'),
        },
      );
      showModelSelectorMenu.value = false;
      if (!dropAndSwitch) {
        // 用户选择保留图片：维持当前模型，本轮切换取消
        console.log(`[ModelSelector] 用户保留图片附件，取消切换到 ${option.label}`);
        return;
      }
      const removed = attachmentManager.removeImageAttachments();
      console.log(`[ModelSelector] 切换到无视觉模型 ${option.label}，已移除 ${removed} 张图片附件`);
      pushSystemNotice(t('sidepanel.attachments.switchModelImagesRemoved', { count: removed }));
    }
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

// 新增：输入框禁用状态（由 API 配置驱动）
const isChatInputEnabled = ref(false);

// 设置弹窗状态（统一入口：渠道与模型 / 高级参数 / 备份 / 语音识别；历史分区导航隐藏）
const showSettingsModal = ref(false);
// 设置弹窗打开时定位到的分区（语音「去配置」直达 ASR 页；Deep Search 警告直达已登录网站页，关闭后复位）
const settingsInitialSection = ref<'channels' | 'advanced' | 'asr' | 'websites'>('channels');

/** 关闭设置弹窗并复位初始分区 */
const handleSettingsClose = () => {
  showSettingsModal.value = false;
  settingsInitialSection.value = 'channels';
  // 学习配置面板可能正开着（「去设置」引导用户补视觉模型）：关闭后刷新模型清单，
  // 否则新添加的模型在下拉里不可见，「无可用模型 → 去设置」的引导会形成死循环
  if (learn.phase.value === 'configuring') learn.refreshModels();
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

// ── 时段问候：五个时段各配一句文案与一个动态表情 ──
// 深夜😴（安睡+zzz）/ 清晨☕（浮动+热气）/ 上午⚡（充能脉冲）/ 下午👋（拟人挥手）/ 晚上✨（星光闪烁）
// 注意：动态表情已随模板一并暂时注释（见 template 中的 greeting-emoji 区块），恢复时同步解开注释即可
type GreetingPeriod = 'lateNight' | 'dawn' | 'morning' | 'afternoon' | 'evening';

const GREETING_KEY: Record<GreetingPeriod, MessageKey> = {
  lateNight: 'sidepanel.app.greetingLateNight',
  dawn: 'sidepanel.app.greetingDawn',
  morning: 'sidepanel.app.greetingMorning',
  afternoon: 'sidepanel.app.greetingAfternoon',
  evening: 'sidepanel.app.greetingEvening',
};

/*
const GREETING_EMOJI: Record<GreetingPeriod, string> = {
  lateNight: '😴',
  dawn: '☕',
  morning: '⚡',
  afternoon: '👋',
  evening: '✨',
};
*/

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
// const greetingEmoji = computed<string>(() => GREETING_EMOJI[greetingPeriod.value]);

// 每分钟校准一次时段：侧边栏常驻跨过整点时，问候文案与表情自动跟随
let greetingTimer: ReturnType<typeof setInterval> | null = null;

// ── 欢迎语打字机（无限循环）──
// 视觉锚点是项目 logo（替代被注释的时段表情）。一个循环：
// 逐字打出 → 停留（光标呼吸）→ 整行透视回滚 → 换一套样式翻入重新打字，
// 三套样式（素色 / 品牌渐变流光 / 星辉发光）轮换，周而复始。
// 首字延迟给 logo 留出入场呼吸感；整行宽度由 ghost 占位锁定，打字时不跳动。

/** 项目 logo（public/logo.png 经扩展运行时地址引用，与模型图标同一套取法） */
const greetingLogoUrl = chrome.runtime.getURL('logo.png');

/** 当前应展示的问候文案（i18n 解析；时段流转 / 语言切换都会更新它） */
const greetingText = computed<string>(() => t(welcomeSentence.value));

/** 已打出的前缀文本 */
const typedText = ref('');
/** 已打出的字符序列（按码点切分，避免把代理对拆开） */
const typedChars = computed<string[]>(() => Array.from(typedText.value));
/** 停留阶段标志：打完后光标由常亮转为待机呼吸闪烁 */
const typingDone = ref(false);
/** 回滚进行中：整行带透视翻出淡出，随后换样式翻入 */
const isRollout = ref(false);
/** 轮换样式序号：0 素色 / 1 品牌渐变流光 / 2 星辉发光，每轮回滚后 +1 */
const styleIndex = ref(0);
/** 轮次编号：作为打字图层的 key，每轮重挂载以重播「翻入」动画 */
const passId = ref(0);

/** 打完后的停留时长（毫秒），停留结束即回滚 */
const TYPE_HOLD_MS = 2400;
/** 回滚翻出动画时长（须与 CSS 的 greeting-roll-out 一致） */
const ROLL_OUT_MS = 420;
/** 翻入后延迟起手打字，让新样式先立住 */
const ROLL_IN_LEAD_MS = 300;
/** 轮换样式数量（与 CSS 的 .is-style-N 一一对应） */
const GREETING_STYLE_COUNT = 3;

let typeTimer: ReturnType<typeof setTimeout> | null = null;
/** 打字代际标记：文案变更 / 组件销毁时递增，作废仍在排队的旧定时器 */
let typeEpoch = 0;

/** 标点后多停一拍，节奏更接近真人输入 */
const typePauseAfter = (ch: string): number => (/[，。！？,.!?；;：:]/.test(ch) ? 240 : 0);

const stopTypewriter = () => {
  if (typeTimer) {
    clearTimeout(typeTimer);
    typeTimer = null;
  }
};

/** 是否为中日韩表意 / 标点与全角字符（决定单字停顿时长） */
const isWideChar = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x3400 && code <= 0x9fff) || // CJK 统一表意文字
    (code >= 0x3000 && code <= 0x303f) || // CJK 符号与标点
    (code >= 0xff00 && code <= 0xffef) // 全角形式
  );
};

/**
 * 启动「逐字打出 → 停留 → 回滚 → 换样式翻入」的无限循环，
 * 直到文案变更（时段流转 / 语言切换）或组件销毁。
 * @param text 目标文案
 * @param leadIn 首字延迟（毫秒），给 logo 入场留出呼吸感
 */
const runTypewriter = (text: string, leadIn = 0) => {
  stopTypewriter();
  const epoch = ++typeEpoch;
  const chars = Array.from(text); // 按码点切分，代理对（生僻字 / 表情）不会被拆开
  typedText.value = '';
  typingDone.value = false;
  isRollout.value = false;
  styleIndex.value = 0;
  passId.value = 0;
  if (!text) return;
  // 系统开启「减弱动态效果」时直接呈现全文，不进入循环
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    typedText.value = text;
    typingDone.value = true;
    return;
  }

  /** 排队本轮回调；代际不匹配（文案已被替换 / 组件已销毁）则静默作废 */
  const schedule = (fn: () => void, delay: number) => {
    typeTimer = setTimeout(() => {
      if (epoch !== typeEpoch) return;
      fn();
    }, delay);
  };

  // ── 阶段一：逐字打出 ──
  const typeIn = (shown: number, delay: number) => {
    schedule(() => {
      typedText.value = chars.slice(0, shown + 1).join('');
      if (shown + 1 >= chars.length) {
        // 打完 → 停留，光标转呼吸闪烁
        typingDone.value = true;
        schedule(rollOut, TYPE_HOLD_MS);
        return;
      }
      // 中文 / 全角字符略慢、英文略快，再叠加随机抖动，形成自然的呼吸节奏
      const ch = chars[shown];
      const base = isWideChar(ch) ? 104 : 56;
      typeIn(shown + 1, base + typePauseAfter(ch) + Math.random() * 54);
    }, delay);
  };

  // ── 阶段二：回滚（整行带透视翻出淡出） ──
  const rollOut = () => {
    typingDone.value = false;
    isRollout.value = true;
    schedule(() => {
      // 回滚到底：换下一套样式，以新 key 重挂载让「翻入」重播，再从头打字
      typedText.value = '';
      styleIndex.value = (styleIndex.value + 1) % GREETING_STYLE_COUNT;
      passId.value += 1;
      isRollout.value = false;
      typeIn(0, ROLL_IN_LEAD_MS);
    }, ROLL_OUT_MS);
  };

  typeIn(0, leadIn);
};

// 文案变化即重打（首轮 leadIn 让 logo 先入场，其后即时衔接）
watch(
  greetingText,
  (text, previous) => runTypewriter(text, previous === undefined ? 560 : 0),
  { immediate: true },
);

// 文字选择相关状态
const selectedText = ref('');
const showSelectedText = ref(false);

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

/** 智能体面板列表（面板内搜索框按名称/描述/标签/分类名过滤；输入框不再按字过滤） */
const matchedAgents = computed(() => {
  if (!showAgentSelector.value) return agents.value;
  const q = agentSelectorQuery.value.trim().toLowerCase();
  if (!q) return agents.value;
  return agents.value.filter(
    a =>
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.tags.some(tag => tag.toLowerCase().includes(q)) ||
      categoryLabel(a.category).toLowerCase().includes(q),
  );
});

/**
 * 智能体选择器的扁平条目：分组标题与智能体选项交替排列。
 * 扁平化的价值：selectedAgentIndex 直接作为数组下标参与高亮与键盘导航，
 * 标题项由 selectAgentAtIndex / moveAgentSelection 识别并跳过，无需维护二级索引。
 */
type AgentSelectorItem =
  | { type: 'header'; key: string; label: string }
  | { type: 'agent'; key: string; agent: AgentConfig };

const agentSelectorItems = computed<AgentSelectorItem[]>(() =>
  agentEngine.groupForDisplay(matchedAgents.value).flatMap(group => [
    {
      type: 'header' as const,
      key: `category-${group.categoryId}`,
      label: group.labelKey ? t(group.labelKey as MessageKey) : group.categoryId,
    },
    ...group.agents.map(agent => ({ type: 'agent' as const, key: agent.id, agent })),
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
  if (item && item.type === 'agent') selectAgent(item.agent.name);
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
 * 技能面板列表 = 系统内全部启用技能（内置 + 用户创建 / 导入），
 * 关联给当前智能体的技能排在最前（用户意图优先，保持声明顺序），
 * 其余按注册表顺序（内置在前，自定义按名称稳定排序）。
 *
 * 与 runtime-builder 的「可用技能」口径刻意不同：面板回答「能选什么」，
 * 装配回答「注入什么」。预选技能经合成 load_skill 轮注入、不受可用清单限制，
 * 因此这里必须放开到全量——否则用户刚导入的技能（未必被当前智能体的工具集
 * 承载）在面板里根本选不到。
 */
const selectableSkills = computed<SkillRecord[]>(() => {
  // 引擎读取非响应式：读一次 registryVersion 建立依赖，注册表任何同步后重算
  void registryVersion.value;
  const enabled = skills.value.filter(s => s.enabled);
  const agent = selectedAgent.value ? agentEngine.get(selectedAgent.value) : null;
  const refs = agent?.skills;
  if (!Array.isArray(refs) || refs.length === 0) return enabled;

  const linkedIds = new Set<string>();
  const linked: SkillRecord[] = [];
  for (const ref of refs) {
    const skill = skillEngine.get(ref);
    if (!skill || !skill.enabled || linkedIds.has(skill.id)) continue;
    linkedIds.add(skill.id);
    linked.push(skill);
  }
  if (linked.length === 0) return enabled;
  return [...linked, ...enabled.filter(s => !linkedIds.has(s.id))];
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

// 过滤列表收缩时钳制高亮索引：高亮必须始终落在某个智能体条目上（不能停在分组标题或越界）
watch(agentSelectorItems, list => {
  const stillValid = list.some(
    (item, index) => index === selectedAgentIndex.value && item.type === 'agent',
  );
  if (!stillValid) selectedAgentIndex.value = agentOptionIndexes.value[0] ?? 0;
});
watch(filteredSkills, list => {
  if (selectedSkillIndex.value >= list.length) selectedSkillIndex.value = Math.max(0, list.length - 1);
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
  // 重新加载渠道与应用设置，更新输入框状态与模型选择器。
  // 加载失败时退化为内存态继续（保存已成功，内存即最新），
  // 绝不让弹窗关闭流程因对账读取失败而抛出
  try {
    await modelRegistry.load();
  } catch (error) {
    console.warn('[App] 配置保存后对账加载失败（按内存态继续）:', error);
  }
  isChatInputEnabled.value = modelRegistry.isConfigured();
  refreshModelOptions();
  // 模型阈值与生效模型可能已变：上下文预算随之重算（否则环上数字停留在旧阈值）
  void refreshContextUsage();
};

// 检查模型配置并显示/隐藏配置弹窗
const checkApiConfig = async () => {
  try {
    await modelRegistry.load();
  } catch (error) {
    // 加载失败不阻塞启动：按内存态判定（首装/存储故障 = 未配置 → 弹设置）
    console.error('[App] 模型配置加载失败:', error);
  }
  const configured = modelRegistry.isConfigured();
  isChatInputEnabled.value = configured;
  refreshModelOptions();
  // 启动自愈：全局默认引用指向已失效模型时（配置在别处被改）回落到首个可用
  if (configured) {
    void modelRegistry.healActiveRef().catch(error => {
      console.warn('[App] 默认模型启动自愈失败:', error);
    });
  }
  if (!configured) {
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
 * 空匹配提示卡上的取消按钮：关闭面板并忽略当前触发序列
 * （与 Escape 同语义：序列中断前不再弹开，重新输入 @ 或 / 可再次唤起）
 */
const dismissAgentSelector = (): void => {
  dismissedTrigger = '@';
  showAgentSelector.value = false;
};

const dismissSkillSelector = (): void => {
  dismissedTrigger = '/';
  showSkillSelector.value = false;
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
  }

  // 自动调整textarea高度
  if (messageTextarea.value) {
    messageTextarea.value.style.height = 'auto';
    messageTextarea.value.style.height = messageTextarea.value.scrollHeight + 'px';
  }
};

// 处理键盘事件
const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (showAgentSelector.value && agentOptionIndexes.value.length > 0) {
      selectAgentAtIndex(selectedAgentIndex.value);
    } else if (showSkillSelector.value && filteredSkills.value.length > 0) {
      selectSkill(filteredSkills.value[selectedSkillIndex.value].id);
    } else {
      sendMessage();
    }
  } else if (showAgentSelector.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveAgentSelection(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveAgentSelection(-1);
    } else if (event.key === 'Escape') {
      dismissedTrigger = '@';
      showAgentSelector.value = false;
    }
  } else if (showSkillSelector.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedSkillIndex.value = Math.min(selectedSkillIndex.value + 1, filteredSkills.value.length - 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedSkillIndex.value = Math.max(selectedSkillIndex.value - 1, 0);
    } else if (event.key === 'Escape') {
      dismissedTrigger = '/';
      showSkillSelector.value = false;
    }
  }
};

// 处理智能体选择器键盘事件（面板内搜索框获焦时事件冒泡到此，同一套导航）
const handleAgentSelectorKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    // 无条件拦下回车：卡片内输入框不承担提交语义（空列表时也只是关不掉而已）
    event.preventDefault();
    if (agentOptionIndexes.value.length > 0) {
      selectAgentAtIndex(selectedAgentIndex.value);
    }
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveAgentSelection(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveAgentSelection(-1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    dismissedTrigger = '@';
    showAgentSelector.value = false;
    // 焦点交还输入框：用户关闭卡片后通常要继续打字
    messageTextarea.value?.focus();
  }
};

// 处理技能选择器键盘事件（面板内搜索框获焦时事件冒泡到此，同一套导航）
const handleSkillSelectorKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    // 无条件拦下回车：卡片内输入框不承担提交语义
    event.preventDefault();
    if (filteredSkills.value.length > 0) {
      selectSkill(filteredSkills.value[selectedSkillIndex.value].id);
    }
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectedSkillIndex.value = Math.min(selectedSkillIndex.value + 1, filteredSkills.value.length - 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectedSkillIndex.value = Math.max(selectedSkillIndex.value - 1, 0);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    dismissedTrigger = '/';
    showSkillSelector.value = false;
    messageTextarea.value?.focus();
  }
};

/** 移除输入末尾的触发符及其过滤词（保留触发符之前的全部内容），如 "你好 /bil" → "你好 "、"你好/bil" → "你好" */
const stripActiveTrigger = () => {
  userInput.value = userInput.value.replace(/[@/][^@/\s]*$/, '');
};

// 选择智能体（单选，再次选择即切换）
const selectAgent = (agentName: string) => {
  selectedAgent.value = agentName;
  stripActiveTrigger();
  dismissedTrigger = null;
  showAgentSelector.value = false;
};

// 选择技能（多选：面板中再次点击已选技能视为取消；值为技能 id）
const selectSkill = (skillId: string) => {
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

// 移除选中的智能体
const removeSelectedAgent = () => {
  selectedAgent.value = '';
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
  | { kind: 'agent'; key: string; label: string; iconPath?: string }
  | { kind: 'skill'; key: string; label: string; id: string };

/** 技能胶囊的固定图标 path（闪电；智能体用自身 iconPath） */
const SELECTION_STRIP_SKILL_ICON_PATH = 'M7,2H17L15,9H21L11,22L13,13H6L7,2Z';

/** 胶囊条数据：已选智能体 + 已选技能（技能展示名经 skillDisplayName 解析，被删时回落 id 原文） */
const selectionStripChips = computed<SelectionStripChip[]>(() => {
  const chips: SelectionStripChip[] = [];
  if (selectedAgent.value) {
    chips.push({
      kind: 'agent',
      key: `agent:${selectedAgent.value}`,
      label: selectedAgent.value,
      iconPath: agentEngine.get(selectedAgent.value)?.iconPath,
    });
  }
  for (const id of selectedSkills.value) {
    chips.push({ kind: 'skill', key: `skill:${id}`, label: skillDisplayName(id), id });
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
// 返回是否真正完成切换（false = 被运行中守卫拦截，界面保持原状）
const goHome = async (): Promise<boolean> => {
  if (isAiResponding.value) {
    await showAlert(
      t('sidepanel.app.newChatBlockedMessage'),
      t('sidepanel.app.newChatBlockedTitle'),
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
  learnRecoverableDraft = null;
  activeSessionIsLearn = false;
  // 结束当前会话：下次发送将创建新会话（历史会话仍保留在转录库，可从历史抽屉打开）
  activeChatId.value = '';
  // 缓存随之清空，避免已结束会话的记录常驻内存（会话删除场景由 handleSessionDeleted 传入 chatId 精准清理）
  clearSessionContextCache();
  runningAssistantMessages.clear();
  // 新会话尚无请求，上下文用量清空（环回到空态；选择变化后由 watcher 重新给出预估值）
  contextUsage.value = null;
  isCompacting.value = false;
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
 */
let learnRecoverableDraft: SkillDraft | null = null;
/** 当前会话是否为站点学习会话（kind 由转录引擎落库；决定补充段的语义与保护策略） */
let activeSessionIsLearn = false;

/** 解析会话补充段里的技能草稿；形态不符（旧会话 / 损坏数据）一律按无草稿处理 */
function parseLearnDraft(raw: string | undefined | null): SkillDraft | null {
  if (!raw || !raw.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(raw) as SkillDraft;
    // 最小形态校验：必须是 submit_skill 的提交体（name + 正文），否则不认
    return typeof parsed?.name === 'string' && typeof parsed?.body === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** 「重试创建技能」：把兜底草稿重新暂存并打开管理中心；无草稿时只开空表单 */
async function retryCreateSkillFromLearn(): Promise<void> {
  let saved = false;
  if (learnRecoverableDraft) {
    // 暂存失败只弹提示，不中断——仍要打开管理中心：hub 侧 takeLearnDraft
    // 得到 none 会按「草稿不存在」开空表单，用户至少能继续手动创建
    saved = await saveLearnDraft(learnRecoverableDraft);
    if (!saved) toast.error(t('sidepanel.learn.draftSaveDegraded'));
  }
  const opened = await openHubWithHash(LEARN_DRAFT_HASH);
  if (!opened) {
    toast.error(t('sidepanel.learn.openHubFailed'));
    return;
  }
  // 分岔依据必须与文案一致：
  //   暂存成功 → 成果已随行，去新标签确认创建；
  //   暂存失败 → 成果未随行，管理中心将是空白表单（openHubFailed 已覆盖「没打开」）
  if (saved) toast.info(t('sidepanel.learn.handoffDone'));
}

// ==================== 历史会话抽屉 ====================

const showHistoryDrawer = ref(false);

/**
 * 从历史抽屉加载会话：切换 activeChatId、重建 UI 消息、回显该会话持久化的
 * 智能体 / 技能 / 模型 / 系统提示词设置，并按回显结果立即重算上下文预算。
 */
const loadHistorySession = async (chatId: string) => {
  // 正在回答时先中止当前运行
  if (isAiResponding.value) {
    stopAiResponse();
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
    // 它是「草稿暂存失败」降级路径的兜底（暂存只在收尾那一刻有效、跨会话不随行），
    // 用户重新打开该会话即可取回成果、继续手动创建技能。
    // 正常路径下暂存的草稿已在管理中心消耗，此处读回只是冗余副本，不会重复创建
    activeSessionIsLearn = meta.kind === 'site-learn';
    learnRecoverableDraft = activeSessionIsLearn ? parseLearnDraft(effective.systemPromptSuffix) : null;
    // 补充段按会话类型分岔：
    //   - 普通会话：落库值就是 LLM 补充段，回填给装配与预算重算；
    //   - 学习会话：库里是草稿回放数据（非 LLM 输入），装配一律用空，
    //     否则草稿 JSON 会被拼进 systemPrompt 污染请求
    activeSystemPromptSuffix.value = activeSessionIsLearn ? '' : effective.systemPromptSuffix;
    runningAssistantMessages.clear();
    messages.value = effective.records.map(recordToUiMessage);
    showChatMode.value = messages.value.length > 0;
    showHistoryDrawer.value = false;
    // 切换到的会话与输入区附件草稿无关：清空避免「附件跟着切换」的错位
    attachmentManager.clearAttachments();

    // ── 回显该会话最近使用的设置（已不存在/已停用的自动忽略，绝不阻断会话加载）──
    // 智能体回显：优先按稳定 ID 解析（智能体改名后仍能正确回显），
    // ID 失配（智能体已被删除）再按名称兜底；两者皆无则清空选择，绝不阻断会话加载。
    // 展示用解析结果的当前名称，保证标签与最新命名一致
    const boundAgent = agentEngine.resolveRef(meta.agentId, meta.agentName);
    selectedAgent.value = boundAgent ? boundAgent.name : '';
    // 技能回显：历史会话可能存技能 id（v2）或技能名（v1），统一经 resolveSkill
    // 三态解析为当前记录，取其 id 存入选中态（停用/已删除的静默剔除）；
    // 同一技能的多形态引用（id 与名称/模型标识并存）解析后按 id 去重，
    // 避免重复胶囊、选择签名漂移与「取消一次删不干净」的边缘问题
    const restoredSkillIds = new Set<string>();
    selectedSkills.value = (Array.isArray(meta.skillNames) ? meta.skillNames : [])
      .map(ref => skillEngine.get(ref))
      .filter((skill): skill is SkillRecord => !!skill && skill.enabled)
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
      toolIds: runtime.toolIds,
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
  // 会话已删除：立即中止其仍在进行的运行。否则引擎会跑到自然结束，
  // 期间每 2s 的快照落库全部命中「会话已不存在」丢弃分支并重复告警，
  // 模型也会基于一个用户已放弃的会话继续消耗请求
  if (conversationEngine.isRunning(chatId)) {
    conversationEngine.abort(chatId);
    // 该会话若挂起守卫确认（删除发生在确认期间），同步收敛防止悬停
    settleGuard(false);
  }
  clearSessionContextCache(chatId);
  // 缓冲区里该会话的首截图引用一并清除（assistant-start 尚未到达的竞态窗口）
  for (const [messageId, entry] of pendingImageRefs) {
    if (entry.chatId === chatId) pendingImageRefs.delete(messageId);
  }
  // 级联清理该会话的计划（会话级隔离：会话不在则计划不留）
  dropPlan(chatId);
  if (chatId === activeChatId.value) {
    goHome();
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
/** 附件 chip 悬浮提示：文件名 + 提取形态 + 体积/字符数 */
const attachmentChipTitle = (att: ChatAttachment): string => {
  const kindText =
    att.source === 'office'
      ? t('sidepanel.attachments.sourceOffice')
      : att.source === 'image'
        ? t('sidepanel.attachments.sourceImage')
        : t('sidepanel.attachments.sourceText');
  return `${att.name}\n${kindText} · ${formatBytes(att.sizeBytes)}${
    att.kind === 'text' ? ` · ${att.chars} ${t('sidepanel.attachments.charsUnit')}` : ''
  }`;
};

/** 附件 chip 元信息：文本类显示字符数（K 缩写），图片显示体积 */
const attachmentChipMeta = (att: ChatAttachment): string =>
  att.kind === 'text'
    ? `${formatCharsK(att.chars)}${t('sidepanel.attachments.charsUnit')}`
    : formatBytes(att.sizeBytes);

const handleFileUpload = () => {
  if (attachmentManager.isAdding.value) return;
  const input = document.createElement('input');
  input.type = 'file';
  // accept 仅为选择器便利过滤；最终准入由分类守卫决定（「所有文件」选择同样会被明确拦截）
  input.accept = ATTACHMENT_ACCEPT;
  input.multiple = true;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length > 0) {
      void attachmentManager.addFiles(files);
    }
  };
  input.click();
};

// 文字选择相关方法
const quoteSelectedText = () => {
  if (selectedText.value) {
    userInput.value += `"${selectedText.value}" `;
    clearSelectedText();
    // 自动调整textarea高度
    if (messageTextarea.value) {
      messageTextarea.value.style.height = 'auto';
      messageTextarea.value.style.height = messageTextarea.value.scrollHeight + 'px';
    }
  }
};

const clearSelectedText = () => {
  selectedText.value = '';
  showSelectedText.value = false;
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

// 中止AI回答函数
const stopAiResponse = async () => {
    console.log('开始中止AI回答...');
    
    // 1. 立即设置状态，防止新的请求
    isAiResponding.value = false;

    // 1.5 收敛挂起的守卫确认（若有）：引擎正 await 该 Promise，不收敛会让运行永久悬停
    settleGuard(false);

    // 1.6 收敛挂起的 interact 询问（弹窗/悬浮球与排队中的全部）：引擎正 await
    // 工具 Promise，不收敛同样会永久悬停；统一按 dismissed（询问被中断）回传
    dismissPendingInteracts();

    // 1.7 收敛挂起的工具审批（若有）：定向关闭审批弹窗并按拒绝放行——
    // 否则弹窗悬停在已停止的界面上，引擎也要等审批结算（点击或 60s 超时）
    // 才能继续退出；拒绝结果由引擎以可控失败回传后随中止信号收尾
    if (pendingToolApproval) {
      const approval = pendingToolApproval;
      pendingToolApproval = null;
      try {
        settleDialogById(approval.dialogId, false);
      } catch (error) {
        // 定向关闭失败（弹窗已被正常关闭等）不影响收敛器放行
        console.warn('[Stop] 关闭工具审批弹窗失败:', error);
      }
      approval.finish(false);
    }

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
    
    // 2. 中止会话引擎当前运行（网络请求与工具循环一并终止）
    if (activeChatId.value) {
      try {
        conversationEngine.abort(activeChatId.value);
        console.log('已中止会话引擎运行');
      } catch (error) {
        console.warn('中止会话引擎失败:', error);
      }
    }

    // 3. 移除页面效果
    try {
        removePageGlow();
        console.log('已移除页面发光效果');
    } catch (error) {
        console.warn('移除页面发光效果失败:', error);
    }
    
    // 4. 停止边框效果管理（移除所有标签页的边框效果并停止监听）
    try {
        await stopBorderEffectManagement();
        console.log('已停止边框效果管理');
    } catch (error) {
        console.warn('停止边框效果管理失败:', error);
    }
    
    // 5. 移除思考中的消息（仅当它尚无任何可见内容——正文/推理/工具卡片都算
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
    
    // 6. 清理可能的定时器和监听器
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
const sendMessageInner = async () => {
    console.log(`[SendMessage] 入口触发, isAiResponding=${isAiResponding.value}, input="${userInput.value.trim().substring(0, 50)}", msgCount=${messages.value.length}`);

    // 前置检查：是否已有可用模型（渠道 + 模型齐全）
    if (!modelRegistry.isConfigured()) {
      console.warn(`[SendMessage] 尚无可用模型, 弹出配置弹窗`);
      showSettingsModal.value = true;
      return;
    }

    // 附件解析在途（含等待用户确认弹窗）时忽略发送：此刻附件列表尚不稳定，
    // 快照会漏掉正在确认的文件（其将在确认后残留为下一轮草稿），且弹窗期间
    // 输入框仍可回车触发发送——统一在此收敛
    if (attachmentManager.isAdding.value) {
      console.warn(`[SendMessage] 附件解析进行中，忽略本次发送`);
      pushSystemNotice(t('sidepanel.attachments.busyParsing'));
      return;
    }

    if (!userInput.value.trim() && pendingAttachments.value.length === 0 && messages.value.length === 0) {
      console.warn(`[SendMessage] 输入为空且无历史消息, 跳过`);
      return;
    }

    // 附件守卫：图片附件存在而当前模型未声明视觉能力（上传后模型被切换的场景）——
    // 阻断发送，用户可切换回视觉模型或移除图片附件后重试
    const hasImageAttachment = pendingAttachments.value.some(att => att.kind === 'image');
    if (hasImageAttachment && !(activeOption.value?.vision ?? false)) {
      console.warn(`[SendMessage] 当前模型 ${activeChatModel.value || '(未配置)'} 无视觉能力，存在图片附件，阻断发送`);
      await showAlert(
        t('sidepanel.attachments.modelNoVision'),
        t('sidepanel.attachments.promptTitle'),
        'warn',
      );
      return;
    }

    // 同一会话同时只允许一个运行
    if (activeChatId.value && conversationEngine.isRunning(activeChatId.value)) {
      console.warn(`[SendMessage] 会话 ${activeChatId.value} 已有运行中的任务，忽略本次发送`);
      return;
    }

    // 输入长度限制：单条消息最长 20K 字符（超长粘贴会瞬间占满上下文预算）
    const inputLength = userInput.value.length;
    if (inputLength > MAX_USER_INPUT_CHARS) {
      console.warn(`[SendMessage] 输入超长（${inputLength} 字符），拒绝发送`);
      pushSystemNotice(
        t('sidepanel.chat.inputTooLong', { limit: MAX_USER_INPUT_CHARS, current: inputLength }),
      );
      return;
    }

    messages.value = cleanupAssistantMessages(messages.value as ExtendedChatMessage[]);

    // --- 1. 默认智能体兜底：新会话首条消息且用户未选智能体时自动选中 Auto Action ---
    // 必须先于会话创建与 runtime 装配：选中结果既要写入会话元信息（供后续会话切换回显），
    // 也要进入本次请求的 systemPrompt 与工具集。用户显式选择过则绝不覆盖。
    if (!activeChatId.value && !selectedAgent.value.trim()) {
      const defaultAgent = agentEngine.getDefaultSessionAgent();
      if (defaultAgent) {
        selectedAgent.value = defaultAgent.name;
        console.info(`[SendMessage] 未选择智能体，已自动选中默认智能体 "${defaultAgent.name}"`);
      } else {
        console.warn('[SendMessage] 默认智能体不可用，本轮以无智能体模式发送');
      }
    }

    // --- 2. Deep Search 前置交互（保持原有行为：无已开启网站弹窗并保留输入） ---
    // 置于会话创建之前：前置交互不满足时直接返回，不留下 0 条消息的空会话；
    // 同时让 systemPrompt 补充段在写会话元信息时就位，一次落库
    const agentConfig = selectedAgent.value ? agentEngine.get(selectedAgent.value) : null;
    const extraToolIds: string[] = [];
    let systemPromptSuffix = '';

    if (agentConfig?.id === 'deep-search') {
      // 已开启站点读共享单例（与设置弹窗「已登录网站」分区同一份状态）
      if (enabledWebsites.value.length === 0) {
        showDeepSearchWarning.value = true;
        return;
      }

      // 自动建工作笔记，笔记信息作为提示词后缀注入（不再原地修改智能体共享配置）
      try {
        console.log('Deep Search智能体：自动触发 note_tool 创建工作笔记');
        const createNoteResult = await openaiToolsConverter.executeTool('note_tool', {
          action: 'create',
          title: `Deep Search - ${new Date().toLocaleString()}`,
          content: `用户查询: ${userInput.value}\n\n搜索时间: ${new Date().toLocaleString()}\n\n已开启的搜索平台: ${enabledWebsites.value.map(site => site.name).join('、')}\n\n---\n\n`
        });
        if (createNoteResult && !createNoteResult.isError) {
          systemPromptSuffix = firstTextContent(createNoteResult.content) || '';
        } else {
          console.error('note_tool 创建笔记失败:', createNoteResult);
        }
      } catch (error) {
        console.error('自动触发 note_tool 失败:', error);
      }

      // 按已开启网站动态追加站点工具（单一事实来源：config/deep-search-sites 注册表，
      // 含 scraper 配对校验与未知 id 防御，见该模块注释）
      extraToolIds.push(...resolveDeepSearchToolIds(enabledWebsites.value.map(site => site.id)));
    }

    // --- 3. 会话管理：无活跃 chatId 时新建（历史会话切换由历史抽屉负责） ---
    // DB 故障兜底：IndexedDB 不可用（隐私模式/配额/损坏）时以可读错误落入对话流，
    // 而不是让未处理的 Promise 拒绝静默丢失本次发送
    let effective: EffectiveContext;
    try {
      if (!activeChatId.value) {
        const session = await transcriptEngine.createSession({
          // agentId 是稳定引用（改名不变），恢复会话时优先按它解析；agentName 作为可读别名
          agentId: agentConfig?.id ?? '',
          agentName: selectedAgent.value,
          skillNames: selectedSkills.value,
          modelRef: activeModelRef.value,
          systemPromptSuffix,
        });
        activeChatId.value = session.chatId;
      } else {
        // 学习会话的补充段承载草稿回放数据（非 LLM 输入，见 setSystemPromptSuffix），
        // 绝不能被普通发送生成的 systemPromptSuffix 覆盖——那会抹掉成果兜底；
        // 其余字段（智能体/技能/模型）照常回显，与普通会话无异
        await transcriptEngine.updateSessionUsage(activeChatId.value, {
          agentId: agentConfig?.id ?? '',
          agentName: selectedAgent.value,
          skillNames: selectedSkills.value,
          modelRef: activeModelRef.value,
          ...(activeSessionIsLearn ? {} : { systemPromptSuffix }),
        });
      }
      // 有效上下文 = 压缩摘要 + 压缩点之后的记录（用户面转录仍为全量）+ systemPrompt 补充段
      effective = await transcriptEngine.getEffectiveContext(activeChatId.value);
      // 回填 UI 侧补充段：以库里实际落盘的为准（元信息写入静默失败时退回本轮生成值），
      // 保证后续选择变化触发的预算重算与本次请求用的是同一份 systemPrompt。
      // 学习会话除外：库里的补充段是草稿回放数据（非 LLM 输入），带进装配
      // 会污染 systemPrompt；它的兜底读取只发生在 loadHistorySession，装配一律用空
      if (activeSessionIsLearn) {
        activeSystemPromptSuffix.value = '';
      } else {
        activeSystemPromptSuffix.value = effective.systemPromptSuffix || systemPromptSuffix;
      }
      storeEffectiveContext(activeChatId.value, effective);
    } catch (sessionError) {
      console.error('[SendMessage] 会话存取失败:', sessionError);
      // 结构化错误卡片（分类徽章 + 完整原始信息 + 一键复制报告）：
      // 与运行期错误的呈现协议完全一致，用户自查与提交 issue 的体验统一
      const errorBlock = toApiErrorBlock(sessionError);
      messages.value.push({
        id: `session_err_${Date.now()}`,
        role: 'assistant',
        content: errorBlock,
        timestamp: Date.now(),
        parts: [{ type: 'text', content: errorBlock }],
        toolCalls: [],
      });
      showChatMode.value = true;
      return;
    }

    // 本轮运行归属的会话：后续所有异步间隙（压缩 / 装配 / 请求）一律使用该值，
    // 而不是届时的 activeChatId——用户在这些间隙里切换会话时，
    // 用 activeChatId 会把本轮回复写进错误的会话
    const runChatId = activeChatId.value;

    // --- 4. 初始准备（用户消息入档与 UI 展示由引擎 user-message 事件完成） ---
    showAgentSelector.value = false;
    showSkillSelector.value = false;
    showChatMode.value = true;

    // 快照本轮输入与附件后即刻清空输入区（发送失败时按原样恢复，见装配 catch）
    const currentInput = userInput.value;
    const currentAttachments: ChatAttachment[] = [...pendingAttachments.value];
    userInput.value = '';
    attachmentManager.clearAttachments();

    // 附件派生（两条通道，与既有「时间戳只进模型侧」的口径一致）：
    //   - 转录可见摘要标记：并入 userInput 落库（用户能查到本轮带了哪些附件）
    //   - 模型侧全文块 attachmentPrompt：文本附件全文（Office 已解析），只进 LLM 请求
    //   - 图片附件：data URL 列表走多模态 image_url（模型可见、转录不落库）
    const attachmentSummaryLines = currentAttachments.map(att =>
      att.kind === 'image'
        ? `[图片附件] ${att.name}`
        : `[附件] ${att.name}（${att.chars} 字符${att.source === 'office' ? '，已解析为文本' : ''}）`,
    );
    const attachmentSummary = attachmentSummaryLines.length
      ? `\n\n${attachmentSummaryLines.join('\n')}`
      : '';
    const transcriptInput = `${currentInput}${attachmentSummary}`;
    const textAttachmentBlocks = currentAttachments.filter(att => att.kind === 'text');
    const attachmentPrompt =
      textAttachmentBlocks.length > 0
        ? `<attachments>\n${textAttachmentBlocks
            .map(att => `<attachment name="${escapeXmlText(att.name)}">\n${att.text ?? ''}\n</attachment>`)
            .join('\n')}\n</attachments>`
        : '';
    const currentUserImages = currentAttachments
      .filter(att => att.kind === 'image' && typeof att.dataUrl === 'string')
      .map(att => att.dataUrl as string);

    console.log(`[SendMessage] 进入主流程, input="${currentInput.substring(0, 50)}", 文本附件 ${textAttachmentBlocks.length} 个, 图片附件 ${currentUserImages.length} 张`);

    if (messageTextarea.value) {
        messageTextarea.value.style.height = 'auto';
    }

    // --- 5. runtime 装配（systemPrompt XML 分区 + 工具 Set 去重 + 模型配置 + AI 面历史上下文） ---
    // 装配封装为函数：发送前压缩成功后需以「摘要 + 空记录」重建 runtime。
    // 装配可能抛错（智能体被并发删除 / 模型配置残缺）：此时消息尚未进入引擎，
    // 用户输入已在第 4 步被清空——先还原输入再上抛，由外层 sendMessage 兜底
    // catch 呈现错误，用户不必为一次可修复的装配失败重新敲一遍全文
    const buildRuntime = () =>
      runtimeBuilder.build({
        chatId: runChatId,
        userInput: transcriptInput,
        userImages: currentUserImages,
        attachmentPrompt,
        agentName: selectedAgent.value || null,
        skillNames: selectedSkills.value,
        modelRef: activeModelRef.value,
        extraToolIds,
        systemPromptSuffix,
        priorRecords: effective.records,
        contextSummary: effective.summary || undefined,
        contextSummaryAt: effective.compactedAt || undefined,
      });
    let runtime: ConversationRuntime;
    try {
      runtime = await buildRuntime();
    } catch (error) {
      if (!userInput.value.trim()) userInput.value = currentInput;
      // 附件一并还原：装配失败时消息尚未进入引擎，用户不必重新选择文件
      if (pendingAttachments.value.length === 0) pendingAttachments.value = currentAttachments;
      throw error;
    }

    // --- 6. 上下文用量测量（全量口径）+ 发送前压缩（≥85%） ---
    // 本轮用户消息按真实请求口径计量（正文 + 附件全文 + 系统时间戳 + 图片体积，
    // 与引擎构造的 LLM 消息逐字同源，图片以 data URL 形态计入 JSON 序列化长度）
    const measureCurrent = () =>
      measureContextUsage({
        systemPrompt: runtime.systemPrompt,
        toolIds: runtime.toolIds,
        messages: [
          // 与引擎组装顺序逐字同源：初始上下文 → 本轮用户消息 → 合成激活轮
          ...runtime.initialContext,
          ...(runtime.userInput || runtime.attachmentPrompt || runtime.userImages.length > 0
            ? [composeLlmUserMessage(runtime.userInput, runtime.attachmentPrompt, runtime.userImages)]
            : []),
          ...runtime.activationContext,
        ],
        threshold: runtime.model.contextThreshold,
      });
    contextUsage.value = measureCurrent();

    // --- 6.5 当前消息体积防御：本轮用户消息的 token 估算超过「阈值 − systemPrompt」
    // 时，ContextWindowGuard 的从新到旧保留策略会把它整组丢弃——模型将收不到
    // 当前消息。此处前置拦截：还原输入与附件并明确告知。计量与窗口守卫同用
    // token-estimate（图片按固定 1800 token/张，与 base64 体积解耦）---
    {
      const currentUserMessage = composeLlmUserMessage(
        runtime.userInput,
        runtime.attachmentPrompt,
        runtime.userImages,
      );
      const messageTokens = estimateMessageTokens(currentUserMessage);
      const systemTokens = estimateTextTokens(runtime.systemPrompt);
      // 装配层已将 contextThreshold 钳制为有限正数，此处可直接参与运算
      const availableBudget = Math.max(0, runtime.model.contextThreshold - systemTokens);
      if (messageTokens > availableBudget) {
        console.warn(
          `[SendMessage] 本轮消息体积 ${messageTokens} token 超过可用预算 ${availableBudget} token（阈值−systemPrompt），阻断发送`,
        );
        if (!userInput.value.trim()) userInput.value = currentInput;
        if (pendingAttachments.value.length === 0) pendingAttachments.value = currentAttachments;
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

    // --- 6.8 响应态提前 + 预运行中止通道 ---
    // 此前 isAiResponding 在引擎运行前才置位：发送前压缩（一次完整 LLM 调用，
    // 长会话可达数十秒）期间停止按钮不出现，且引擎尚未登记运行、engine.abort
    // 是空操作——用户在该阶段完全无法停止。现将响应态提前到压缩之前建立，
    // 并配套预运行 AbortController：stopAiResponse 同时中止两者，停止能力
    // 覆盖「压缩中 → 引擎准备 → 请求 API → 流式回复 → 工具执行」全阶段。
    const preRunAbort = new AbortController();
    preRunAbortController = preRunAbort;
    runEpoch += 1;
    // 记录本轮运行时的选择签名：运行结束后用于判定「用户是否在运行期间换了智能体/技能/模型」
    const runSelectionKey = selectionSignature();
    isAiResponding.value = true;
    addPageGlow();

    // 启动边框效果管理（包含当前标签页边框效果和标签页变化监听），异步不阻塞对话
    startBorderEffectManagement().catch((error) => {
      console.warn('启动边框效果管理失败:', error);
    });

    /** 预运行阶段（用户消息尚未入档）被停止的善后：恢复输入附件并给出可读提示 */
    const settlePreRunStop = (): void => {
      // 输入框为空才回填原输入：用户在间隙里已敲了新内容时，以他们正在编辑的内容为准
      if (!userInput.value.trim()) userInput.value = currentInput;
      if (pendingAttachments.value.length === 0) pendingAttachments.value = currentAttachments;
      // 会话已切换时通知不落入新会话视图（被停止的是旧会话的发送流程，
      // 与引擎事件流的 chatId 守卫同语义）
      if (activeChatId.value === runChatId) {
        pushSystemNotice(t('sidepanel.chat.stoppedByUser'));
      }
    };

    try {
      // --- 6.9 发送前压缩（≥85%） ---
      if (contextUsage.value.ratio >= COMPACTION_PRE_RUN_RATIO && effective.records.length > 0) {
        pushSystemNotice(t('sidepanel.chat.compactionStart'));
        isCompacting.value = true;
        try {
          // 压缩对象 = 初始上下文全体（含旧摘要系统消息 + 压缩点后的全部历史派生）；
          // signal 接入停止通道：停止时压缩的 LLM 请求被真正取消（compact 抛 AbortError）
          const compaction = await contextCompactor.compact({
            messages: runtime.initialContext,
            model: runtime.model,
            threshold: runtime.model.contextThreshold,
            signal: preRunAbort.signal,
          });
          // 持久化压缩状态：全部现有记录（压缩点 = 最大 seq）收拢为摘要
          const maxSeq = effective.records.reduce((max, record) => Math.max(max, record.seq), 0);
          await transcriptEngine.setCompaction(runChatId, compaction.summary, maxSeq);
          effective = {
            summary: compaction.summary,
            compactedAt: Date.now(),
            systemPromptSuffix: effective.systemPromptSuffix,
            records: [],
          };
          // 缓存同步为压缩后的形态：后续切换智能体触发的预算重算不再按压缩前的全量历史估算
          storeEffectiveContext(runChatId, effective);
          runtime = await buildRuntime();
          contextUsage.value = measureCurrent();
          pushSystemNotice(
            t('sidepanel.chat.compactionDone', {
              from: formatTokensK(compaction.originalTokens),
              to: formatTokensK(compaction.summaryTokens),
            }),
          );
        } catch (compactionError) {
          // 用户停止：压缩请求被 signal 取消——不是失败，按停止语义善后
          //（若压缩已成功持久化则保留其结果，仅本轮发送中止，下次发送直接以摘要续跑）
          if (preRunAbort.signal.aborted) {
            console.info('[SendMessage] 用户在发送前压缩期间停止，本轮中止');
            settlePreRunStop();
            return;
          }
          // 优雅降级：压缩失败不阻断发送，本轮由窗口守卫裁剪兜底
          const reason =
            compactionError instanceof Error ? compactionError.message : String(compactionError);
          console.warn('[SendMessage] 发送前压缩失败，降级为窗口裁剪:', compactionError);
          pushSystemNotice(t('sidepanel.chat.compactionFailed', { reason }));
        } finally {
          isCompacting.value = false;
        }
        // 压缩成功后的间隙兜底：持久化 / 重建 runtime / 重测量期间停止
        //（signal 已置位但 compact 未抛出的窗口，如恰好落在两个 await 之间）
        if (preRunAbort.signal.aborted) {
          settlePreRunStop();
          return;
        }
      }
      console.log(`[SendMessage] runtime 装配完成, 可用工具: [${runtime.toolIds.join(', ')}], agent: ${agentConfig?.id || 'default'}, 模型: ${runtime.model.model}, 历史消息: ${runtime.initialContext.length} 条`);

      // --- 7. 引擎驱动（「思考中」占位由 assistant-start 事件创建；响应态与
      //     运行期效果已在 6.8 提前建立，本段只负责驱动与针对性异常分诊） ---
      // 防御：前置阶段（压缩 / 装配）期间用户切换或新建了会话。本轮输入属于 runChatId，
      // 继续执行会让回复落到用户已离开的会话且当前界面收不到任何事件；
      // 此时中止并尽量还原输入，由用户在目标会话里重新发送
      if (activeChatId.value !== runChatId) {
        console.warn(
          `[SendMessage] 发送前置阶段内会话已切换（${runChatId} → ${activeChatId.value}），本轮中止`,
        );
        // 输入框为空才回填原输入：用户在间隙里已敲了新内容时，以他们正在编辑的内容为准
        const restored = !userInput.value.trim();
        if (restored) userInput.value = currentInput;
        // 附件同样只在用户未新增附件时还原，避免覆盖新的选择
        if (restored && pendingAttachments.value.length === 0) {
          pendingAttachments.value = currentAttachments;
        }
        pushSystemNotice(
          t(restored ? 'sidepanel.chat.sessionSwitchedRestored' : 'sidepanel.chat.sessionSwitchedAbort'),
        );
        return;
      }

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
        // 用户停止在引擎内已按 aborted 语义收尾并经事件流呈现（不抛出到此）；
        // 到达此处的中止伴随异常只可能是引擎准备阶段抛出（用户消息可能已入档）——
        // 按停止语义善后而非错误卡片，且不恢复输入（避免与已入档消息重复）
        if (preRunAbort.signal.aborted) {
          console.info('[SendMessage] 用户在引擎准备阶段停止，本轮中止:', engineError);
          pushSystemNotice(t('sidepanel.chat.stoppedByUser'));
          return;
        }
        // 防御：引擎级异常（并发冲突/空输入校验等通常已被上游拦截，到达此处属非典型失败）
        // 以结构化错误卡片落入对话流（与运行期错误呈现协议一致），避免未处理的 Promise 拒绝
        console.error('[SendMessage] 会话引擎异常:', engineError);
        const errorBlock = toApiErrorBlock(engineError);
        messages.value.push({
          id: `engine_err_${Date.now()}`,
          role: 'assistant',
          content: errorBlock,
          timestamp: Date.now(),
          parts: [{ type: 'text', content: errorBlock }],
          toolCalls: [],
        });
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
      removePageGlow();
      stopBorderEffectManagement().catch(error => {
        console.warn('停止边框效果管理失败:', error);
      });
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
const sendMessage = async () => {
  if (sendInFlight.value) {
    console.warn('[SendMessage] 已有发送流程在途，忽略本次触发');
    return;
  }
  sendInFlight.value = true;
  try {
    await sendMessageInner();
  } catch (error) {
    // 兜底呈现：主流程内的分段异常（会话存取 / 压缩 / 引擎驱动）各有针对性
    // catch，到达此处的是装配、测量等未分段异常（如智能体被并发删除、
    // 模型配置残缺触发的 runtime 装配抛错）——以结构化错误卡片落入对话流
    // （完整原始信息 + 一键复制报告），而不是变成无用户反馈的未处理 Promise 拒绝
    console.error('[SendMessage] 发送流程异常:', error);
    const errorBlock = toApiErrorBlock(error);
    messages.value.push({
      id: `send_err_${Date.now()}`,
      role: 'assistant',
      content: errorBlock,
      timestamp: Date.now(),
      parts: [{ type: 'text', content: errorBlock }],
      toolCalls: [],
    });
    showChatMode.value = true;
  } finally {
    sendInFlight.value = false;
  }
};

// 绑定语音录制 composable 的 sendMessage 回调
voiceRecordingDeps.sendMessage = sendMessage;
// 绑定语音助手 composable 的 sendMessage 回调
voiceAssistantDeps.sendMessage = sendMessage;

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
};

const unsubscribeAgentEngine = agentEngine.onChange(handleRegistryChange);
const unsubscribeSkillEngine = skillEngine.onChange(handleRegistryChange);
// 模型注册表变更（本上下文保存设置 / 其它上下文经备份恢复写入）→ 刷新选择器清单；
// 当前键仍有效时 refreshModelOptions 不会改动它，会话内选择不受影响。
// 同时自愈全局默认引用：自愈仅在引用失效时写盘，写盘触发的再次通知
// 经「已有效」判定收敛为 no-op，不存在通知循环
const unsubscribeModelRegistry = modelRegistry.subscribe(() => {
  refreshModelOptions();
  void modelRegistry.healActiveRef().catch(error => {
    console.warn('[App] 默认模型自愈失败:', error);
  });
});
onUnmounted(() => {
  unsubscribeAgentEngine();
  unsubscribeSkillEngine();
  unsubscribeModelRegistry();
  // 时段问候定时器随组件销毁清除
  if (greetingTimer) {
    clearInterval(greetingTimer);
    greetingTimer = null;
  }
  // 打字机定时器随组件销毁清除（代际 +1，作废排队中的回调）
  stopTypewriter();
  typeEpoch += 1;
  // 守卫确认收敛（清倒计时定时器）+ 持久化降级订阅退订
  settleGuard(false);
  unsubscribePersistenceIssues();
  // 胶囊条折叠测量的尺寸观察随组件销毁断开
  selectionStripResizeObserver?.disconnect();
  selectionStripResizeObserver = null;
});

onMounted(async () => {
  // 时段问候定时校准（greetingPeriod 驱动文案与动态表情）
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
      // 处理文字选择
      console.log('收到文字选择消息', message.text);
      selectedText.value = message.text;
      showSelectedText.value = true;
    } else if (message.type === 'TEXT_DESELECTED') {
      // 处理文字取消选择
      console.log('收到文字取消选择消息');
      selectedText.value = '';
      showSelectedText.value = false;
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