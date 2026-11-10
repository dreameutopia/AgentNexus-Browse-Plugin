import { PageExecTool } from '@/tools/browser/page-exec-tool';
import { BrowserObserveTool } from '@/tools/browser/observe';
import { BrowserInteractTool } from '@/tools/browser/interact';
import { NetworkObserverTool } from '@/tools/browser/network-observer';
import { VisionGuiTool } from '@/tools/vision/gui-tool';
// 只读观察（vision_read*）已并入 vision_gui 的 action 面，不再单独成卡
/**
 * 工具分类与工具定义数据
 */
import type { ToolCategory, ToolDefinition } from './types';

function visionGuiDefinition(): ToolDefinition {
  const tool = new VisionGuiTool();
  const schema = tool.openaiSchema.function.parameters;
  const actionSchemas = Object.fromEntries(schema.anyOf!.map(branch => {
    const b = branch as { properties: Record<string, any>; required: string[] };
    const action = b.properties.action.enum[0];
    return [action, {
      parameters: { ...b.properties, action: schema.properties.action },
      required: b.required,
    }];
  }));
  return { name: tool.name, description: tool.metadata.description, category: tool.metadata.category,
    version: tool.metadata.version, parameters: schema.properties, required: schema.required ?? [], actionSchemas };
}

export const categories: ToolCategory[] = [
  {
    id: 'automation',
    name: '自动化工具',
    icon: '🤖',
    tools: [
      {
        name: 'file_upload_getter',
        description: '获取页面中的文件上传框元素',
        category: 'automation',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'file_uploader',
        description: '上传文件到指定的文件上传框',
        category: 'automation',
        version: '1.0.0',
        parameters: {
          selector: {
            type: 'string',
            description: '文件上传框的CSS选择器',
            placeholder: 'input[type="file"]'
          },
          filePath: {
            type: 'string',
            description: '要上传的文件路径',
            placeholder: 'C:\\path\\to\\file.jpg'
          }
        },
        required: ['selector', 'filePath']
      },
      {
        name: 'ai_locate',
        description: '使用AI视觉能力根据描述定位页面元素',
        category: 'automation',
        version: '1.0.0',
        parameters: {
          description: {
            type: 'string',
            description: '要定位的元素描述',
            placeholder: '例如：登录按钮、搜索框、用户头像',
            multiline: true
          },
          highlight: {
            type: 'boolean',
            description: '是否高亮显示找到的元素',
            default: true
          },
          confidence: {
            type: 'number',
            description: '最低置信度阈值（0-1）',
            default: 0.7,
            minimum: 0,
            maximum: 1
          }
        },
        required: ['description']
      },
      {
        name: 'ai_action',
        description: '使用AI视觉能力执行页面操作',
        category: 'automation',
        version: '1.0.0',
        parameters: {
          description: {
            type: 'string',
            description: '要执行的操作描述',
            placeholder: '例如：点击登录按钮、在搜索框输入文本',
            multiline: true
          },
          action: {
            type: 'string',
            description: '操作类型',
            enum: ['click', 'input', 'hover', 'select']
          },
          value: {
            type: 'string',
            description: '操作值（用于input或select）',
            placeholder: '输入的文本或选择的选项'
          },
          highlight: {
            type: 'boolean',
            description: '是否高亮显示目标元素',
            default: true
          },
          confidence: {
            type: 'number',
            description: '最低置信度阈值（0-1）',
            default: 0.7,
            minimum: 0,
            maximum: 1
          }
        },
        required: ['description', 'action']
      },
      {
        name: 'extract_data',
        description: '使用AI视觉能力从页面提取结构化数据',
        category: 'automation',
        version: '1.0.0',
        parameters: {
          description: {
            type: 'string',
            description: '要提取的数据描述',
            placeholder: '例如：提取所有商品的名称和价格',
            multiline: true
          },
          schema: {
            type: 'object',
            description: '数据结构定义（JSON格式）',
            placeholder: '{"products": [{"name": "string", "price": "number"}]}'
          },
          selector: {
            type: 'string',
            description: '限定提取范围的CSS选择器（可选）',
            placeholder: '.product-list'
          }
        },
        required: ['description']
      },
      {
        name: 'formFiller',
        description: '智能填充页面表单',
        category: 'automation',
        version: '1.0.0',
        parameters: {
          formData: {
            type: 'string',
            description: 'JSON格式的表单数据',
            multiline: true,
            placeholder: '{"username": "user", "password": "pass"}'
          },
          autoSubmit: {
            type: 'boolean',
            description: '是否自动提交表单',
            default: false
          }
        },
        required: ['formData']
      },
      {
        name: 'get_downloads_status',
        description: '获取浏览器下载任务的状态、进度和历史记录',
        category: 'automation',
        version: '1.0.0',
        parameters: {
          state: {
            type: 'string',
            description: '过滤下载状态',
            enum: ['all', 'in_progress', 'complete', 'interrupted'],
            default: 'all'
          },
          limit: {
            type: 'number',
            description: '返回的最大数量',
            default: 10,
            minimum: 1,
            maximum: 100
          },
          query: {
            type: 'string',
            description: '搜索文件名或URL',
            placeholder: '搜索关键词...'
          },
          orderBy: {
            type: 'string',
            description: '排序字段',
            enum: ['startTime', 'bytesReceived', 'totalBytes'],
            default: 'startTime'
          }
        },
        required: []
      },
      {
        name: 'check_restricted_url',
        description: '检查当前页面是否在受限URL（如 chrome://、edge:// 等），如果是则自动导航到安全页面',
        category: 'automation',
        version: '1.0.0',
        parameters: {
          targetUrl: {
            type: 'string',
            description: '受限页面时导航的目标URL',
            placeholder: 'https://www.bing.com/',
            default: 'https://www.bing.com/'
          },
          autoNavigate: {
            type: 'boolean',
            description: '是否自动导航离开受限页面',
            default: true
          }
        },
        required: []
      },
      {
        name: 'xiaozhi_config',
        description: '小智网页配置工具 - 自动配置WiFi和OTA设置',
        category: 'automation',
        version: '1.0.0',
        parameters: {
          wifiSsid: {
            type: 'string',
            description: 'WiFi网络名称 (SSID)',
            placeholder: '例如：MyWiFi'
          },
          wifiPassword: {
            type: 'string',
            description: 'WiFi密码',
            placeholder: '输入WiFi密码'
          },
          otaUrl: {
            type: 'string',
            description: 'OTA升级地址URL',
            placeholder: '例如：http://example.com/firmware.bin'
          }
        },
        required: ['wifiSsid', 'wifiPassword', 'otaUrl']
      }
    ]
  },
  {
    id: 'upload-file',
    name: '上传文件工具',
    icon: '📎',
    tools: [
      {
        name: 'read_file',
        description: '分页读取用户上传的文件（会话文件库，全文持久化）',
        category: 'upload-file',
        version: '1.0.0',
        parameters: {
          file_id: {
            type: 'string',
            description: '8 位文件短 id（<upload_file> 信封或工具返回值中的真实 id）',
            placeholder: '例如：a1b2c3d4'
          },
          page: {
            type: 'number',
            description: '页码（1 起；信封已内联第 1 页）',
            placeholder: '2'
          }
        },
        required: ['file_id']
      }
    ]
  },
  {
    id: 'note',
    name: '笔记工具',
    icon: '📝',
    tools: [
      {
        name: 'note_tool',
        description: '笔记工作区统一操作（create/append/update/get/list/delete 由 action 区分）',
        category: 'note',
        version: '4.0.0',
        parameters: {
          action: {
            type: 'string',
            description: '操作类型',
            placeholder: 'create / append / update / get / list / delete'
          },
          noteId: {
            type: 'string',
            description: '笔记ID（append/update/get/delete 必填）',
            placeholder: '由 create/list 返回的 UUID'
          },
          title: {
            type: 'string',
            description: '笔记标题（create/update）',
            placeholder: '我的笔记'
          },
          content: {
            type: 'string',
            description: '笔记内容（create 初始 / append 追加 / update 整体替换）',
            placeholder: '内容...',
            multiline: true
          },
          category: {
            type: 'string',
            description: '笔记分类（create/update 可选，缺省 AI 笔记）',
            placeholder: '例如：调研报告'
          },
          tags: {
            type: 'array',
            description: '标签列表（JSON数组，create/update 可选）',
            placeholder: '["标签1", "标签2"]'
          },
          keyword: {
            type: 'string',
            description: 'list 操作的过滤关键词（可选）',
            placeholder: '例如：财报'
          },
          limit: {
            type: 'number',
            description: 'list 返回条数（默认 10，上限 30）',
            placeholder: '10'
          }
        },
        required: ['action']
      }
    ]
  },
  {
    id: 'browser',
    name: '浏览器工具',
    icon: '🌐',
    tools: [
      {
        name: 'browser_navigate',
        description: '在现有窗口内导航，默认打开新标签页，禁止创建浏览器窗口',
        category: 'browser',
        version: '2.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '要导航到的完整URL',
            placeholder: 'https://example.com'
          },
          newTab: {
            type: 'boolean',
            description: '是否在现有窗口新建标签页；false 使用当前标签页',
            default: true
          },
          waitForLoad: {
            type: 'boolean',
            description: '是否等待页面加载完成',
            default: true
          },
          timeout: {
            type: 'number',
            description: '等待超时时间（毫秒）',
            default: 30000
          }
        },
        required: []
      },
      {
        name: 'browser_scroll',
        description: '滚动页面。支持按屏滚动（以视口高度为单位），可选择先点击指定坐标区域',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          direction: {
            type: 'string',
            description: '滚动方向',
            enum: ['up', 'down']
          },
          screens: {
            type: 'number',
            description: '滚动屏数（如1、2、3），实际滚动距离 = 视口高度 × 95% × 屏数',
            default: 1,
            placeholder: '1'
          },
          clickBox: {
            type: 'array',
            description: '点击坐标box2d格式 [x1, y1, x2, y2]（选填，如有值将先点击该区域中心点）',
            placeholder: '[100, 200, 300, 400]'
          }
        },
        required: ['direction']
      },
      {
        name: 'browser_wait_for_element',
        description: '等待指定元素出现在页面上',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          selector: {
            type: 'string',
            description: '要等待的元素CSS选择器',
            placeholder: '#loading-indicator'
          },
          timeout: {
            type: 'number',
            description: '等待超时时间（毫秒）',
            default: 30000
          },
          visible: {
            type: 'boolean',
            description: '是否要求元素可见',
            default: true
          }
        },
        required: ['selector']
      },
      {
        name: 'browser_extract_data',
        description: '从页面 DOM 精确提取结构化数据（表格/列表/选择器），免疫 CSP，RPA 抓取首选',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          mode: {
            type: 'string',
            description: '提取模式：table=表格 / list=重复列表条目 / selector=通用选择器取值',
            enum: ['table', 'list', 'selector'],
            default: 'table'
          },
          selector: {
            type: 'string',
            description: 'CSS选择器（table 模式可省略；list 模式如 ".comment-item"）',
            placeholder: '.product-card'
          },
          fields: {
            type: 'object',
            description: 'list 模式字段映射，如 {"title":{"selector":"h2"},"link":{"selector":"a","attr":"href"}}',
            placeholder: '{"title":{"selector":"h2"},"price":{"selector":".price"}}'
          },
          attr: {
            type: 'string',
            description: 'selector 模式取值属性（省略取文本，可填 href、src 等）'
          },
          limit: {
            type: 'number',
            description: '最大提取行数（默认 100，上限 500）',
            default: 100
          }
        },
        required: []
      },
      {
        name: 'browser_clean_page',
        description: '强制去广告/去弹窗/去追踪：DOM 隐藏 + 动态弹窗持续拦截 + 网络层阻断，可一键撤销',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          mode: {
            type: 'string',
            description: '净化层面：dom=DOM 隐藏+动态拦截（默认）/ network=仅网络阻断 / both=双层防护',
            enum: ['dom', 'network', 'both'],
            default: 'dom'
          },
          scope: {
            type: 'string',
            description: '规则强度：light=仅明确广告位 / standard=标准（默认）/ aggressive=标准+全屏遮罩弹窗启发式清除',
            enum: ['light', 'standard', 'aggressive'],
            default: 'standard'
          },
          customSelectors: {
            type: 'array',
            description: '追加自定义隐藏选择器',
            items: { type: 'string' }
          },
          restore: {
            type: 'boolean',
            description: '撤销之前的净化（默认 false）',
            default: false
          }
        },
        required: []
      },
      {
        name: 'browser_network_request',
        description: '发起网络请求',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '请求URL',
            placeholder: 'https://api.example.com/data'
          },
          method: {
            type: 'string',
            description: '请求方法',
            enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']
          },
          headers: {
            type: 'object',
            description: '请求头（JSON格式）',
            placeholder: '{"Content-Type": "application/json"}'
          },
          body: {
            type: 'string',
            description: '请求体',
            multiline: true,
            placeholder: '{"key": "value"}'
          }
        },
        required: ['url', 'method']
      },
      {
        name: 'browser_go_back_or_forward',
        description: '在浏览器历史记录中前进或后退',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          isForward: {
            type: 'boolean',
            description: 'true表示前进，false表示后退',
            default: false
          }
        },
        required: []
      },
      {
        name: 'browser_switch_tab',
        description: '切换到指定标签页',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          tabId: {
            type: 'number',
            description: '标签页ID',
            placeholder: '输入标签页ID'
          }
        },
        required: ['tabId']
      },
      {
        name: 'browser_close_tab',
        description: '关闭指定标签页',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          tabId: {
            type: 'number',
            description: '标签页ID',
            placeholder: '输入标签页ID'
          }
        },
        required: ['tabId']
      },
      {
        name: 'browser_create_tab',
        description: '创建新标签页',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '新标签页URL',
            placeholder: 'https://example.com'
          },
          active: {
            type: 'boolean',
            description: '是否激活新标签页',
            default: true
          }
        },
        required: ['url']
      },
      {
        name: 'browser_vector_search',
        description: '在所有打开的标签页内容中进行向量搜索',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询',
            placeholder: '搜索内容'
          },
          maxResults: {
            type: 'number',
            description: '最大结果数量',
            default: 10
          }
        },
        required: ['query']
      },
      // scriptInject / executeJavaScript 已移除：无同名注册工具；脚本统一使用 browser_page_exec
      {
        name: 'browser_search_history',
        description: '搜索浏览器历史记录',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          text: {
            type: 'string',
            description: '搜索文本（可选）',
            placeholder: '搜索历史记录'
          },
          maxResults: {
            type: 'number',
            description: '最大结果数',
            default: 100
          },
          startTime: {
            type: 'string',
            description: '开始时间（ISO 格式或相对时间，如 "1 day ago"）',
            placeholder: '1 day ago'
          }
        },
        required: []
      },
      {
        name: 'browser_search_bookmarks',
        description: '搜索浏览器书签',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: '搜索书签'
          },
          maxResults: {
            type: 'number',
            description: '最大结果数量',
            default: 100
          }
        },
        required: []
      },
      {
        name: 'browser_bookmark_create',
        description: '添加书签',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '书签URL（可选，默认当前页面）',
            placeholder: 'https://example.com'
          },
          title: {
            type: 'string',
            description: '书签标题（可选，默认页面标题）',
            placeholder: '我的书签'
          },
          parentId: {
            type: 'string',
            description: '父文件夹ID（可选）'
          }
        },
        required: []
      },
      {
        name: 'browser_bookmark_delete',
        description: '删除书签',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          bookmarkId: {
            type: 'string',
            description: '书签ID',
            placeholder: 'bookmark-id'
          },
          url: {
            type: 'string',
            description: '书签URL（未提供ID时使用）',
            placeholder: 'https://example.com'
          }
        },
        required: []
      },
      // rightClick / drag 已移除：当前 toolRegistry 中无对应注册工具
      {
        name: 'browser_window',
        description: '获取所有浏览器窗口和标签页信息',
        category: 'browser',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'browser_console',
        description: '捕获浏览器控制台输出和异常信息',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '要监控的URL（可选，默认当前标签页）'
          },
          includeExceptions: {
            type: 'boolean',
            description: '是否包含异常信息',
            default: true
          },
          maxMessages: {
            type: 'number',
            description: '最大消息数量',
            default: 100
          }
        },
        required: []
      },
      // goBack / goForward 是 browser_go_back_or_forward 的消息类型别名；
      // browser_refresh 无注册工具（CALL_TOOL 通道不可达）——均已移除
    ]
  },
  {
    id: 'search',
    name: '搜索工具',
    icon: '🔍',
    tools: [
      {
        name: 'web_search',
        description:
          '统一多平台集成搜索：一次调用完成「导航到平台搜索结果页 → 等待加载 → 解析结构化结果 → Markdown 表格」。' +
          '⚠ 自带页面导航（效果等同 browser_navigate），禁止同一轮并发调用；返回 navigation（是否成功 + 当前网址）与 results（条目与 Markdown 表，解析失败时用 browser_get_page_text 自行解析）',
        category: 'search',
        version: '1.0.0',
        parameters: {
          website: {
            type: 'string',
            description:
              '目标搜索平台（枚举）：baidu=百度、bing=Bing、zhihu=知乎、github=GitHub、csdn=CSDN、mooc=中国大学MOOC、xiaohongshu=小红书、cnki=中国知网、bilibili=Bilibili',
            placeholder: 'bing'
          },
          query: {
            type: 'string',
            description: '搜索查询关键词（必填，最长 300 字符）',
            placeholder: '输入搜索内容'
          },
          newTab: {
            type: 'boolean',
            description: '是否在新标签页打开搜索结果（默认 true；连续搜索可传 false 复用当前标签页）',
            default: true
          },
          waitTime: {
            type: 'integer',
            description: '页面加载完成后的额外等待毫秒数（0-10000，默认 3000）',
            default: 3000
          }
        },
        required: ['website', 'query']
      }
    ]
  },
  {
    id: 'base',
    name: '基础工具',
    icon: '⚙️',
    tools: [
      {
        name: 'browser_get_page_text',
        description: '读取页面为结构化 Markdown：保留标题层级/表格/列表/代码块+语言/链接/引用；覆盖全部 iframe 与可访问 shadow root；支持 url 直读与超 15000 字符 ref 分页',
        category: 'base',
        version: '2.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '目标网址（可选，仅单个 http/https；前台新建并激活标签页打开、等待加载完成后提取，标签页保留可见不自动关闭）',
            placeholder: 'https://example.com（留空读当前标签页）'
          },
          tabId: {
            type: 'number',
            description: '标签页ID（可选，默认当前活动标签页；与 url 互斥）',
            placeholder: '留空表示当前标签页'
          },
          ref: {
            type: 'string',
            description: '分页引用 ID（可选，超长响应返回的 ref；只读缓存不访问页面）',
            placeholder: '上次响应的 ref 值'
          },
          page: {
            type: 'number',
            description: '页码（可选，默认 1；每页 15000 字符）',
            placeholder: '1'
          }
        },
        required: []
      },
      {
        name: 'browser_get_page_html',
        description: '获取当前页面的HTML源代码',
        category: 'base',
        version: '1.0.0',
        parameters: {
          tabId: {
            type: 'number',
            description: '标签页ID（可选，默认当前活动标签页）',
            placeholder: '留空表示当前标签页'
          }
        },
        required: []
      },
      {
        name: 'browser_get_page_info',
        description: '获取当前页面的基本信息（URL、标题等）',
        category: 'base',
        version: '1.0.0',
        parameters: {
          tabId: {
            type: 'number',
            description: '标签页ID（可选，默认当前活动标签页）',
            placeholder: '留空表示当前标签页'
          }
        },
        required: []
      },
      {
        name: 'browser_get_all_tabs',
        description: '获取所有打开的标签页信息',
        category: 'base',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'page-source',
        description: '获取页面源代码',
        category: 'base',
        version: '1.0.0',
        parameters: {
          selector: {
            type: 'string',
            description: 'CSS选择器（可选）',
            placeholder: '#content'
          }
        },
        required: []
      },
      {
        name: 'task-submit',
        description: '提交任务到后台处理',
        category: 'base',
        version: '1.0.0',
        parameters: {
          taskType: {
            type: 'string',
            description: '任务类型',
            placeholder: 'scrape'
          },
          taskData: {
            type: 'object',
            description: '任务数据（JSON格式）',
            placeholder: '{"url": "https://example.com"}'
          }
        },
        required: ['taskType', 'taskData']
      },
      {
        name: 'task-result',
        description: '获取任务执行结果',
        category: 'base',
        version: '1.0.0',
        parameters: {
          taskId: {
            type: 'string',
            description: '任务ID',
            placeholder: 'task-xxx'
          }
        },
        required: ['taskId']
      }
    ]
  },
  {
    id: 'common',
    name: '通用工具',
    icon: '🛠️',
    tools: [
      {
        name: 'generic_wait',
        description: '可随时停止的等待；超过 600 秒自动按 600 秒执行',
        category: 'common',
        version: '2.0.0',
        parameters: {
          waitSeconds: {
            type: 'number',
            description: '等待的秒数',
            default: 1,
            minimum: 0
          }
        },
        required: ['waitSeconds']
      },
      {
        name: 'wait_page_load',
        description: '等待页面加载完成',
        category: 'common',
        version: '1.0.0',
        parameters: {
          timeout: {
            type: 'number',
            description: '超时时间（毫秒）',
            default: 30000
          }
        },
        required: []
      }
    ]
  },
  {
    id: 'navigation',
    name: '导航工具',
    icon: '🧭',
    tools: [
      {
        name: 'quick_navigation',
        description: '快速导航到常用网站',
        category: 'navigation',
        version: '1.0.0',
        parameters: {
          site: {
            type: 'string',
            description: '网站名称或关键词',
            placeholder: 'github'
          }
        },
        required: ['site']
      },
      {
        name: 'bookmark_navigation',
        description: '通过书签导航',
        category: 'navigation',
        version: '1.0.0',
        parameters: {
          keyword: {
            type: 'string',
            description: '书签关键词',
            placeholder: '搜索书签'
          }
        },
        required: ['keyword']
      },
      {
        name: 'history_navigation',
        description: '通过历史记录导航',
        category: 'navigation',
        version: '1.0.0',
        parameters: {
          keyword: {
            type: 'string',
            description: '历史记录关键词',
            placeholder: '搜索历史'
          },
          maxResults: {
            type: 'number',
            description: '最大结果数',
            default: 10
          }
        },
        required: ['keyword']
      }
    ]
  },
  {
    id: 'vision',
    name: '视觉工具',
    icon: '👁️',
    tools: [
      { name: 'screenshot', description: '截图：action 保留调试会话用于操作；observe 不附加调试器，仅用于观察', category: 'vision', version: '3.1.0', parameters: { mode: { type: 'string', enum: ['action','observe'], default: 'action', description: '观察模式不可用于 GUI 输入' } }, required: [] },
      visionGuiDefinition(),
      { name: 'ocr', description: 'OCR 文字识别', category: 'vision', version: '1.0.0', parameters: { selector: { type: 'string', description: '可选图片选择器' } }, required: [] },
    ]
  },
  {
    id: 'resource',
    name: '资源工具',
    icon: '📦',
    tools: [
      {
        name: 'resource_sniffer',
        description: '嗅探页面资源',
        category: 'resource',
        version: '1.0.0',
        parameters: {
          resourceType: {
            type: 'string',
            description: '资源类型',
            enum: ['image', 'video', 'audio', 'document', 'all']
          }
        },
        required: []
      },
      {
        name: 'resource_downloader',
        description: '下载页面资源',
        category: 'resource',
        version: '1.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '资源URL',
            placeholder: 'https://example.com/image.jpg'
          },
          filename: {
            type: 'string',
            description: '保存的文件名',
            placeholder: 'image.jpg'
          }
        },
        required: ['url']
      },
      {
        name: 'start_download_interception',
        description: '开始拦截下载请求',
        category: 'resource',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'stop_download_interception',
        description: '停止拦截下载请求',
        category: 'resource',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'list_captured_files',
        description: '列出已拦截的文件',
        category: 'resource',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'get_captured_file_by_id',
        description: '根据ID获取拦截的文件',
        category: 'resource',
        version: '1.0.0',
        parameters: {
          fileId: {
            type: 'string',
            description: '文件ID',
            placeholder: 'file-xxx'
          }
        },
        required: ['fileId']
      },
      {
        name: 'clear_captured_files',
        description: '清空已拦截的文件',
        category: 'resource',
        version: '1.0.0',
        parameters: {},
        required: []
      }
    ]
  },
  {
    id: 'code',
    name: '代码工具',
    icon: '💻',
    tools: [
      {
        name: 'mermaid_renderer',
        description: '渲染Mermaid图表并保存为PNG图片',
        category: 'code',
        version: '2.0.0',
        parameters: {
          mermaidCode: {
            type: 'string',
            description: 'Mermaid图表源码',
            multiline: true,
            placeholder: 'graph TD\n  A-->B'
          },
          filename: {
            type: 'string',
            description: '保存的文件名（不含扩展名），默认 mermaid-diagram',
            default: 'mermaid-diagram'
          }
        },
        required: ['mermaidCode']
      }
    ]
  },
  {
    id: 'text-compression',
    name: '文本压缩',
    icon: '🗜️',
    tools: [
      {
        name: 'semantic_compressor',
        description: '语义压缩长文本',
        category: 'text-compression',
        version: '1.0.0',
        parameters: {
          text: {
            type: 'string',
            description: '要压缩的文本',
            multiline: true,
            placeholder: '输入长文本...'
          },
          ratio: {
            type: 'number',
            description: '压缩比例（0-1）',
            default: 0.5,
            minimum: 0.1,
            maximum: 0.9
          }
        },
        required: ['text']
      }
    ]
  },
  {
    id: 'excalidraw',
    name: 'Excalidraw',
    icon: '✏️',
    tools: [
      {
        name: 'setup_excalidraw_canvas',
        description: '设置Excalidraw画布',
        category: 'excalidraw',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'draw_on_canvas',
        description: '在画布上绘制',
        category: 'excalidraw',
        version: '1.0.0',
        parameters: {
          elements: {
            type: 'array',
            description: '绘制元素列表（JSON数组）',
            placeholder: '[{"type": "rectangle", "x": 100, "y": 100}]'
          }
        },
        required: ['elements']
      },
      {
        name: 'excalidraw_tool',
        description: 'Excalidraw通用工具',
        category: 'excalidraw',
        version: '1.0.0',
        parameters: {
          action: {
            type: 'string',
            description: '操作类型',
            enum: ['export', 'import', 'clear']
          }
        },
        required: ['action']
      }
    ]
  },
  {
    id: 'bilibili',
    name: 'B站工具',
    icon: '📺',
    tools: [
      {
        name: 'bilibili_subtitle_tool',
        description: '获取B站视频字幕',
        category: 'bilibili',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'bilibili_jump_tool',
        description: '跳转到B站视频指定时间',
        category: 'bilibili',
        version: '1.0.0',
        parameters: {
          time: {
            type: 'number',
            description: '跳转时间（秒）',
            placeholder: '60'
          }
        },
        required: ['time']
      }
    ]
  },
  {
    id: 'learn',
    name: '网站学习',
    icon: '✨',
    tools: [
      {
        name: 'submit_skill',
        description: '提交网站学习成果（技能草稿）并结束学习阶段；参数不合法返回可读错误且不结束',
        category: 'learn',
        version: '1.0.0',
        parameters: {
          name: {
            type: 'string',
            description: '技能名：全小写 kebab-case 英文，如 boss-zhipin-apply',
            placeholder: 'boss-zhipin-apply'
          },
          description: {
            type: 'string',
            description: '技能描述：做什么 + 何时使用（中文，≤1024 字符）',
            multiline: true,
            placeholder: '在 BOSS直聘按条件搜索相似岗位并给 BOSS 发送打招呼消息，当用户要求批量投递时使用'
          },
          category: {
            type: 'string',
            description: '技能分类（如 automation / search / general）',
            placeholder: 'automation'
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '中文标签数组（模式标签自动补）',
            placeholder: '["BOSS直聘", "求职投递"]'
          },
          body: {
            type: 'string',
            description: 'SKILL.md 正文（Markdown，不含 frontmatter，≤15000 字符）',
            multiline: true
          },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: '执行本技能需要的工具 ID 数组（非空）',
            placeholder: '["browser_navigate", "browser_interact"]'
          },
          mode: {
            type: 'string',
            enum: ['text', 'vision'],
            description: '目标操作模式：text=给纯文本模型，vision=给视觉模型',
            default: 'text'
          },
          summary: {
            type: 'string',
            description: '可选：一句话执行摘要',
            placeholder: '共 6 步，关键坑点是投递前需处理打招呼弹窗'
          }
        },
        required: ['name', 'description', 'category', 'body', 'allowedTools', 'mode']
      },
      {
        name: 'submit_validation',
        description: '提交技能验证结论并结束验证阶段；passed=false 时 issues 必填',
        category: 'learn',
        version: '1.0.0',
        parameters: {
          passed: {
            type: 'boolean',
            description: '技能是否有效：true=按技能完成目标任务，false=存在关键步骤无法完成',
            default: true
          },
          issues: {
            type: 'array',
            items: { type: 'string' },
            description: '不通过时的问题清单（每条：哪一步 + 期望 + 实际）',
            placeholder: '["第3步：技能写「点击立即投递」，实际按钮文案是「立即沟通」"]'
          },
          score: {
            type: 'number',
            description: '可选：0-100 完成度评分',
            minimum: 0,
            maximum: 100
          },
          summary: {
            type: 'string',
            description: '可选：一句话验证结论',
            placeholder: '定位信息全部命中，仅打招呼弹窗分支缺失'
          }
        },
        required: ['passed', 'issues']
      }
    ]
  }
];

/** 导航压力测试 URL 列表 */
export const testUrls = [
  'https://qdrant.tech/blog/qdrant-benchmarks-2024/',
  'https://qdrant.tech/benchmarks/',
  'https://aistudio.baidu.com/blog/detail/745566121625157',
  'https://qdrant.org.cn/course/essentials/day-2/what-is-hnsw/',
  'https://qdrant.org.cn/documentation/concepts/indexing/',
  'https://developer.volcengine.com/articles/7535837323675533363',
  'https://zhuanlan.zhihu.com/p/694511220',
  'https://zhuanlan.zhihu.com/p/1911373147812401631',
  'https://zilliz.com.cn/blog/Performance-comparison-of-open-source-vector-databases',
  'https://aistudio.baidu.com/blog/detail/748642945369605'
];

// Unified text tools share the exact execution schemas with this panel.
categories.find(c=>c.id==='browser')!.tools.push(...[new BrowserObserveTool(),new BrowserInteractTool(),new NetworkObserverTool(),new PageExecTool()].map(tool=>({
 name:tool.name,description:tool.metadata.description,category:tool.metadata.category,version:tool.metadata.version,parameters:tool.openaiSchema.function.parameters.properties as any,required:tool.openaiSchema.function.parameters.required || []
})));
