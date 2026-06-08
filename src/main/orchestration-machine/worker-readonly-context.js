const { normalizeWriteSetPath } = require('./write-sets');

const DEFAULT_VALIDATION_CONTEXT_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
  'playwright.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vitest.config.ts',
  'jest.config.js',
  'jest.config.mjs',
  'jest.config.cjs',
  'jest.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'jsconfig.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  'postcss.config.js',
  'postcss.config.cjs',
  'tailwind.config.js',
  'tailwind.config.cjs',
  'tailwind.config.ts',
  'next.config.js',
  'next.config.mjs',
  'webpack.config.js',
  'webpack.config.cjs',
  'scripts',
]);

const DEFAULT_VISUAL_RENDER_CONTEXT_FILES = Object.freeze([
  'index.html',
  'public',
  'src/renderer',
  'src/web',
  'tests/e2e',
  'test/e2e',
  'e2e',
]);

const VALIDATION_CONTEXT_RE = /\b(npm|pnpm|yarn|bun|node\s+--test|node\s+tests?\/|playwright|vitest|jest|cypress|storybook|vite|webpack|next|eslint|tsc|typecheck|build|test:|visual|screenshot|renderer|browser|e2e)\b/i;
const VISUAL_RENDER_CONTEXT_RE = /\b(visual|screenshot|browser|e2e|playwright|renderer|hero|theme|surface)\b/i;

function itemValidationText(item = {}) {
  return [
    item.verificationPlan,
    item.expectedBehavior,
    item.actualBehavior,
    ...(Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria : []),
    ...(Array.isArray(item.reproSteps) ? item.reproSteps : []),
    ...(Array.isArray(item.validationCommands) ? item.validationCommands : []),
    ...(Array.isArray(item.verificationCommands) ? item.verificationCommands : []),
    ...(Array.isArray(item.sourceOfTruthTargets) ? item.sourceOfTruthTargets : []),
    ...(Array.isArray(item.targetFiles) ? item.targetFiles : []),
  ].filter(Boolean).map(String).join('\n');
}

function defaultValidationContextFilesForItem(item = {}) {
  const text = itemValidationText(item);
  if (!VALIDATION_CONTEXT_RE.test(text)) return [];
  return [
    ...DEFAULT_VALIDATION_CONTEXT_FILES,
    ...(VISUAL_RENDER_CONTEXT_RE.test(text) ? DEFAULT_VISUAL_RENDER_CONTEXT_FILES : []),
  ];
}

function readOnlyFilesForClaim(claim = {}) {
  const allowed = new Set((claim.writeSet?.paths || [])
    .map(normalizeWriteSetPath)
    .filter(Boolean));
  return [...new Set([
    ...(claim.item?.sourceOfTruthTargets || []),
    ...defaultValidationContextFilesForItem(claim.item),
  ]
    .map(normalizeWriteSetPath)
    .filter(file => file && !allowed.has(file)))].sort();
}

module.exports = {
  DEFAULT_VALIDATION_CONTEXT_FILES,
  DEFAULT_VISUAL_RENDER_CONTEXT_FILES,
  defaultValidationContextFilesForItem,
  readOnlyFilesForClaim,
};
