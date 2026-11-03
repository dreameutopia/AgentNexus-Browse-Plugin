import { createGuiTools } from '@/tools/vision/gui-tools';
/**
 * 工具分类与工具定义数据
 */
import type { ToolCategory } from './types';

export const categories: ToolCategory[] = [
  {
    id: 'automation',
    name: '自动化工具',
    icon: '🤖',
    tools: [
      {
        name: 'interactive_button_getter',
        description: '获取页面中的可交互按钮/链接元素（支持 regex/xpath 过滤，命中置顶并标记），Markdown 表格分页',
        category: 'automation',
        version: '4.1.0',
        parameters: {
          regex: {
            type: 'string',
            description: '可选，正则过滤（对描述文本不区分大小写的宽泛匹配，如 登录|注册）',
            placeholder: '例如：登录|注册、下一页|更多'
          },
          xpath: {
            type: 'string',
            description: '可选，XPath 1.0 过滤（元素或其祖先被选中即命中）',
            placeholder: "例如：//button[contains(.,'提交')]"
          },
          page: {
            type: 'number',
            description: '页码（从1开始，每页最多 40 个）',
            default: 1,
            minimum: 1
          }
        },
        required: []
      },
      {
        name: 'interactive_input_getter',
        description: '获取页面中的可交互输入元素（支持 regex/xpath 过滤，命中置顶并标记），Markdown 表格分页',
        category: 'automation',
        version: '3.1.0',
        parameters: {
          regex: {
            type: 'string',
            description: '可选，正则过滤（对描述文本不区分大小写的宽泛匹配，如 搜索|关键词）',
            placeholder: '例如：搜索|关键词、user.?name'
          },
          xpath: {
            type: 'string',
            description: '可选，XPath 1.0 过滤（元素或其祖先被选中即命中）',
            placeholder: "例如：//input[@name='keyword']"
          },
          page: {
            type: 'number',
            description: '页码（从1开始，每页最多 40 个）',
            default: 1,
            minimum: 1
          }
        },
        required: []
      },
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
    id: 'analyse',
    name: '分析工具',
    icon: '📊',
    tools: [
      {
        name: 'getPageMarkdown',
        description: '智能提取页面内容并转换为 AI 友好的 Markdown 格式，自动识别并保留标题、表格、列表、代码块等结构。支持提取当前页面、单个URL或多个URL（批量并行处理，最多3个并发）。',
        category: 'analyse',
        version: '2.0.0',
        parameters: {
          urls: {
            type: 'array',
            description: '目标页面URL。可以是单个URL或URL数组。默认为"current"表示当前页面。多个URL将并行处理（最多3个同时进行）。',
            placeholder: '["https://example1.com", "https://example2.com"] 或单个URL字符串'
          },
          includeMetadata: {
            type: 'boolean',
            description: '是否包含页面元数据（标题、URL 等）',
            default: true
          }
        },
        required: []
      },
      {
        name: 'baidu_result_scraper',
        description: '解析百度搜索结果页面，提取搜索结果为Markdown表格格式',
        category: 'analyse',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'bing_result_scraper',
        description: '解析Bing搜索结果页面，提取搜索结果为Markdown表格格式',
        category: 'analyse',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'bilibili_search_result_scraper',
        description: '解析Bilibili搜索结果页面，提取视频信息为Markdown表格格式',
        category: 'analyse',
        version: '3.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'cnki_result_scraper',
        description: '解析知网搜索结果页面，提取论文信息为Markdown表格格式',
        category: 'analyse',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'csdn_result_scraper',
        description: '解析CSDN搜索结果页面，提取文章信息为Markdown表格格式',
        category: 'analyse',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'xiaohongshu_result_scraper',
        description: '解析小红书搜索结果页面，提取笔记信息为JSON格式',
        category: 'analyse',
        version: '1.0.0',
        parameters: {
          formatOutput: {
            type: 'boolean',
            description: '是否格式化输出JSON字符串',
            default: true
          }
        },
        required: []
      },
      {
        name: 'github_result_scraper',
        description: '解析GitHub搜索结果页面，提取仓库信息为JSON格式',
        category: 'analyse',
        version: '1.0.0',
        parameters: {
          formatOutput: {
            type: 'boolean',
            description: '是否格式化输出JSON字符串',
            default: true
          }
        },
        required: []
      },
      {
        name: 'mooc_result_scraper',
        description: '解析MOOC搜索结果页面，提取课程信息为JSON格式',
        category: 'analyse',
        version: '1.0.0',
        parameters: {
          formatOutput: {
            type: 'boolean',
            description: '是否格式化输出JSON字符串',
            default: true
          }
        },
        required: []
      },
      {
        name: 'zhihu_result_scraper',
        description: '解析知乎搜索结果页面，提取问答信息为JSON格式',
        category: 'analyse',
        version: '1.0.0',
        parameters: {
          formatOutput: {
            type: 'boolean',
            description: '是否格式化输出JSON字符串',
            default: true
          }
        },
        required: []
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
        description: '在浏览器标签页或窗口中导航到指定的URL',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '要导航到的完整URL',
            placeholder: 'https://example.com'
          },
          newWindow: {
            type: 'boolean',
            description: '是否在新窗口中打开',
            default: false
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
        name: 'browser_screenshot',
        description: '捕获网页截图（可见区域、全页面或特定元素）',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          name: {
            type: 'string',
            description: '截图文件名',
            placeholder: 'screenshot'
          },
          selector: {
            type: 'string',
            description: 'CSS选择器，用于捕获特定元素',
            placeholder: '#content'
          },
          fullPage: {
            type: 'boolean',
            description: '是否捕获整个页面',
            default: false
          },
          savePng: {
            type: 'boolean',
            description: '是否保存为PNG文件',
            default: true
          },
          storeBase64: {
            type: 'boolean',
            description: '是否返回base64编码的图片数据',
            default: false
          }
        },
        required: ['name']
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
        name: 'browser_inject_script',
        description: '在当前页面注入并执行 JavaScript 代码，等同于在 F12 控制台中运行代码',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          code: {
            type: 'string',
            description: 'JavaScript代码',
            multiline: true,
            placeholder: 'document.title'
          }
        },
        required: ['code']
      },
      {
        name: 'browser_page_exec',
        description: '高权限页面脚本执行引擎：自动分层执行（注入→CDP→隔离世界），严格 CSP 站点也能执行 eval；结果超 2000 字符自动暂存为 dataRef（回传前 2000 字符预览），支持 readRef 分页读取',
        category: 'browser',
        version: '1.2.0',
        parameters: {
          code: {
            type: 'string',
            description: 'JavaScript代码（提供 args 时按函数体执行，可用 $args 取参并 return；与 readRef 互斥）',
            multiline: true,
            placeholder: 'return Array.from(document.querySelectorAll("h2")).map(h => h.textContent)'
          },
          args: {
            type: 'array',
            description: '可选参数数组（提供后 code 以 function($args){...} 形式执行）'
          },
          world: {
            type: 'string',
            description: '执行世界：auto=优先主世界 / MAIN=页面主世界（可访问 window 全局对象）/ ISOLATED=隔离世界',
            enum: ['auto', 'MAIN', 'ISOLATED'],
            default: 'auto'
          },
          strategy: {
            type: 'string',
            description: '执行策略：auto=逐级升级（默认）/ cdp=强制最高权限无视 CSP / scripting=只用注入通道',
            enum: ['auto', 'cdp', 'scripting'],
            default: 'auto'
          },
          timeout: {
            type: 'number',
            description: '超时时间（毫秒），默认 15000',
            default: 15000
          },
          saveResult: {
            type: 'boolean',
            description: 'true=强制暂存全量结果（即使 ≤2000 字符）；省略/false=超 2000 字符时自动暂存',
            default: false
          },
          label: {
            type: 'string',
            description: '暂存批次的语义标签（如「第1页-商品列表」）'
          },
          readRef: {
            type: 'string',
            description: '分页读取暂存批次（与 code 互斥）：传执行响应返回的 dataRef ID，返回 JSON 文本切片'
          },
          offset: {
            type: 'number',
            description: 'readRef 模式起始字符偏移（默认 0）',
            default: 0
          },
          limit: {
            type: 'number',
            description: 'readRef 模式本页字符数（默认/上限 2000）',
            default: 2000
          }
        },
        required: []
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
        name: 'browser_network_capture',
        description: '开始捕获网络请求',
        category: 'browser',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'browser_network_capture_stop',
        description: '停止捕获网络请求并返回结果',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          filter: {
            type: 'string',
            description: 'URL过滤器（正则表达式）',
            placeholder: '.*api.*'
          }
        },
        required: []
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
        name: 'browser_web_fetcher',
        description: '获取网页内容和元数据',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '要获取内容的URL（可选，默认当前页面）',
            placeholder: 'https://example.com'
          },
          selector: {
            type: 'string',
            description: 'CSS选择器（可选）',
            placeholder: '#content'
          }
        },
        required: []
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
      // scriptInject / executeJavaScript 已移除：与上方 browser_inject_script 重复且无同名注册工具
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
      {
        name: 'browser_keyboard',
        description: '模拟键盘输入',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          keys: {
            type: 'string',
            description: '要模拟的按键或按键组合',
            placeholder: 'Enter 或 Ctrl+C'
          },
          selector: {
            type: 'string',
            description: '目标元素CSS选择器（可选）',
            placeholder: 'input#search'
          },
          delay: {
            type: 'number',
            description: '按键之间的延迟（毫秒）'
          }
        },
        required: ['keys']
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
      {
        name: 'browser_network_debugger_start',
        description: '启动网络调试器捕获',
        category: 'browser',
        version: '1.0.0',
        parameters: {},
        required: []
      },
      {
        name: 'browser_network_debugger_stop',
        description: '停止网络调试器捕获',
        category: 'browser',
        version: '1.0.0',
        parameters: {},
        required: []
      }
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
        name: 'baidu_search',
        description: '使用百度搜索引擎搜索信息',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
      },
      {
        name: 'bing_search',
        description: '使用Bing搜索引擎搜索信息',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
      },
      {
        name: 'bilibili_search',
        description: '在B站搜索视频内容',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
      },
      {
        name: 'zhihu_search',
        description: '在知乎搜索问答内容',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
      },
      {
        name: 'github_search',
        description: '在GitHub搜索代码仓库',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
      },
      {
        name: 'csdn_search',
        description: '在CSDN搜索技术文章',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
      },
      {
        name: 'mooc_search',
        description: '在中国大学MOOC搜索课程',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
      },
      {
        name: 'xiaohongshu_search',
        description: '在小红书搜索笔记内容',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
      },
      {
        name: 'cnki_search',
        description: '在知网搜索学术论文',
        category: 'search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索查询关键词',
            placeholder: '输入搜索内容'
          }
        },
        required: ['query']
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
        description: '获取当前页面的可见文本内容',
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
        name: 'enhance_click',
        description: '增强点击工具，支持各种点击场景',
        category: 'base',
        version: '1.1.0',
        parameters: {
          selector: {
            type: 'string',
            description: 'CSS选择器',
            placeholder: 'button.submit'
          },
          index: {
            type: 'number',
            description: '如果有多个匹配元素，选择第几个（从0开始）',
            default: 0
          }
        },
        required: ['selector']
      },
      {
        name: 'enhance_fill',
        description: '增强填充工具，支持各种输入场景',
        category: 'base',
        version: '1.1.0',
        parameters: {
          selector: {
            type: 'string',
            description: 'CSS选择器',
            placeholder: 'input[name="username"]'
          },
          value: {
            type: 'string',
            description: '要填充的值',
            placeholder: '输入内容'
          }
        },
        required: ['selector', 'value']
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
        description: '等待指定秒数',
        category: 'common',
        version: '1.0.0',
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
      { name: 'screenshot', description: '截取原始视口，返回 screenshotId', category: 'vision', version: '3.0.0', parameters: {}, required: [] },
      ...createGuiTools().map(tool => ({ name: tool.name, description: tool.metadata.description, category: 'vision', version: '3.0.0', parameters: tool.openaiSchema.function.parameters.properties, required: tool.openaiSchema.function.parameters.required || [] })),
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
    id: 'integrated-search',
    name: '集成搜索',
    icon: '🔍',
    tools: [
      {
        name: 'bing_integrated_search',
        description: 'Bing集成搜索 - 自动跳转、等待加载并提取搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: '人工智能最新发展'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '3000',
            default: 3000
          }
        },
        required: ['query']
      },
      {
        name: 'baidu_integrated_search',
        description: '百度集成搜索 - 自动跳转、等待加载并提取搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: 'TypeScript 最佳实践'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '3000',
            default: 3000
          }
        },
        required: ['query']
      },
      {
        name: 'bilibili_integrated_search',
        description: 'Bilibili集成搜索 - 自动跳转、等待加载并提取视频搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: 'Vue3教程'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '3000',
            default: 3000
          }
        },
        required: ['query']
      },
      {
        name: 'zhihu_integrated_search',
        description: '知乎集成搜索 - 自动跳转、等待加载并提取问答搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: '如何学习编程'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '3000',
            default: 3000
          }
        },
        required: ['query']
      },
      {
        name: 'github_integrated_search',
        description: 'GitHub集成搜索 - 自动跳转、等待加载并提取仓库搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: 'machine learning python'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '3000',
            default: 3000
          }
        },
        required: ['query']
      },
      {
        name: 'csdn_integrated_search',
        description: 'CSDN集成搜索 - 自动跳转、等待加载并提取技术文章搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: 'React Hooks 最佳实践'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '3000',
            default: 3000
          }
        },
        required: ['query']
      },
      {
        name: 'mooc_integrated_search',
        description: '中国大学MOOC集成搜索 - 自动跳转、等待加载并提取课程搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: '数据结构与算法'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '3000',
            default: 3000
          }
        },
        required: ['query']
      },
      {
        name: 'xiaohongshu_integrated_search',
        description: '小红书集成搜索 - 自动跳转、等待加载并提取笔记搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: '旅游攻略'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '3000',
            default: 3000
          }
        },
        required: ['query']
      },
      {
        name: 'cnki_integrated_search',
        description: '知网(CNKI)集成搜索 - 自动跳转、等待加载并提取学术文献搜索结果（Markdown表格）',
        category: 'integrated-search',
        version: '1.0.0',
        parameters: {
          query: {
            type: 'string',
            description: '搜索关键词',
            placeholder: '深度学习图像识别'
          },
          waitTime: {
            type: 'number',
            description: '页面加载后额外等待时间（毫秒）',
            placeholder: '5000',
            default: 5000
          }
        },
        required: ['query']
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
            placeholder: '["browser_navigate", "enhance_click"]'
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
