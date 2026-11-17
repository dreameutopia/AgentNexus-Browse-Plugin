/** Cross-cutting boundary audit: new page APIs must not silently bypass scope. */
import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const files = parsed.fileNames.filter(file => /[\\/]tools[\\/]/.test(file));
const program = ts.createProgram(files, parsed.options);
const checker = program.getTypeChecker();
const violations = [];
for (const source of program.getSourceFiles()) {
  const relative = path.relative(root, source.fileName).replaceAll('\\', '/');
  if (!relative.startsWith('tools/') || relative.endsWith('browser-scope.ts')) continue;
  const report = (node, reason) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    violations.push(`${relative}:${line} ${reason}`);
  };
  const walk = node => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'chrome' &&
      ['tabs', 'windows', 'scripting', 'debugger'].includes(node.name.text)) {
      let typeReference = false;
      for (let parent = node.parent; parent && !ts.isStatement(parent); parent = parent.parent)
        if (ts.isTypeNode(parent)) typeReference = true;
      if (!typeReference) report(node, 'Use the explicit browser scope facade for page APIs');
    }
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      const contextIndex = declaration?.parameters.findIndex(parameter =>
        ts.isIdentifier(parameter.name) && parameter.name.text === 'context' && parameter.type?.getText().includes('ToolExecutionContext'));
      const hasContext = checker.getSymbolsInScope(node, ts.SymbolFlags.Value).some(symbol => symbol.name === 'context');
      if (contextIndex >= 0 && node.arguments.length <= contextIndex && hasContext)
        report(node, `Forward execution context to ${node.expression.getText(source)}`);
      const name = declaration?.name?.getText();
      const optionsIndex = name === 'resolveTabTarget' ? 0 : name === 'resolvePageTarget' ? 1 : -1;
      const options = node.arguments[optionsIndex];
      if (hasContext && options && ts.isObjectLiteralExpression(options) && !options.properties.some(property =>
        ts.isSpreadAssignment(property) || property.name?.getText() === 'context'))
        report(node, `Forward context in ${name} options before target activation`);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
}
assert.deepEqual(violations, [], `Window boundary omissions:\n${violations.join('\n')}`);
console.log('[window-binding-audit] Page APIs and target resolvers preserve explicit execution context.');
