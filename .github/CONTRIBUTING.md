# AgentNexus Browse Helper — Contributing Guide

First off, thank you for considering contributing to **AgentNexus Browse Helper**! It's people like you who make this project great.

## 📜 Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## 🤔 How Can I Contribute?

### Report Bugs

Bug reports are tracked as [GitHub Issues](https://github.com/your-org/AgentNexus-Browse-Plugin/issues). When creating a bug report, please use the **Bug Report** template and include:

- **Clear title and description**
- **Steps to reproduce** the issue
- **Expected behavior** vs. **actual behavior**
- **Screenshots** or logs if applicable
- **Environment details** (Chrome version, OS, extension version)

### Request Features

Feature requests are also tracked as [GitHub Issues](https://github.com/your-org/AgentNexus-Browse-Plugin/issues). Please use the **Feature Request** template and describe:

- **The problem** you're trying to solve
- **Your proposed solution**
- **Alternative solutions** you've considered
- **Additional context** or mockups

### Submit Pull Requests

1. **Fork** the repository
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-fix-name
   ```
3. **Make your changes** with clear, descriptive commits
4. **Test your changes**:
   ```bash
   npm run compile   # Type check
   npm run lint      # Lint check
   npm run build     # Build test
   ```
5. **Push** to your fork and submit a **Pull Request**

## 🏗️ Development Setup

### Prerequisites

- **Node.js** 18+
- **Chrome** 90+ (for testing)

### Setup Steps

```bash
# Clone the repo
git clone https://github.com/your-org/AgentNexus-Browse-Plugin.git
cd AgentNexus-Browse-Plugin

# Install dependencies
npm install

# Start development
npm run dev
```

### Project Structure

```
├── entrypoints/       # Extension entry points (background, sidepanel, content scripts)
├── tools/             # Tool system (40+ tools)
│   ├── base/          # Base tools (page info, tab management)
│   ├── browser/       # Browser interaction tools
│   ├── search/        # Multi-platform search tools
│   ├── vision/        # Screenshot, OCR, element detection
│   ├── automation/    # Automation tools (form filler, AI action)
│   ├── resource/      # Resource sniffer & downloader
│   ├── bilibili/      # Bilibili-specific tools
│   ├── navigation/    # Bookmark & history navigation
│   ├── note/          # Note management
│   ├── code/          # Code rendering tools
│   ├── excalidraw/    # Diagram drawing
│   └── ...
├── common/            # Shared types and utilities
├── utils/             # Helper functions
├── inject-scripts/    # Content script injectors
├── public/            # Static assets
├── docs/              # Documentation
└── _locales/          # i18n translations
```

## 🧩 Adding a New Tool

1. Create a new file in the appropriate `tools/` subdirectory
2. Extend the proper base class (`BaseTool`, `BaseSearchTool`, etc.)
3. Implement `name`, `metadata`, and `execute()` method
4. Register in the category's `index.ts` and `tools/index.ts`
5. Add tests and documentation

Example:

```typescript
import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { ToolResult } from '@/common/tool-handler';

export class MyNewTool extends BaseTool {
  name = 'my_new_tool';

  metadata: ToolMetadata = {
    name: 'my_new_tool',
    description: 'Description of what this tool does',
    category: 'category',
    version: '1.0.0',
  };

  async execute(args: any): Promise<ToolResult> {
    return {
      success: true,
      data: {},
      content: [{ type: 'text', text: 'Result' }],
    };
  }
}
```

## 📝 Commit Messages

Please follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new search tool for Arxiv
fix: resolve screenshot crash on large pages
docs: update API reference for v2.0
style: format code with prettier
refactor: simplify tool registration logic
test: add unit tests for vision tools
chore: update dependencies
```

## 🔍 Code Style

- **TypeScript** with strict type checking
- **ESLint** + **Prettier** for formatting
- Run `npm run lint:fix` and `npm run format` before committing

## 💬 Questions?

Feel free to open a [Discussion](https://github.com/your-org/AgentNexus-Browse-Plugin/discussions) for any questions.

---

Thank you for your contributions! 🎉
