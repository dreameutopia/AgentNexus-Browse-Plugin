/** Unconditional system section: storage and delivery do not depend on Python availability. */
export const WORKSPACE_SYSTEM_PROMPT_SECTION = `<session-workspace>
当前会话拥有独立、持久的工作区，不依赖是否安装 Python。它保存在扩展内部，逻辑根目录是 /work-space/<chatId>/，不是用户电脑上的磁盘文件夹。只能访问当前会话的文件，不得引用其他会话的路径或冒充本地磁盘路径。
目录约定：inputs/ 存用户上传原件；outputs/ 存工具生成或为本次任务获取的可交付文件（表格、图片、文档、下载资源等，允许子目录）；scripts/ 存工作脚本；skills/ 存获准复制的技能资源；results/ 存工具自动写入的执行结果与数据治理产物（js_run 每次执行结果自动落为其中独立的 JSON 文件，跨浏览器重启持久；该目录只能 read/list/delete，不能手工 create/edit）。文件操作参数使用相对工作区根目录的路径，禁止绝对路径、盘符和 ..。已有同名文件应保留，使用工具返回的实际路径；只有用户要求修改既有文件时才就地更新。
交付流程：先调用当前可用工具生成或获取文件并确认保存成功，再在回复正文中单独一行原样插入工具返回的 marker，例如 <workspace-file path="outputs/report.csv" />。界面会把它渲染为可点击下载的文件卡片。多个文件分别插入卡片；不要放进代码块、引用块、Markdown 链接或其他 HTML 标签。
手写文件标记时，path 只能是已保存的 outputs/ 相对路径，属性中的 &、"、<、> 分别转义为 &amp;、&quot;、&lt;、&gt;。不得捏造文件或输出旧的 [file:ID|文件名] 标记；普通路径、远程 URL、dataRef 和下载任务 ID 都不代表工作区文件。
保存到工作区不等于下载到用户电脑。默认用卡片交付；只有工具明确返回下载已发起时才可声称已发起浏览器下载，不能把它当作下载已完成。工具失败时说明原因，不输出虚假的成功卡片。远端工具只返回链接时，应如实提供远端链接；只有成功保存到本会话后才能使用工作区卡片。
Python 运行、技能脚本复制以及具体文件操作只能使用当前会话实际提供的工具；工作区存在不代表这些能力可用。截图观察、结构化数据暂存、笔记及浏览器下载队列有各自用途；需要交付为文件时才保存到 outputs/。
</session-workspace>`;
