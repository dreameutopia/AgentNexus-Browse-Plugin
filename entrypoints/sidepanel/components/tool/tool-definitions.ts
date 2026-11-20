import { PageExecTool } from '@/tools/browser/page-exec-tool';
import { BrowserObserveTool } from '@/tools/browser/observe';
import { BrowserInteractTool } from '@/tools/browser/interact';
import { browserDownloadClickTool } from '@/tools/browser/download-click';
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
    id: 'file-util',
    name: '工作区文件工具',
    icon: '📎',
    tools: [
      {
        name: 'file_util',
        description: '会话工作区唯一文件入口：文本文件创建/追加/编辑/删除、分页读取文本与 Office 文档、任意类型文件副本、目录盘点、路径与内容正则搜索',
        category: 'file-util',
        version: '2.0.0',
        parameters: {
          action: {
            type: 'string',
            description: '操作类型：read / create / append / edit / delete / copy / list / search / grep',
            placeholder: 'read'
          },
          path: {
            type: 'string',
            description: '工作区相对路径（list/search 可省略或传 "." 表示根目录；grep 用 files）',
            placeholder: '例如：inputs/简历.pdf'
          },
          index: {
            type: 'number',
            description: '仅 read：页码（1 起，缺省第 1 页；每页最多 3000 字符）',
            placeholder: '1'
          },
          content: {
            type: 'string',
            description: 'create/append：文件内容；edit：全量重写的内容',
            placeholder: ''
          },
          find: {
            type: 'string',
            description: '仅 edit：待替换片段（默认须唯一命中）',
            placeholder: ''
          },
          replace: {
            type: 'string',
            description: '仅 edit：替换后的新内容',
            placeholder: ''
          },
          target: {
            type: 'string',
            description: '仅 copy：副本的完整目标路径（后缀必须与源文件一致）',
            placeholder: '例如：outputs/report-copy.md'
          },
          pattern: {
            type: 'string',
            description: 'search/grep：正则表达式（search 匹配路径，grep 匹配行内容）',
            placeholder: ''
          },
          files: {
            type: 'string',
            description: '仅 grep：要搜索的工作区相对路径列表（1~50 个）',
            placeholder: 'content/a.md,content/b.md'
          },
          offset: {
            type: 'number',
            description: '仅 list/search/grep：分页偏移（条目维度）',
            placeholder: '0'
          },
          limit: {
            type: 'number',
            description: '仅 list/search/grep：每页条目数（list ≤200、search/grep ≤30）',
            placeholder: '100'
          }
        },
        required: ['action']
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
        name: 'browser_navigation',
        description: '统一页面导航：打开/刷新/历史前进后退/等待加载（action 驱动）',
        category: 'browser',
        version: '3.0.0',
        parameters: {
          action: {
            type: 'string',
            description: 'open=打开URL / refresh=刷新 / back=后退 / forward=前进 / wait=等待加载就绪',
            enum: ['open', 'refresh', 'back', 'forward', 'wait']
          },
          url: {
            type: 'string',
            description: '仅 action=open：要导航到的完整URL',
            placeholder: 'https://example.com'
          },
          newTab: {
            type: 'boolean',
            description: '仅 action=open：是否在现有窗口新建标签页；false 使用当前标签页',
            default: true
          },
          waitForLoad: {
            type: 'boolean',
            description: '仅 open/refresh/back/forward：是否等待页面就绪再返回',
            default: true
          },
          timeout: {
            type: 'number',
            description: '等待上限（毫秒），默认30000',
            default: 30000
          },
          checkInterval: {
            type: 'number',
            description: '仅 action=wait：轮询间隔（毫秒），默认500，50~10000',
            default: 500
          },
          tabId: {
            type: 'number',
            description: '仅 action=wait：要等待的标签页ID（缺省当前活动标签）',
            placeholder: '留空表示当前标签页'
          }
        },
        required: ['action']
      },
      {
        name: 'browser_tabs',
        description: '标签页与窗口管理：枚举/切换/关闭/创建标签页与窗口树（action 驱动）',
        category: 'browser',
        version: '3.0.0',
        parameters: {
          action: {
            type: 'string',
            description: 'list=枚举标签页 / switch=切换 / close=关闭 / create=新建 / windows=窗口树枚举',
            enum: ['list', 'switch', 'close', 'create', 'windows']
          },
          currentWindow: {
            type: 'boolean',
            description: '仅 action=list：是否只枚举当前窗口（默认全部窗口）'
          },
          tabId: {
            type: 'number',
            description: 'switch 必填 / close 单个：目标标签页ID',
            placeholder: '输入标签页ID'
          },
          tabIds: {
            type: 'array',
            items: { type: 'number' },
            description: '仅 action=close：批量关闭的标签页ID列表（与tabId、url互斥）'
          },
          url: {
            type: 'string',
            description: 'close=按URL匹配关闭（与tabId、tabIds互斥）；create=新标签页URL',
            placeholder: 'https://example.com'
          },
          active: {
            type: 'boolean',
            description: '仅 action=create：是否激活新标签页',
            default: true
          }
        },
        required: ['action']
      },
      {
        name: 'browser_input',
        description: '快捷键与系统剪贴板：派发原生组合键 / 读写剪贴板 / 把工作区文件整表粘贴进页面（action 驱动）',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          action: {
            type: 'string',
            description: 'keys=派发快捷键 / type=向当前焦点插入文本 / clipboard_write=写剪贴板 / clipboard_read=读剪贴板 / clipboard_paste=写剪贴板并粘贴',
            enum: ['keys', 'type', 'clipboard_write', 'clipboard_read', 'clipboard_paste']
          },
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 keys：一个主键 + 至多四个修饰键（如 ["Mod","v"]）',
            placeholder: '["Mod","v"]'
          },
          text: {
            type: 'string',
            description: 'type 的插入文本；clipboard_write/clipboard_paste 的内联内容',
            placeholder: '要插入或写入的文本'
          },
          path: {
            type: 'string',
            description: '仅 clipboard_write/clipboard_paste：工作区相对路径（如 outputs/榜单.csv）',
            placeholder: 'outputs/榜单.csv'
          },
          asTsv: {
            type: 'boolean',
            description: '仅 clipboard_write/clipboard_paste：CSV 转制表符分隔（粘贴进表格按列展开）',
            default: false
          },
          clear: {
            type: 'boolean',
            description: '仅 type：插入前先全选退格清空当前编辑器',
            default: false
          }
        },
        required: ['action']
      },
      {
        name: 'browser_page_ops',
        description: '轻量页面操作：按屏滚动整页 / 等待指定元素出现（action 驱动，无需 DOM 引用）',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          action: {
            type: 'string',
            description: 'scroll=按屏滚动整页；wait_element=等待元素出现',
            enum: ['scroll', 'wait_element']
          },
          direction: {
            type: 'string',
            description: '仅 action=scroll：滚动方向',
            enum: ['up', 'down']
          },
          screens: {
            type: 'number',
            description: '仅 action=scroll：滚动屏数（实际距离 = 视口高度 × 95% × 屏数，上限100）',
            default: 1,
            placeholder: '1'
          },
          clickBox: {
            type: 'array',
            description: '仅 action=scroll：点击坐标box2d格式 [x1, y1, x2, y2]（选填，如有值将先点击该区域中心点）',
            placeholder: '[100, 200, 300, 400]'
          },
          selector: {
            type: 'string',
            description: '仅 action=wait_element：要等待的元素CSS选择器',
            placeholder: '#loading-indicator'
          },
          timeout: {
            type: 'number',
            description: '仅 action=wait_element：等待超时时间（毫秒，默认5000，上限120000）',
            default: 5000
          }
        },
        required: ['action']
      },
      {
        name: 'browser_wait',
        description: '按条件等待页面达到目标状态（地址/文案/控件/网络/就绪），超时返回逐条件达成情况',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          conditions: {
            type: 'array',
            description: '等待条件列表（全部满足才算命中）',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  description:
                    'url_contains=地址含子串；url_matches=地址匹配正则；text_present=出现文案；' +
                    'text_absent=文案消失；element_visible=选择器可见；element_hidden=选择器不可见；' +
                    'network_idle=网络静默；page_ready=文档就绪',
                  enum: [
                    'url_contains',
                    'url_matches',
                    'text_present',
                    'text_absent',
                    'element_visible',
                    'element_hidden',
                    'network_idle',
                    'page_ready'
                  ]
                },
                value: {
                  type: 'string',
                  description: '条件参数：文案 / CSS 选择器 / 地址子串 / 正则'
                }
              },
              required: ['type']
            }
          },
          timeoutMs: {
            type: 'number',
            description: '等待上限（毫秒，默认 30000，上限 100000）',
            default: 30000
          },
          intervalMs: {
            type: 'number',
            description: '轮询间隔（毫秒，默认 300）',
            default: 300
          },
          tabId: {
            type: 'number',
            description: '目标标签页 ID（可选；省略=当前活动页）'
          }
        },
        required: ['conditions']
      },
      {
        name: 'browser_extract_data',
        description: '从页面 DOM 精确提取结构化数据（表格/列表/选择器），免疫 CSP；批量结果自动落为工作区数据文件，可直出 Excel',
        category: 'browser',
        version: '2.0.0',
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
          },
          save: {
            type: 'string',
            description: '落盘策略：auto=超过 20 行自动存为 results/ 数据文件（推荐）/ always / never',
            enum: ['auto', 'always', 'never'],
            default: 'auto'
          },
          saveTo: {
            type: 'string',
            description: '交付文件路径（outputs/ 下，.json/.csv/.md），提供后总是落盘并返回文件标记',
            placeholder: 'outputs/商品列表.csv'
          },
          format: {
            type: 'string',
            description: '落盘格式（saveTo 扩展名优先；不填则 json）：json / csv / md（md 仅用于 saveTo 交付）',
            enum: ['json', 'csv', 'md']
          },
          previewRows: {
            type: 'number',
            description: '落盘后回传的预览行数（默认 5，上限 20）',
            default: 5
          },
          label: {
            type: 'string',
            description: '结果文件标签（进入文件名，如「第3页」）',
            placeholder: '第3页'
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
      // scriptInject / executeJavaScript 已移除：无同名注册工具；脚本统一使用 js_run
      // 历史与书签已按域合并为一个工具（browser_history_bookmarks，九 action）：
      // 旧名 browser_search_history / browser_search_bookmarks /
      // browser_bookmark_create / browser_bookmark_delete / quick_navigation /
      // history_navigation / bookmark_navigation 全部删除，不得回潮。
      {
        name: 'browser_history_bookmarks',
        description: '浏览历史与书签统一管理：检索/打开/增删改/最近访问/最常访问/文件夹结构（action 驱动）',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          action: {
            type: 'string',
            description:
              'search=检索 / open=打开 / create=新增书签或文件夹 / update=改或移书签 / delete=删书签 / clear=清理浏览历史 / recent=最近访问 / top=最常访问 / folders=文件夹结构',
            enum: ['search', 'open', 'create', 'update', 'delete', 'clear', 'recent', 'top', 'folders']
          },
          query: {
            type: 'string',
            description: '仅 action=search：关键词（匹配标题或 URL，留空取全部）',
            placeholder: '关键词'
          },
          source: {
            type: 'string',
            description: '仅 action=search/open：history=历史 / bookmark=书签 / both=两者（默认 both）',
            enum: ['history', 'bookmark', 'both']
          },
          since: {
            type: 'string',
            description: '仅 action=search/recent：时间窗起点（today / 3 days ago / 2w / ISO / 毫秒时间戳）',
            placeholder: '1 day ago'
          },
          until: {
            type: 'string',
            description: '仅 action=search/recent：时间窗终点（缺省为现在）'
          },
          limit: {
            type: 'number',
            description: '仅 action=search/recent/top：返回条数上限（1~100）',
            default: 20
          },
          sort: {
            type: 'string',
            description: '仅 action=search：relevance=相关度 / recent=最后访问 / visited=访问次数',
            enum: ['relevance', 'recent', 'visited']
          },
          excludeCurrentTabs: {
            type: 'boolean',
            description: '仅 action=search：是否排除当前已打开的标签页地址',
            default: false
          },
          autoOpen: {
            type: 'boolean',
            description: '仅 action=search：唯一命中时是否直接打开该页面',
            default: false
          },
          url: {
            type: 'string',
            description: 'action=open 要打开的地址 / create 新书签地址 / update、delete 按地址定位书签',
            placeholder: 'https://example.com'
          },
          id: {
            type: 'string',
            description: '仅 action=open：条目 id（来自 search/recent/top 的结果）'
          },
          newTab: {
            type: 'boolean',
            description: '仅 action=open：是否在现有窗口新建标签页',
            default: true
          },
          waitForLoad: {
            type: 'boolean',
            description: '仅 action=open：是否等待页面就绪再返回',
            default: true
          },
          timeout: {
            type: 'number',
            description: '仅 action=open：等待页面就绪上限（毫秒）',
            default: 30000
          },
          title: {
            type: 'string',
            description: 'action=create 书签标题（folder=true 时为文件夹名）/ update 新标题',
            placeholder: '我的书签'
          },
          parentId: {
            type: 'string',
            description: 'action=create 父文件夹 id（默认 1 书签栏）/ update 移到该文件夹 / folders 只列该子树'
          },
          folder: {
            type: 'boolean',
            description: '仅 action=create：true=新建文件夹（此时只需 title）',
            default: false
          },
          bookmarkId: {
            type: 'string',
            description: 'action=update/delete：书签 id（精确寻址）',
            placeholder: 'bookmark-id'
          },
          all: {
            type: 'boolean',
            description: '仅 action=clear：true=清空全部浏览历史（不可逆，需用户批准）；否则必须给 since 指定时间窗',
            default: false
          }
        },
        required: ['action']
      },
      // rightClick / drag 已移除：当前 toolRegistry 中无对应注册工具
      // 窗口枚举（原 browser_window）已并入 browser_tabs(action="windows")
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
      // 历史前进后退 / 刷新已并入 browser_navigation（action=back/forward/refresh）；
      // 标签页关闭/创建/切换已并入 browser_tabs
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
          '通用网页搜索：一次调用完成「导航到搜索引擎结果页 → 等待加载 → 解析结构化结果 → Markdown 表格」（bing / baidu）。' +
          '⚠ 自带页面导航（效果等同 browser_navigation(action="open")），禁止同一轮并发调用；返回 navigation（是否成功 + 当前网址）与 results（条目与 Markdown 表，解析失败时用 read_website 自行解析）',
        category: 'search',
        version: '1.0.0',
        parameters: {
          engine: {
            type: 'string',
            description: '目标搜索引擎（枚举）：bing=Bing、baidu=百度',
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
        required: ['engine', 'query']
      },
      {
        name: 'platform_search',
        description:
          '站点平台搜索：一次调用完成「导航到站点搜索结果页 → 等待加载 → 解析结构化结果 → Markdown 表格」（知乎 / GitHub / CSDN / MOOC / 小红书 / 知网）。' +
          '⚠ 自带页面导航（效果等同 browser_navigation(action="open")），禁止同一轮并发调用；知乎/小红书等需登录态，未登录可能返回登录墙或空结果',
        category: 'search',
        version: '1.0.0',
        parameters: {
          platform: {
            type: 'string',
            description:
              '目标站点平台（枚举）：zhihu=知乎、github=GitHub、csdn=CSDN、mooc=中国大学MOOC、xiaohongshu=小红书、cnki=中国知网',
            placeholder: 'zhihu'
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
        required: ['platform', 'query']
      }
    ]
  },
  {
    id: 'base',
    name: '基础工具',
    icon: '⚙️',
    tools: [
      {
        name: 'read_website',
        description: '读取网页正文为结构化 Markdown 并落盘 content/*.md：保留标题层级/表格/列表/代码块+语言/链接/引用；覆盖全部 iframe 与可访问 shadow root；单页 3000 字符、超出自动分页（CSV：content,page,totalPages,path）；支持 url 直读，后续页用 file_util(action="read", path, index) 续读',
        category: 'base',
        version: '1.0.0',
        parameters: {
          url: {
            type: 'string',
            description: '目标网址（可选，仅单个 http/https；前台新建并激活标签页打开、等待加载完成后提取，标签页保留可见不自动关闭；与 tabId 互斥）',
            placeholder: 'https://example.com（留空读当前标签页）'
          },
          tabId: {
            type: 'number',
            description: '标签页ID（可选，默认当前活动标签页；也接受纯数字字符串；显式传入会先核对存在性与可注入性、再切换到该页；与 url 互斥）',
            placeholder: '留空表示当前标签页'
          },
          path: {
            type: 'string',
            description: '续读用：上次返回的 content/*.md 工作区路径（只读文件、不访问页面；与 url/tabId 互斥）',
            placeholder: 'content/example-com-list-a1b2.md'
          },
          page: {
            type: 'number',
            description: '页码（可选，默认 1；每页 3000 字符）',
            placeholder: '1'
          }
        },
        required: []
      },
      {
        name: 'browser_get_page_html',
        description: '获取当前页面的HTML源代码或可见纯文本（可含全部iframe，带长度上限）',
        category: 'base',
        version: '2.0.0',
        parameters: {
          tabId: {
            type: 'number',
            description: '标签页ID（可选，默认当前活动标签页）',
            placeholder: '留空表示当前标签页'
          },
          format: {
            type: 'string',
            description: '返回格式：html=源码（默认）；text=可见纯文本',
            enum: ['html', 'text'],
            default: 'html'
          },
          includeIframes: {
            type: 'boolean',
            description: '是否包含全部iframe内容（默认false=只取主frame）',
            default: false
          },
          maxChars: {
            type: 'number',
            description: '返回内容的字符上限（默认200000，超限截断并标注truncated）',
            default: 200000
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
  // 「通用」分组已随 generic_wait 移除：条件等待由 browser_wait 承载（browser 组），
  // 空分组只会让面板出现无内容的标题行。
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
    name: '资源与下载工具',
    icon: '📦',
    tools: [
      {
        name: 'browser_resources',
        description: '页面资源与下载捕获：嗅探/列出/下载/直链下载/下载拦截/捕获副本/导出副本/状态（action 驱动）',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          action: {
            type: 'string',
            description:
              'sniff=嗅探 / list=列出缓存 / download=下载嗅探结果 / fetch=直链下载 / intercept=旧版全局捕获状态 / captured=历史副本库 / export=导出副本 / status=总体状态',
            enum: ['sniff', 'list', 'download', 'fetch', 'intercept', 'captured', 'export', 'status']
          },
          fileTypes: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 action=sniff：要嗅探的类型（扩展名或类别名 document/archive/video/audio/image/code/font/data）'
          },
          maxResults: {
            type: 'number',
            description: '仅 action=sniff：最多返回多少条',
            default: 10,
            minimum: 1,
            maximum: 100
          },
          includeImages: {
            type: 'boolean',
            description: '仅 action=sniff：是否包含图片类资源',
            default: false
          },
          resourceIds: {
            type: 'array',
            items: { type: 'string' },
            description: '仅 action=download：要下载的资源 id 列表（来自 sniff/list）'
          },
          downloadPath: {
            type: 'string',
            description: '仅 action=download：保存文件名（相对下载目录）'
          },
          url: {
            type: 'string',
            description: '仅 action=fetch：要下载的完整 URL',
            placeholder: 'https://example.com/file.zip'
          },
          filename: {
            type: 'string',
            description: '仅 action=fetch/export：保存文件名'
          },
          operation: {
            type: 'string',
            description:
              '仅 action=intercept/captured：子动作。intercept=stop/state；captured=list/get/clear',
            enum: ['stop', 'state', 'list', 'get', 'clear']
          },
          fileId: {
            type: 'string',
            description: '仅 action=captured operation=get 与 action=export：捕获副本的 id',
            placeholder: 'file-xxx'
          },
          limit: {
            type: 'number',
            description: '仅 action=captured operation=list：返回条数上限',
            default: 50,
            minimum: 1,
            maximum: 200
          },
          offset: {
            type: 'number',
            description: '仅 action=captured operation=list：偏移量（分页用）',
            default: 0,
            minimum: 0
          },
          openAfterDownload: {
            type: 'boolean',
            description: '仅 action=download/fetch：下载完成后是否用系统默认程序打开',
            default: false
          }
        },
        required: ['action']
      },
      {
        name: 'browser_downloads',
        description: '浏览器下载管理：查询/取消/暂停/恢复/清除历史/定位文件/打开文件（action 驱动）',
        category: 'browser',
        version: '1.0.0',
        parameters: {
          action: {
            type: 'string',
            description: 'list=查询 / cancel=取消 / pause=暂停 / resume=恢复 / erase=清除历史 / show=定位 / open=打开',
            enum: ['list', 'cancel', 'pause', 'resume', 'erase', 'show', 'open']
          },
          state: {
            type: 'string',
            description: '仅 action=list：按状态过滤',
            enum: ['all', 'in_progress', 'complete', 'interrupted'],
            default: 'all'
          },
          limit: {
            type: 'number',
            description: '仅 action=list：返回条数上限',
            default: 10,
            minimum: 1,
            maximum: 100
          },
          query: {
            type: 'string',
            description: '仅 action=list：按文件名或地址子串过滤',
            placeholder: '搜索关键词...'
          },
          orderBy: {
            type: 'string',
            description: '仅 action=list：排序字段（一律降序）',
            enum: ['startTime', 'bytesReceived', 'totalBytes'],
            default: 'startTime'
          },
          downloadId: {
            type: 'number',
            description: 'cancel/pause/resume/show/open 必填：下载任务 ID',
            placeholder: '123'
          },
          downloadIds: {
            type: 'array',
            items: { type: 'number' },
            description: '仅 action=erase：要清除历史记录的下载 ID 列表'
          }
        },
        required: ['action']
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
categories.find(c=>c.id==='browser')!.tools.push(...[new BrowserObserveTool(),new BrowserInteractTool(),new NetworkObserverTool(),new PageExecTool(),browserDownloadClickTool].map(tool=>({
 name:tool.name,description:tool.metadata.description,category:tool.metadata.category,version:tool.metadata.version,parameters:tool.openaiSchema.function.parameters.properties as any,required:tool.openaiSchema.function.parameters.required || []
})));
