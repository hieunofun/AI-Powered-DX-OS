// Project-owned static boundary checks using the existing TypeScript compiler.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const repository = path.resolve(__dirname, '../..');
const sourceRoot = path.join(repository, 'apps/api/src');
const platformRoot = path.join(sourceRoot, 'platform');
const neutralRoots = ['packages/shared-types', 'packages/shared-utils'].map(part => path.join(repository, part));
const configPath = path.join(repository, 'apps/api/tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).options;
const inside = (file, directory) => {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
const business = /purchase[_-]?orders?|goods[_-]?receipts?|invoices?|employees?|payroll|\bPO\b|\bGRN\b/i;

function checkSource(fileName, content) {
  const errors = [];
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true);
  const add = (node, message) => errors.push(`${path.relative(repository, fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${message}`);
  function moduleTarget(node, specifier) {
    if (!ts.isStringLiteralLike(specifier)) { add(node, 'Computed module loading is forbidden in platform'); return; }
    const name = specifier.text;
    const resolved = ts.resolveModuleName(name, fileName, options, ts.sys).resolvedModule;
    if (!resolved) {
      if (name.startsWith('.') || name.startsWith('@smartprocure/')) add(node, 'Unresolved project import: ' + name);
      return;
    }
    // Resolve workspace symlinks before deciding whether an import is external.
    const target = fs.realpathSync(resolved.resolvedFileName);
    if (target.split(path.sep).includes('node_modules')) return;
    if (inside(target, platformRoot) || neutralRoots.some(directory => inside(target, directory))) return;
    add(node, 'Platform import crosses its boundary: ' + name);
  }
  function visit(node) {
    if ((ts.isIdentifier(node) || ts.isStringLiteralLike(node)) && business.test(node.text)) add(node, 'Business vocabulary belongs outside platform: ' + node.text);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) moduleTarget(node, node.moduleSpecifier);
    if (ts.isImportTypeNode(node)) moduleTarget(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      if (node.arguments.length !== 1) add(node, 'Module loading requires one literal target');
      else moduleTarget(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return errors;
}

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}

function checkRepository() {
  const sources = files(platformRoot);
  const errors = sources.flatMap(file => checkSource(file, fs.readFileSync(file, 'utf8')));
  if (errors.length) throw new Error(errors.join('\n'));
  return { platformFiles: sources.length, businessImports: 0, businessVocabulary: 0 };
}
if (require.main === module) {
  try { process.stdout.write(JSON.stringify(checkRepository()) + '\n'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { checkSource, checkRepository, platformRoot };
