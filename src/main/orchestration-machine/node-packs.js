const fs = require('fs');
const path = require('path');

const RESERVED_TYPE_PREFIX = 'orpad.';
const SAFE_TRUST_LEVELS = new Set(['official', 'signed', 'local']);
const BLOCKED_LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall', 'prepare']);
const EXECUTABLE_HANDLER_KINDS = new Set(['executable', 'unsafe-executable', 'native', 'process']);
const PACK_ASSET_COLLECTIONS = ['graphs', 'trees', 'skills', 'rules', 'examples'];
const STARTER_NODE_PACK_MANIFESTS = [
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.starter.electron-maintenance',
    name: 'Electron Maintenance Starter Pack',
    version: '0.1.0',
    origin: 'built-in',
    trustLevel: 'official',
    mutable: false,
    description: 'Reusable orchestration hints for Electron app maintenance, IPC/preload review, renderer build health, and packaging workflows.',
    author: {
      name: 'OrPAD',
      github: 'https://github.com/luke-youngmin-cho/OrPAD',
      repository: 'https://github.com/luke-youngmin-cho/OrPAD',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      pipelineSchema: '>=1.0',
      packFormat: 'orpad.nodePack.v1',
    },
    dependsOn: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3' },
      { id: 'orpad.workstream', version: '>=0.1.0' },
    ],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    capabilities: ['read.workspace', 'write.workspace', 'write.runArtifacts', 'run.localVerification'],
    nodes: [],
    graphs: [{
      id: 'electron-maintenance-workstream',
      path: 'graphs/electron-maintenance-workstream.or-graph',
      label: 'Electron Maintenance Workstream',
      role: 'reusable',
      description: 'Discovery and verification lens for Electron main/preload/renderer maintenance.',
      inputs: ['workspaceContext'],
      outputs: ['electronCandidateItems'],
    }],
    skills: [{
      id: 'electron-maintenance-audit',
      path: 'skills/electron-maintenance-audit.md',
      description: 'Guides IPC, preload, renderer, packaging, and Electron verification evidence.',
    }],
    rules: [{
      id: 'electron-maintenance-scope',
      path: 'rules/electron-maintenance-scope.or-rule',
      description: 'Includes Electron main, preload, renderer, build, package, and e2e files while excluding secrets and generated output.',
    }],
    examples: [],
    authoringHints: {
      situational: true,
      priority: 80,
      keywords: [
        'electron',
        'preload',
        'ipc',
        'renderer',
        'electron-builder',
        'desktop app',
        'app shell',
        'main process',
        'browserwindow',
      ],
      workspaceSignals: [
        'electron-builder.yml',
        'src/main/',
        'src/renderer/',
        'preload.js',
        'tests/e2e/',
      ],
      selectionReason: 'The request or workspace touches Electron runtime, preload/IPC, renderer, packaging, or e2e app behavior.',
      context: {
        id: 'map-electron-surface',
        label: 'Map Electron maintenance surface',
        summary: 'Inspect Electron main, preload, renderer, packaging, and e2e paths before proposing work.',
      },
      probe: {
        id: 'probe-electron-maintenance',
        label: 'Probe Electron maintenance candidates',
        lens: 'electron-maintenance',
        maxCandidates: 7,
      },
      workerLabel: 'Implement Electron maintenance item',
      verifyCriteria: [
        'Electron main/preload/renderer behavior remains compatible with the request',
        'Targeted build, renderer, or e2e evidence is recorded',
        'Packaging or update metadata changes are explicit when touched',
      ],
      rule: {
        include: ['src/main/**', 'src/renderer/**', 'electron-builder.yml', 'package.json', 'tests/e2e/**'],
        exclude: ['dist/**', 'release/**', 'out/**', '.env', '**/*secret*', '**/*token*'],
      },
      skill: {
        acceptanceCriteria: [
          'IPC and preload changes preserve least-authority boundaries',
          'Renderer changes have build or focused e2e verification evidence',
          'Electron packaging changes are reflected in package metadata or release notes when needed',
        ],
      },
    },
  },
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.starter.security-review',
    name: 'Security Review Starter Pack',
    version: '0.1.0',
    origin: 'built-in',
    trustLevel: 'official',
    mutable: false,
    description: 'Reusable orchestration hints for least-authority review, secret handling, XSS, IPC boundaries, and high-risk capability gates.',
    author: {
      name: 'OrPAD',
      github: 'https://github.com/luke-youngmin-cho/OrPAD',
      repository: 'https://github.com/luke-youngmin-cho/OrPAD',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      pipelineSchema: '>=1.0',
      packFormat: 'orpad.nodePack.v1',
    },
    dependsOn: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3' },
      { id: 'orpad.workstream', version: '>=0.1.0' },
    ],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    capabilities: ['read.workspace', 'write.runArtifacts', 'run.localVerification'],
    nodes: [],
    graphs: [{
      id: 'security-review-workstream',
      path: 'graphs/security-review-workstream.or-graph',
      label: 'Security Review Workstream',
      role: 'reusable',
      description: 'Discovery and verification lens for high-risk authority, secret, XSS, IPC, and destructive-action review.',
      inputs: ['workspaceContext'],
      outputs: ['securityCandidateItems'],
    }],
    skills: [{
      id: 'security-review-audit',
      path: 'skills/security-review-audit.md',
      description: 'Guides least-authority review with evidence-first findings and explicit approval gates.',
    }],
    rules: [{
      id: 'security-review-scope',
      path: 'rules/security-review-scope.or-rule',
      description: 'Includes security-sensitive source, authority, key, IPC, HTML, network, and command execution paths.',
    }],
    examples: [],
    authoringHints: {
      situational: true,
      priority: 90,
      keywords: [
        'security',
        'secret',
        'credential',
        'token',
        'xss',
        'ipc',
        'preload',
        'authority',
        'permission',
        'sandbox',
        'destructive',
        'network',
      ],
      workspaceSignals: [
        'security.md',
        'src/main/authority.js',
        'src/main/ai-keys.js',
        'preload.js',
        'html-xss',
        'permissions',
      ],
      selectionReason: 'The request implies secret handling, authority boundaries, IPC/preload review, sandbox policy, XSS, or destructive capability risk.',
      context: {
        id: 'map-security-boundaries',
        label: 'Map security boundaries',
        summary: 'Collect authority, credential, IPC, HTML rendering, command execution, and sandbox boundaries before proposing work.',
      },
      probe: {
        id: 'probe-security-review',
        label: 'Probe security review findings',
        lens: 'security-review',
        maxCandidates: 8,
      },
      workerLabel: 'Implement security-bounded item',
      verifyCriteria: [
        'Security-sensitive changes preserve least-authority boundaries',
        'Secret, token, credential, and destructive-operation handling is explicitly reviewed',
        'Verification evidence covers the affected security boundary',
      ],
      rule: {
        include: ['SECURITY.md', 'src/main/**', 'src/renderer/**', 'tests/e2e/*xss*', 'tests/e2e/*key*', 'tests/e2e/*authority*'],
        exclude: ['.env', '**/*secret*', '**/*token*', '**/*.pem', '**/*.key', 'dist/**'],
      },
      skill: {
        acceptanceCriteria: [
          'No generated finding relies on historical memory without current local evidence',
          'High-risk capability requests are surfaced as approval gates instead of silently executed',
          'Security verification names the boundary, file, command, or test that provides evidence',
        ],
      },
    },
  },
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.starter.release-readiness',
    name: 'Release Readiness Starter Pack',
    version: '0.1.0',
    origin: 'built-in',
    trustLevel: 'official',
    mutable: false,
    description: 'Reusable orchestration hints for release checklist, version, changelog, installer, build, and audit evidence workflows.',
    author: {
      name: 'OrPAD',
      github: 'https://github.com/luke-youngmin-cho/OrPAD',
      repository: 'https://github.com/luke-youngmin-cho/OrPAD',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      pipelineSchema: '>=1.0',
      packFormat: 'orpad.nodePack.v1',
    },
    dependsOn: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3' },
      { id: 'orpad.workstream', version: '>=0.1.0' },
    ],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    capabilities: ['read.workspace', 'write.workspace', 'write.runArtifacts', 'run.localVerification'],
    nodes: [],
    graphs: [{
      id: 'release-readiness-workstream',
      path: 'graphs/release-readiness-workstream.or-graph',
      label: 'Release Readiness Workstream',
      role: 'reusable',
      description: 'Discovery and verification lens for release metadata, build health, notes, packaging, and audit evidence.',
      inputs: ['workspaceContext'],
      outputs: ['releaseCandidateItems'],
    }],
    skills: [{
      id: 'release-readiness-audit',
      path: 'skills/release-readiness-audit.md',
      description: 'Guides release readiness checks with explicit build, version, note, and risk evidence.',
    }],
    rules: [{
      id: 'release-readiness-scope',
      path: 'rules/release-readiness-scope.or-rule',
      description: 'Includes package metadata, build scripts, release notes, installers, and relevant validation assets.',
    }],
    examples: [],
    authoringHints: {
      situational: true,
      priority: 70,
      keywords: [
        'release',
        'ship',
        'shipping',
        'version',
        'changelog',
        'release notes',
        'installer',
        'package',
        'packaging',
        'build',
        'publish',
      ],
      workspaceSignals: [
        'release_notes.md',
        'electron-builder.yml',
        'package.json',
        'scripts/create-release-manifest',
        'dist',
      ],
      selectionReason: 'The request needs release, version, packaging, build, changelog, or readiness evidence.',
      context: {
        id: 'map-release-surface',
        label: 'Map release readiness surface',
        summary: 'Inspect version metadata, build scripts, release notes, installer configuration, and known release risk areas.',
      },
      probe: {
        id: 'probe-release-readiness',
        label: 'Probe release readiness gaps',
        lens: 'release-readiness',
        maxCandidates: 6,
      },
      workerLabel: 'Implement release readiness item',
      verifyCriteria: [
        'Release metadata, build scripts, and notes are internally consistent',
        'Build or package verification evidence is recorded or explicitly blocked',
        'Release risks and skipped checks are visible in artifacts',
      ],
      rule: {
        include: ['package.json', 'package-lock.json', 'RELEASE_NOTES.md', 'electron-builder.yml', 'scripts/**', 'assets/**'],
        exclude: ['dist/**', 'out/**', 'release/**', '.env', '**/*secret*'],
      },
      skill: {
        acceptanceCriteria: [
          'Version and release metadata are consistent with the requested release scope',
          'Build, package, or smoke verification is recorded with pass/fail/blocked status',
          'Release notes or handoff artifacts capture user-visible changes and residual risks',
        ],
      },
    },
  },
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.starter.content-qa',
    name: 'Content QA Starter Pack',
    version: '0.1.0',
    origin: 'built-in',
    trustLevel: 'official',
    mutable: false,
    description: 'Reusable orchestration hints for documentation, Markdown, tutorials, learning material, localization, and content quality workflows.',
    author: {
      name: 'OrPAD',
      github: 'https://github.com/luke-youngmin-cho/OrPAD',
      repository: 'https://github.com/luke-youngmin-cho/OrPAD',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      pipelineSchema: '>=1.0',
      packFormat: 'orpad.nodePack.v1',
    },
    dependsOn: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3' },
      { id: 'orpad.workstream', version: '>=0.1.0' },
    ],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    capabilities: ['read.workspace', 'write.workspace', 'write.runArtifacts', 'run.localVerification'],
    nodes: [],
    graphs: [{
      id: 'content-qa-workstream',
      path: 'graphs/content-qa-workstream.or-graph',
      label: 'Content QA Workstream',
      role: 'reusable',
      description: 'Discovery and verification lens for docs, lessons, tutorials, Markdown structure, and localization readiness.',
      inputs: ['workspaceContext'],
      outputs: ['contentCandidateItems'],
    }],
    skills: [{
      id: 'content-qa-audit',
      path: 'skills/content-qa-audit.md',
      description: 'Guides evidence-backed documentation and learning-material improvements.',
    }],
    rules: [{
      id: 'content-qa-scope',
      path: 'rules/content-qa-scope.or-rule',
      description: 'Includes Markdown, docs, tutorial, content, locale, and template files.',
    }],
    examples: [],
    authoringHints: {
      situational: true,
      priority: 60,
      keywords: [
        'docs',
        'documentation',
        'readme',
        'markdown',
        'content',
        'tutorial',
        'lesson',
        'lecture',
        'course',
        'slides',
        'learning material',
        'course material',
        'localization',
        'locale',
        'copy',
        '문서',
        '강의',
        '자료',
        '슬라이드',
        '학습',
        '교육',
        '수업',
      ],
      workspaceSignals: [
        'readme.md',
        'docs/',
        'locales/',
        'src/locales/',
        'templates/',
        '.md',
      ],
      selectionReason: 'The request targets documentation, learning material, Markdown content, tutorials, copy, or localization quality.',
      context: {
        id: 'map-content-scope',
        label: 'Map content QA scope',
        summary: 'Inspect relevant docs, templates, Markdown, tutorial, locale, and learning-material structure before proposing edits.',
      },
      probe: {
        id: 'probe-content-qa',
        label: 'Probe content quality gaps',
        lens: 'content-qa',
        maxCandidates: 7,
      },
      workerLabel: 'Implement content QA item',
      verifyCriteria: [
        'Content structure, claims, and examples align with the requested audience',
        'Markdown, tutorial, or localization changes are validated where practical',
        'Evidence records the before/after content gap and acceptance criteria',
        'Final content passes an editorial quality gate for voice, density, repetition, and role separation',
      ],
      finalQualityGate: {
        id: 'content-editorial-quality-gate',
        label: 'Gate final editorial quality',
        evaluationMode: 'content-editorial-quality',
        judgePolicy: 'rule-only',
        expectedEvaluationArtifacts: [
          'artifacts/evaluations/content-editorial/workers/<worker-id>-seq-<event-sequence>.json',
        ],
        expectedJudgeArtifacts: [
          'artifacts/evaluations/content-editorial/judges/<worker-id>-seq-<event-sequence>.json',
        ],
        nodePackRubric: [
          'Rule analyzer evaluates changed content hunks independently from worker summary claims.',
          'Optional LLM judge receives only rule output, changed hunks, a small style sample, and this rubric.',
          'Worker-specific evaluation artifacts must not be merged across workers.',
        ],
        criteria: [
          'Final content is edited down for the target audience; slides or docs avoid checklist-like over-explanation and keep one main teaching point per section or slide.',
          'Voice and tone match the existing human-authored material; remove generic model meta-language, repeated scaffolding, and AI-sounding summary phrases.',
          'README, slides, examples, and acceptance criteria are role-separated so runnable instructions do not crowd presentation material.',
          'Before/after evidence names what was removed, consolidated, or rewritten, not only what was added.',
        ],
      },
      candidateTargetPolicy: [
        'Content work items must say whether they repair source-of-truth accuracy, presentation/readability, or both.',
        'For slide or tutorial changes, include an editorial acceptance criterion that can be satisfied by removing, merging, or rewriting prose, not only by adding text.',
        'Keep README-style execution details out of presentation slides unless the slide is explicitly a lab handout.',
      ],
      rule: {
        include: ['README.md', 'docs/**', 'slides/**', 'tutorials/**', 'lessons/**', 'courses/**', '**/*.md', 'src/locales/**', 'locales/**', 'src/renderer/templates/**'],
        exclude: ['node_modules/**', 'dist/**', '.env', '**/*secret*'],
      },
      skill: {
        acceptanceCriteria: [
          'Generated work preserves source-of-truth claims and flags unverified claims',
          'Audience, examples, headings, and acceptance criteria are explicitly reviewed',
          'Markdown or locale-sensitive changes include focused validation or a documented blocker',
        ],
      },
    },
  },
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.starter.dotnet-lab-code',
    name: '.NET Lab Code Starter Pack',
    version: '0.1.0',
    origin: 'built-in',
    trustLevel: 'official',
    mutable: false,
    description: 'Reusable orchestration hints for C#/.NET lab code, README-to-code alignment, runnable examples, and course exercise validation.',
    author: {
      name: 'OrPAD',
      github: 'https://github.com/luke-youngmin-cho/OrPAD',
      repository: 'https://github.com/luke-youngmin-cho/OrPAD',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      pipelineSchema: '>=1.0',
      packFormat: 'orpad.nodePack.v1',
    },
    dependsOn: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3' },
      { id: 'orpad.workstream', version: '>=0.1.0' },
    ],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    capabilities: ['read.workspace', 'write.workspace', 'write.runArtifacts', 'run.localVerification'],
    nodes: [],
    graphs: [{
      id: 'dotnet-lab-code-workstream',
      path: 'graphs/dotnet-lab-code-workstream.or-graph',
      label: '.NET Lab Code Workstream',
      role: 'reusable',
      description: 'Discovery and verification lens for C# lab code, README expectations, and runnable course examples.',
      inputs: ['workspaceContext'],
      outputs: ['dotnetLabCodeCandidateItems'],
    }],
    skills: [{
      id: 'dotnet-lab-code-audit',
      path: 'skills/dotnet-lab-code-audit.md',
      description: 'Guides README-to-Program.cs alignment, build/run validation, and code-target candidate generation for .NET labs.',
    }],
    rules: [{
      id: 'dotnet-lab-code-scope',
      path: 'rules/dotnet-lab-code-scope.or-rule',
      description: 'Includes C# source, .NET project files, lab READMEs, slides, and build metadata while excluding generated output.',
    }],
    examples: [],
    authoringHints: {
      situational: true,
      priority: 88,
      keywords: [
        'c#',
        'csharp',
        '.net',
        'dotnet',
        'program.cs',
        'csproj',
        'sln',
        'lab',
        'labs',
        'exercise',
        'sample code',
        'example code',
        'lecture code',
        'course code',
        'threading',
        'concurrency',
        '실습',
        '예제',
        '강의',
        '코드',
      ],
      workspaceSignals: [
        '**/*.cs',
        '**/*.csproj',
        '**/*.sln',
        'program.cs',
        'global.json',
        'directory.build.props',
        'directory.build.targets',
        'lab',
        'threadprogramming/',
      ],
      selectionReason: 'The request or workspace combines .NET/C# code with labs, runnable examples, README expectations, or lecture exercise validation.',
      context: {
        id: 'map-dotnet-lab-code',
        label: 'Map .NET lab code surface',
        summary: 'Inventory C# source, project files, lab READMEs, slides, expected output, and available dotnet validation commands before proposing work.',
      },
      probe: {
        id: 'probe-dotnet-lab-code-alignment',
        label: 'Probe .NET lab code alignment',
        lens: 'dotnet-lab-code',
        maxCandidates: 10,
      },
      workerLabel: 'Repair .NET lab code item',
      verifyCriteria: [
        'README, slide, and Program.cs expectations agree for each changed lab',
        'C# or project-file changes include dotnet build/run evidence or a documented blocker',
        'Runtime-dependent findings target code files unless current evidence proves documentation-only repair is sufficient',
      ],
      candidateTargetPolicy: [
        'When a finding depends on actual lab behavior, include the relevant Program.cs, .csproj, or .sln file in candidate targetFiles.',
        'Use README or slide targetFiles alone only when the code already matches the intended behavior and the content is stale.',
        'Record per-lab no-code-change evidence instead of silently treating C# files as read-only context.',
      ],
      rule: {
        include: ['**/*.cs', '**/*.csproj', '**/*.sln', '**/*.md', 'global.json', 'Directory.Build.*'],
        exclude: ['**/bin/**', '**/obj/**', '.vs/**', 'node_modules/**', 'dist/**', '.env', '**/*secret*', '**/*token*'],
      },
      skill: {
        acceptanceCriteria: [
          'Each changed lab has explicit evidence linking README instructions, expected observations, and actual C# behavior',
          'Program.cs, project, or solution changes are validated with dotnet build/run where practical',
          'Candidates that rely on runtime behavior include code files in targetFiles or explain why no code change is needed',
        ],
      },
    },
  },
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.starter.frontend-ux',
    name: 'Frontend UX Starter Pack',
    version: '0.1.0',
    origin: 'built-in',
    trustLevel: 'official',
    mutable: false,
    description: 'Reusable orchestration hints for renderer UI, graph editor UX, context menus, inspectors, styling, and browser/e2e verification.',
    author: {
      name: 'OrPAD',
      github: 'https://github.com/luke-youngmin-cho/OrPAD',
      repository: 'https://github.com/luke-youngmin-cho/OrPAD',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      pipelineSchema: '>=1.0',
      packFormat: 'orpad.nodePack.v1',
    },
    dependsOn: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3' },
      { id: 'orpad.workstream', version: '>=0.1.0' },
    ],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    capabilities: ['read.workspace', 'write.workspace', 'write.runArtifacts', 'run.localVerification'],
    nodes: [],
    graphs: [{
      id: 'frontend-ux-workstream',
      path: 'graphs/frontend-ux-workstream.or-graph',
      label: 'Frontend UX Workstream',
      role: 'reusable',
      description: 'Discovery and verification lens for UI workflows, graph editors, inspector controls, context menus, CSS, and e2e coverage.',
      inputs: ['workspaceContext'],
      outputs: ['frontendUxCandidateItems'],
    }],
    skills: [{
      id: 'frontend-ux-audit',
      path: 'skills/frontend-ux-audit.md',
      description: 'Guides UI state, layout, interaction, accessibility, screenshot, and e2e verification evidence.',
    }],
    rules: [{
      id: 'frontend-ux-scope',
      path: 'rules/frontend-ux-scope.or-rule',
      description: 'Includes renderer, web UI, styles, templates, Playwright/e2e tests, and browser-facing assets.',
    }],
    examples: [],
    authoringHints: {
      situational: true,
      priority: 86,
      keywords: [
        'ui',
        'ux',
        'frontend',
        'front-end',
        'renderer',
        'graph editor',
        'node inspector',
        'inspector',
        'context menu',
        'right-click',
        'dropdown',
        'modal',
        'panel',
        'sidebar',
        'canvas',
        'drag',
        'drop',
        'css',
        'layout',
        'accessibility',
        '우클릭',
        '그래프',
        '인스펙터',
        '메뉴',
        '화면',
      ],
      workspaceSignals: [
        'src/renderer/',
        'src/web/',
        '**/*.css',
        '**/*.html',
        '**/*.tsx',
        '**/*.jsx',
        '**/*.vue',
        '**/*.svelte',
        'tests/e2e/',
        'playwright.config',
      ],
      selectionReason: 'The request or workspace touches browser-facing UI behavior, graph editor interaction, context menus, inspector controls, CSS, or e2e UX verification.',
      context: {
        id: 'map-frontend-ux-surface',
        label: 'Map frontend UX surface',
        summary: 'Collect renderer, web UI, style, interaction-state, graph editor, and e2e evidence before proposing UI changes.',
      },
      probe: {
        id: 'probe-frontend-ux',
        label: 'Probe frontend UX candidates',
        lens: 'frontend-ux',
        maxCandidates: 9,
      },
      workerLabel: 'Implement frontend UX item',
      verifyCriteria: [
        'The affected UI workflow exposes the requested control states and actions',
        'Layout, text, menus, and inspector controls do not overlap across relevant viewports',
        'Focused e2e, browser, or screenshot evidence is recorded for user-visible behavior',
      ],
      candidateTargetPolicy: [
        'UI behavior findings should target the renderer/web source, CSS, and focused e2e files needed to make the workflow testable.',
        'Context-menu or inspector findings should name the exact state transition and the UI surface where it appears.',
        'Do not treat visual verification as optional when the change affects layout, menus, or canvas controls.',
      ],
      rule: {
        include: ['src/renderer/**', 'src/web/**', 'src/**/*.css', 'src/**/*.html', 'tests/e2e/**', 'playwright.config.*', 'package.json'],
        exclude: ['dist/**', 'release/**', 'out/**', 'node_modules/**', '.env', '**/*secret*', '**/*token*'],
      },
      skill: {
        acceptanceCriteria: [
          'User-visible states, empty states, disabled states, and interaction transitions are explicitly checked',
          'Layout-sensitive changes include focused screenshot, e2e, or browser verification evidence where practical',
          'Tests or verification cover the workflow that triggered the UX issue, not only the edited helper function',
        ],
      },
    },
  },
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.starter.test-regression',
    name: 'Test Regression Starter Pack',
    version: '0.1.0',
    origin: 'built-in',
    trustLevel: 'official',
    mutable: false,
    description: 'Reusable orchestration hints for reproducing failures, selecting focused tests, repairing regressions, and recording validation evidence.',
    author: {
      name: 'OrPAD',
      github: 'https://github.com/luke-youngmin-cho/OrPAD',
      repository: 'https://github.com/luke-youngmin-cho/OrPAD',
    },
    license: 'MIT',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      pipelineSchema: '>=1.0',
      packFormat: 'orpad.nodePack.v1',
    },
    dependsOn: [
      { id: 'orpad.core', version: '>=1.0.0-beta.3' },
      { id: 'orpad.workstream', version: '>=0.1.0' },
    ],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    capabilities: ['read.workspace', 'write.workspace', 'write.runArtifacts', 'run.localVerification'],
    nodes: [],
    graphs: [{
      id: 'test-regression-workstream',
      path: 'graphs/test-regression-workstream.or-graph',
      label: 'Test Regression Workstream',
      role: 'reusable',
      description: 'Discovery and verification lens for failing tests, regressions, smoke checks, and validation gaps.',
      inputs: ['workspaceContext'],
      outputs: ['testRegressionCandidateItems'],
    }],
    skills: [{
      id: 'test-regression-audit',
      path: 'skills/test-regression-audit.md',
      description: 'Guides failure reproduction, focused regression coverage, validation commands, and residual-risk evidence.',
    }],
    rules: [{
      id: 'test-regression-scope',
      path: 'rules/test-regression-scope.or-rule',
      description: 'Includes tests, source under test, package/build metadata, and validation scripts while excluding generated output.',
    }],
    examples: [],
    authoringHints: {
      situational: true,
      priority: 78,
      keywords: [
        'test',
        'tests',
        'regression',
        'failing',
        'failed',
        'failure',
        'bug',
        'fix',
        'validation',
        'harness',
        'e2e',
        'smoke',
        'reproduce',
        '검증',
        '테스트',
        '실패',
        '버그',
        '재현',
        '회귀',
      ],
      workspaceSignals: [
        'tests/',
        'test/',
        '__tests__/',
        '**/*.test.js',
        '**/*.test.mjs',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.spec.js',
        'playwright.config',
        'package.json',
        'pytest.ini',
        'go.mod',
        '**/*.csproj',
      ],
      selectionReason: 'The request or workspace involves a failure, regression, test harness, validation command, or focused verification path.',
      context: {
        id: 'map-test-regression-surface',
        label: 'Map test regression surface',
        summary: 'Identify the failing behavior, existing tests, validation commands, source under test, and missing regression coverage.',
      },
      probe: {
        id: 'probe-test-regression',
        label: 'Probe regression candidates',
        lens: 'test-regression',
        maxCandidates: 8,
      },
      workerLabel: 'Implement regression-backed item',
      verifyCriteria: [
        'The reported failure is reproduced or the reproduction blocker is explicit',
        'A focused validation command covers the changed behavior',
        'Regression risk is reduced with targeted tests or documented residual risk',
      ],
      candidateTargetPolicy: [
        'Regression findings should target both the source under test and the focused test or harness file when coverage is missing.',
        'If a test cannot be added, record the validation command and residual risk in the candidate acceptance criteria.',
        'Do not mark validation complete from static inspection alone when a runnable test path exists.',
      ],
      rule: {
        include: ['tests/**', 'test/**', '__tests__/**', 'src/**', 'package.json', 'package-lock.json', 'playwright.config.*', 'scripts/**', '**/*.csproj'],
        exclude: ['node_modules/**', 'dist/**', 'release/**', 'out/**', '**/bin/**', '**/obj/**', '.env', '**/*secret*', '**/*token*'],
      },
      skill: {
        acceptanceCriteria: [
          'Each change names the failure, reproduction evidence, and validation command or blocker',
          'Regression-prone fixes add or update focused tests when the codebase has a practical test surface',
          'Skipped or blocked validation is recorded as residual risk instead of hidden in the summary',
        ],
      },
    },
  },
];
const BUILT_IN_NODE_PACK_MANIFESTS = [
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.core',
    name: 'OrPAD Core Node Pack',
    version: '1.0.0-beta.3',
    origin: 'built-in',
    trustLevel: 'official',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: [],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    nodes: [
      'orpad.context',
      'orpad.gate',
      'orpad.graph',
      'orpad.rule',
      'orpad.selector',
      'orpad.skill',
      'orpad.tree',
    ].map(type => ({
      type,
      path: `nodes/${type.slice('orpad.'.length)}.or-node`,
      runtimeHandlerKind: 'metadata-only',
      capabilities: [],
    })),
  },
  {
    kind: 'orpad.nodePack',
    schemaVersion: '1.0',
    id: 'orpad.workstream',
    name: 'OrPAD Workstream Node Pack',
    version: '1.0.0-beta.3',
    origin: 'built-in',
    trustLevel: 'official',
    compatibility: {
      orpad: '>=1.0.0-beta.3',
      packFormat: 'orpad.nodePack.v1',
    },
    capabilities: [],
    installPolicy: {
      allowLifecycleScripts: false,
      allowExecutableHandlers: false,
    },
    nodes: [
      'orpad.artifactContract',
      'orpad.barrier',
      'orpad.dispatcher',
      'orpad.entry',
      'orpad.exit',
      'orpad.patchReview',
      'orpad.probe',
      'orpad.triage',
      'orpad.workQueue',
      'orpad.workerLoop',
    ].map(type => ({
      type,
      path: `nodes/${type.slice('orpad.'.length)}.or-node`,
      runtimeHandlerKind: 'metadata-only',
      capabilities: [],
    })),
  },
  ...STARTER_NODE_PACK_MANIFESTS,
];

function diagnostic(level, code, message, details = {}) {
  return { level, code, message, ...details };
}

function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return match.slice(1).map(Number);
}

function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function satisfiesSimpleRange(version, range) {
  const value = String(range || '').trim();
  if (!value || value === '*') return true;
  if (value.startsWith('>=')) return compareVersion(version, value.slice(2).trim()) >= 0;
  return compareVersion(version, value) === 0;
}

function declaredNodeTypes(pack) {
  return (Array.isArray(pack?.nodes) ? pack.nodes : [])
    .map(node => String(node?.type || '').trim())
    .filter(Boolean);
}

function lifecycleScriptNames(pack) {
  const scripts = {
    ...(pack?.packageScripts || {}),
    ...(pack?.scripts || {}),
  };
  return Object.keys(scripts).filter(name => BLOCKED_LIFECYCLE_SCRIPTS.has(name));
}

function hasExecutableHandler(node) {
  const kind = String(node?.runtimeHandlerKind || '').trim();
  return EXECUTABLE_HANDLER_KINDS.has(kind) || Boolean(node?.handler || node?.main);
}

function normalizePackRelativePath(value) {
  const portable = String(value || '').trim().replace(/\\/g, '/');
  if (!portable) return '';
  const segments = portable.split('/');
  const hasUnsafeSegment = segments.some(segment => (
    !segment
    || segment === '.'
    || segment === '..'
    || /^[a-zA-Z]:$/.test(segment)
  ));
  const normalized = portable.replace(/\/+/g, '/');
  if (
    portable.startsWith('/')
    || /^[a-zA-Z]:\//.test(portable)
    || hasUnsafeSegment
    || normalized.startsWith('../')
  ) {
    return null;
  }
  return normalized;
}

function validatePackAssetPath(diagnostics, pack, assetKind, assetId, assetPath) {
  if (!assetPath) return '';
  const normalized = normalizePackRelativePath(assetPath);
  if (normalized) return normalized;
  diagnostics.push(diagnostic('error', 'NODE_PACK_ASSET_PATH_UNSAFE', 'Node pack asset paths must be pack-relative portable paths.', {
    packId: pack.id,
    assetKind,
    assetId,
    path: assetPath,
  }));
  return '';
}

function validateNodePackManifest(pack, options = {}) {
  const diagnostics = [];
  const currentOrpadVersion = options.currentOrpadVersion || '1.0.0-beta.3';
  const installMode = options.installMode || 'normal';
  const grantedCapabilities = new Set(options.grantedCapabilities || []);
  const builtIn = pack?.origin === 'built-in' || pack?.trustLevel === 'official';

  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return {
      ok: false,
      resolutionState: 'incompatible',
      nodeTypeMap: {},
      diagnostics: [diagnostic('error', 'NODE_PACK_INVALID', 'Node pack manifest must be an object.')],
    };
  }

  if (pack.enabled === false) {
    diagnostics.push(diagnostic('warning', 'NODE_PACK_DISABLED', 'Node pack is disabled.', { packId: pack.id }));
  }
  if (!pack.id) diagnostics.push(diagnostic('error', 'NODE_PACK_ID_MISSING', 'Node pack id is required.'));
  if (!pack.version) diagnostics.push(diagnostic('error', 'NODE_PACK_VERSION_MISSING', 'Node pack version is required.', { packId: pack.id }));
  if (!Array.isArray(pack.nodes)) diagnostics.push(diagnostic('error', 'NODE_PACK_NODES_MISSING', 'Node pack must declare a nodes array.', { packId: pack.id }));
  if (!builtIn && String(pack.id || '').startsWith(RESERVED_TYPE_PREFIX)) {
    diagnostics.push(diagnostic('error', 'NODE_PACK_RESERVED_ID', 'Community node packs cannot use the reserved orpad.* id namespace.', { packId: pack.id }));
  }

  const format = pack.compatibility?.packFormat || pack.packFormat || '';
  if (format && format !== 'orpad.nodePack.v1') {
    diagnostics.push(diagnostic('error', 'NODE_PACK_FORMAT_INCOMPATIBLE', 'Node pack format is not supported.', { packId: pack.id, format }));
  }
  const orpadRange = pack.compatibility?.orpad || '';
  if (orpadRange && !satisfiesSimpleRange(currentOrpadVersion, orpadRange)) {
    diagnostics.push(diagnostic('error', 'NODE_PACK_ORPAD_VERSION_INCOMPATIBLE', 'Node pack does not support this OrPAD version.', {
      packId: pack.id,
      required: orpadRange,
      current: currentOrpadVersion,
    }));
  }

  const blockedScripts = lifecycleScriptNames(pack);
  if (installMode === 'normal' && blockedScripts.length) {
    diagnostics.push(diagnostic('error', 'NODE_PACK_LIFECYCLE_SCRIPT_BLOCKED', 'Normal node pack install rejects npm lifecycle scripts.', {
      packId: pack.id,
      scripts: blockedScripts,
    }));
  }

  const trustLevel = pack.trustLevel || 'unknown';
  if (!SAFE_TRUST_LEVELS.has(trustLevel)) {
    diagnostics.push(diagnostic('warning', 'NODE_PACK_UNTRUSTED', 'Node pack trust level requires review before execution.', {
      packId: pack.id,
      trustLevel,
    }));
  }

  const packCapabilities = new Set(pack.capabilities || []);
  const nodeTypeMap = {};
  for (const node of Array.isArray(pack.nodes) ? pack.nodes : []) {
    const type = String(node?.type || '').trim();
    if (!type) {
      diagnostics.push(diagnostic('error', 'NODE_PACK_NODE_TYPE_MISSING', 'Node declaration must include a type.', { packId: pack.id }));
      continue;
    }
    if (!builtIn && type.startsWith(RESERVED_TYPE_PREFIX)) {
      diagnostics.push(diagnostic('error', 'NODE_PACK_RESERVED_NODE_TYPE', 'Community node packs cannot override orpad.* node types.', { packId: pack.id, nodeType: type }));
    }
    if (installMode === 'normal' && hasExecutableHandler(node)) {
      diagnostics.push(diagnostic('error', 'NODE_PACK_EXECUTABLE_HANDLER_BLOCKED', 'Normal node pack install rejects executable handlers.', { packId: pack.id, nodeType: type }));
    }
    const nodePath = validatePackAssetPath(diagnostics, pack, 'node', type, node.path || '');
    for (const capability of node.capabilities || []) {
      if (!packCapabilities.has(capability)) {
        diagnostics.push(diagnostic('error', 'NODE_PACK_NODE_CAPABILITY_UNDECLARED', 'Node capability must be pack-declared.', { packId: pack.id, nodeType: type, capability }));
      }
      if (grantedCapabilities.size && !grantedCapabilities.has(capability)) {
        diagnostics.push(diagnostic('warning', 'NODE_PACK_CAPABILITY_DENIED', 'Node capability is not granted for this install.', { packId: pack.id, nodeType: type, capability }));
      }
    }
    nodeTypeMap[type] = {
      packId: pack.id,
      packVersion: pack.version,
      path: nodePath,
      runtimeHandlerKind: node.runtimeHandlerKind || '',
      capabilities: node.capabilities || [],
    };
  }
  for (const collectionName of PACK_ASSET_COLLECTIONS) {
    for (const asset of Array.isArray(pack[collectionName]) ? pack[collectionName] : []) {
      validatePackAssetPath(diagnostics, pack, collectionName, asset?.id || asset?.type || '', asset?.path || '');
    }
  }

  const hasError = diagnostics.some(item => item.level === 'error');
  const hasCapabilityDenied = diagnostics.some(item => item.code === 'NODE_PACK_CAPABILITY_DENIED');
  const hasUntrusted = diagnostics.some(item => item.code === 'NODE_PACK_UNTRUSTED');
  const disabled = diagnostics.some(item => item.code === 'NODE_PACK_DISABLED');
  let resolutionState = 'resolved';
  if (disabled) resolutionState = 'disabled';
  else if (hasError) resolutionState = 'incompatible';
  else if (hasCapabilityDenied) resolutionState = 'capability-denied';
  else if (hasUntrusted) resolutionState = 'untrusted';

  return {
    ok: !hasError,
    packId: pack.id || '',
    packVersion: pack.version || '',
    resolutionState,
    declaredNodeTypes: declaredNodeTypes(pack),
    nodeTypeMap,
    diagnostics,
  };
}

function resolveNodeTypeCompatibility(nodeType, packResults = []) {
  for (const result of packResults) {
    if (result.nodeTypeMap?.[nodeType]) {
      return {
        state: result.resolutionState,
        nodeType,
        packId: result.packId,
        packVersion: result.packVersion,
        declaration: result.nodeTypeMap[nodeType],
      };
    }
  }
  return {
    state: 'missing',
    nodeType,
  };
}

function createLosslessNodePlaceholder(node, resolution) {
  return {
    schemaVersion: 'orpad.nodePlaceholder.v1',
    resolution,
    originalNode: JSON.parse(JSON.stringify(node || null)),
  };
}

function createNodePackLockEntry(pack, options = {}) {
  return {
    id: pack.id,
    version: pack.version,
    source: options.source || pack.origin || 'unknown',
    checksum: options.checksum || '',
    signature: options.signature || '',
    resolvedNodeTypes: declaredNodeTypes(pack).sort(),
  };
}

function normalizeNodePackDeclaration(value, path = 'nodePacks') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { id: trimmed, path } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const id = String(value.id || value.packId || '').trim();
  const versionRange = String(
    value.versionRange
      || value.range
      || value.requiredVersion
      || value.version
      || '',
  ).trim();
  const origin = String(value.origin || value.source || '').trim();
  return {
    ...value,
    id,
    versionRange,
    origin,
    path,
  };
}

function collectNodePackDeclarations(nodePacks) {
  if (Array.isArray(nodePacks)) {
    return nodePacks
      .map((item, index) => normalizeNodePackDeclaration(item, `nodePacks[${index}]`))
      .filter(Boolean);
  }
  if (nodePacks && typeof nodePacks === 'object') {
    return Object.entries(nodePacks)
      .map(([id, item]) => {
        if (item === true) return normalizeNodePackDeclaration({ id }, `nodePacks.${id}`);
        if (typeof item === 'string') return normalizeNodePackDeclaration({ id, versionRange: item }, `nodePacks.${id}`);
        return normalizeNodePackDeclaration({ id, ...item }, `nodePacks.${id}`);
      })
      .filter(Boolean);
  }
  return [];
}

function validatePipelineNodePacks(nodePacks, options = {}) {
  const diagnostics = [];
  const declarations = collectNodePackDeclarations(nodePacks);
  const availablePacks = options.availableNodePacks
    || options.nodePackManifests
    || options.builtInNodePacks
    || BUILT_IN_NODE_PACK_MANIFESTS;
  const availableById = new Map((Array.isArray(availablePacks) ? availablePacks : [])
    .filter(pack => pack && typeof pack === 'object' && !Array.isArray(pack))
    .map(pack => [String(pack.id || '').trim(), pack])
    .filter(([id]) => id));
  const resolved = [];

  for (const declaration of declarations) {
    if (!declaration.id) {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_ID_MISSING',
        'Pipeline nodePacks entries must include a pack id.',
        { path: declaration.path },
      ));
      continue;
    }

    const pack = availableById.get(declaration.id);
    if (!pack) {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_UNKNOWN',
        'Pipeline declares a node pack that is not available.',
        { path: declaration.path, packId: declaration.id },
      ));
      resolved.push({ id: declaration.id, resolutionState: 'missing' });
      continue;
    }

    const packResult = validateNodePackManifest(pack, {
      currentOrpadVersion: options.currentOrpadVersion,
      installMode: options.installMode || 'normal',
      grantedCapabilities: options.grantedCapabilities || pack.capabilities || [],
    });
    const origin = String(pack.origin || '').trim();
    const result = {
      id: declaration.id,
      requestedVersion: declaration.versionRange,
      requestedOrigin: declaration.origin,
      version: pack.version || '',
      origin,
      resolutionState: packResult.resolutionState,
      declaredNodeTypes: packResult.declaredNodeTypes || [],
    };
    resolved.push(result);

    if (declaration.origin && origin && declaration.origin !== origin) {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_ORIGIN_MISMATCH',
        'Pipeline nodePacks origin must match the resolved pack origin.',
        { path: declaration.path, packId: declaration.id, expectedOrigin: declaration.origin, actualOrigin: origin },
      ));
    }
    if (declaration.versionRange && !satisfiesSimpleRange(pack.version, declaration.versionRange)) {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_VERSION_INCOMPATIBLE',
        'Pipeline nodePacks version range is not satisfied by the resolved pack.',
        { path: declaration.path, packId: declaration.id, required: declaration.versionRange, current: pack.version || '' },
      ));
    }
    if (packResult.resolutionState === 'disabled') {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_DISABLED',
        'Pipeline declares a disabled node pack.',
        { path: declaration.path, packId: declaration.id },
      ));
    } else if (!packResult.ok || packResult.resolutionState !== 'resolved') {
      diagnostics.push(diagnostic(
        'error',
        'PIPELINE_NODE_PACK_INCOMPATIBLE',
        'Pipeline declares a node pack that is not launch-compatible.',
        {
          path: declaration.path,
          packId: declaration.id,
          resolutionState: packResult.resolutionState,
          packDiagnostics: packResult.diagnostics,
        },
      ));
    }
  }

  return {
    ok: !diagnostics.some(item => item.level === 'error'),
    nodePacks: resolved,
    diagnostics,
  };
}

function defaultBuiltInNodePacksRoot() {
  return path.resolve(__dirname, '..', '..', '..', 'nodes');
}

function discoverNodePackRoots(options = {}) {
  const roots = [];
  if (options.builtInNodePacksRoot !== false) {
    roots.push({
      kind: 'built-in',
      root: path.resolve(options.builtInNodePacksRoot || defaultBuiltInNodePacksRoot()),
    });
  }
  const userRoot = options.userNodePacksRoot
    || (options.userDataDir ? path.join(options.userDataDir, 'nodes') : '');
  if (userRoot) {
    roots.push({
      kind: 'user',
      root: path.resolve(userRoot),
    });
  }
  return roots;
}

function discoverManifestPaths(rootInfo, diagnostics) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootInfo.root, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      diagnostics.push(diagnostic('warning', 'NODE_PACK_DISCOVERY_ROOT_UNREADABLE', 'Node pack root could not be read.', {
        rootKind: rootInfo.kind,
        root: rootInfo.root,
        error: err.message,
      }));
    }
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      rootKind: rootInfo.kind,
      packDir: path.join(rootInfo.root, entry.name),
      manifestPath: path.join(rootInfo.root, entry.name, 'orpad.node-pack.json'),
    }))
    .sort((left, right) => left.manifestPath.localeCompare(right.manifestPath));
}

function readDiscoveredManifest(item, diagnostics) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(item.manifestPath, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      diagnostics.push(diagnostic('warning', 'NODE_PACK_DISCOVERY_MANIFEST_INVALID', 'Node pack manifest could not be parsed.', {
        rootKind: item.rootKind,
        manifestPath: item.manifestPath,
        error: err.message,
      }));
    }
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.push(diagnostic('warning', 'NODE_PACK_DISCOVERY_MANIFEST_INVALID', 'Node pack manifest must be a JSON object.', {
      rootKind: item.rootKind,
      manifestPath: item.manifestPath,
    }));
    return null;
  }
  return {
    origin: item.rootKind === 'built-in' ? 'built-in' : 'user',
    ...parsed,
    discovery: {
      rootKind: item.rootKind,
      packDir: item.packDir,
      manifestPath: item.manifestPath,
    },
  };
}

function discoverNodePackManifests(options = {}) {
  const diagnostics = [];
  const nodePacks = [];
  const seenIds = new Map();
  const typeOwners = new Map();
  const conflicts = [];
  const roots = discoverNodePackRoots(options);

  for (const rootInfo of roots) {
    for (const item of discoverManifestPaths(rootInfo, diagnostics)) {
      const pack = readDiscoveredManifest(item, diagnostics);
      if (!pack) continue;
      const packId = String(pack.id || '').trim();
      if (!packId) {
        diagnostics.push(diagnostic('warning', 'NODE_PACK_DISCOVERY_ID_MISSING', 'Discovered node pack manifest is missing an id.', {
          manifestPath: item.manifestPath,
        }));
        continue;
      }
      if (seenIds.has(packId)) {
        diagnostics.push(diagnostic('warning', 'NODE_PACK_DISCOVERY_DUPLICATE_ID', 'Duplicate node pack id discovered; deterministic load keeps the first pack and skips later duplicates.', {
          packId,
          keptManifestPath: seenIds.get(packId),
          skippedManifestPath: item.manifestPath,
        }));
        continue;
      }
      seenIds.set(packId, item.manifestPath);

      const validation = validateNodePackManifest(pack, {
        currentOrpadVersion: options.currentOrpadVersion,
        installMode: options.installMode || 'normal',
        grantedCapabilities: options.grantedCapabilities || pack.capabilities || [],
      });
      if (!validation.ok) {
        diagnostics.push(diagnostic('warning', 'NODE_PACK_DISCOVERY_VALIDATION_FAILED', 'Discovered node pack is not launch-compatible.', {
          packId,
          manifestPath: item.manifestPath,
          packDiagnostics: validation.diagnostics,
        }));
      }

      for (const nodeType of validation.declaredNodeTypes || []) {
        const owner = typeOwners.get(nodeType);
        if (owner && owner.packId !== packId) {
          const conflict = {
            nodeType,
            firstPackId: owner.packId,
            firstManifestPath: owner.manifestPath,
            secondPackId: packId,
            secondManifestPath: item.manifestPath,
          };
          conflicts.push(conflict);
          diagnostics.push(diagnostic('warning', 'NODE_PACK_TYPE_CONFLICT', 'Multiple node packs declare the same node type; user selection is required before activation.', conflict));
        } else if (!owner) {
          typeOwners.set(nodeType, { packId, manifestPath: item.manifestPath });
        }
      }

      nodePacks.push(pack);
    }
  }

  return {
    ok: !diagnostics.some(item => item.level === 'error'),
    roots,
    nodePacks,
    diagnostics,
    conflicts,
  };
}

function normalizeAuthoringSignal(value) {
  return String(value || '').trim().toLowerCase().replace(/\\/g, '/');
}

function workspaceSnapshotFiles(workspaceSnapshot = {}) {
  return Array.isArray(workspaceSnapshot.files)
    ? workspaceSnapshot.files.map(item => normalizeAuthoringSignal(item)).filter(Boolean)
    : [];
}

function basenameOfAuthoringPath(value) {
  const portable = normalizeAuthoringSignal(value);
  const index = portable.lastIndexOf('/');
  return index >= 0 ? portable.slice(index + 1) : portable;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globSignalToRegExp(signal) {
  let pattern = '^';
  for (let index = 0; index < signal.length; index += 1) {
    const char = signal[index];
    if (char === '*') {
      if (signal[index + 1] === '*') {
        pattern += '.*';
        index += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += escapeRegExp(char);
    }
  }
  pattern += '$';
  return new RegExp(pattern);
}

function workspaceFileMatchesSignal(fileValue, signalValue) {
  const file = normalizeAuthoringSignal(fileValue);
  const signal = normalizeAuthoringSignal(signalValue);
  if (!file || !signal) return false;
  const base = basenameOfAuthoringPath(file);

  if (/^\.[a-z0-9][a-z0-9._-]*$/i.test(signal)) {
    return base.endsWith(signal);
  }
  if (/^\*\.[a-z0-9][a-z0-9._-]*$/i.test(signal)) {
    return base.endsWith(signal.slice(1));
  }
  if (/^\*\*\/\*\.[a-z0-9][a-z0-9._-]*$/i.test(signal)) {
    return base.endsWith(signal.slice(4));
  }
  if (signal.endsWith('/')) {
    return file.startsWith(signal) || file.includes(`/${signal}`);
  }
  if (signal.includes('*') || signal.includes('?')) {
    return globSignalToRegExp(signal).test(file);
  }
  if (signal.includes('/')) {
    return file === signal || file.startsWith(`${signal}/`) || file.includes(signal);
  }
  return base === signal || file.includes(signal);
}

function scoreAuthoringNodePack(pack, taskText, workspaceSnapshot = {}) {
  const hints = pack?.authoringHints || {};
  const task = normalizeAuthoringSignal(taskText);
  const files = workspaceSnapshotFiles(workspaceSnapshot);
  const matchedSignals = [];
  let score = 0;
  let promptHit = false;
  let workspaceHit = false;

  for (const keyword of Array.isArray(hints.keywords) ? hints.keywords : []) {
    const signal = normalizeAuthoringSignal(keyword);
    if (!signal) continue;
    if (task.includes(signal)) {
      score += 4;
      promptHit = true;
      matchedSignals.push(`prompt:${signal}`);
    }
  }

  for (const signalValue of Array.isArray(hints.workspaceSignals) ? hints.workspaceSignals : []) {
    const signal = normalizeAuthoringSignal(signalValue);
    if (!signal) continue;
    const matches = files.filter(file => workspaceFileMatchesSignal(file, signal)).slice(0, 3);
    if (matches.length) {
      const patternLike = signal.startsWith('.') || signal.startsWith('*.') || signal.includes('*') || signal.endsWith('/');
      score += patternLike ? 3 : 2;
      workspaceHit = true;
      matchedSignals.push(`workspace:${signal}`);
    }
  }

  if (promptHit && workspaceHit) {
    score += 2;
    matchedSignals.push('combined:prompt+workspace');
  }

  return {
    score,
    priority: Number(hints.priority) || 0,
    matchedSignals: [...new Set(matchedSignals)],
  };
}

function publicAuthoringNodePackSelection(pack, score, matchedSignals) {
  const hints = pack.authoringHints || {};
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    origin: pack.origin || '',
    trustLevel: pack.trustLevel || '',
    score,
    matchedSignals,
    reason: hints.selectionReason || pack.description || '',
    capabilities: Array.isArray(pack.capabilities) ? [...pack.capabilities] : [],
    graphs: Array.isArray(pack.graphs) ? pack.graphs.map(graph => ({
      id: graph.id,
      path: graph.path,
      label: graph.label,
      role: graph.role,
    })) : [],
    skills: Array.isArray(pack.skills) ? pack.skills.map(skill => ({
      id: skill.id,
      path: skill.path,
      description: skill.description,
    })) : [],
    rules: Array.isArray(pack.rules) ? pack.rules.map(rule => ({
      id: rule.id,
      path: rule.path,
      description: rule.description,
    })) : [],
    authoringHints: hints,
  };
}

function selectAuthoringNodePacks(taskText, workspaceSnapshot = {}, options = {}) {
  const maxPacks = options.maxPacks === undefined
    ? 3
    : Math.max(0, Number(options.maxPacks) || 0);
  const required = new Set((options.requiredPackIds || options.preferredPackIds || [])
    .map(item => String(item || '').trim())
    .filter(Boolean));
  const candidates = BUILT_IN_NODE_PACK_MANIFESTS
    .filter(pack => pack?.authoringHints?.situational === true);
  const scored = candidates
    .map(pack => {
      const score = scoreAuthoringNodePack(pack, taskText, workspaceSnapshot);
      const forced = required.has(pack.id);
      return {
        pack,
        score: score.score + (forced ? 1000 : 0),
        priority: score.priority,
        matchedSignals: forced
          ? [...new Set(['explicit', ...score.matchedSignals])]
          : score.matchedSignals,
      };
    })
    .filter(item => item.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || right.priority - left.priority
      || String(left.pack.id).localeCompare(String(right.pack.id))
    ));

  return scored
    .slice(0, maxPacks)
    .map(item => publicAuthoringNodePackSelection(item.pack, item.score, item.matchedSignals));
}

function nodePackDeclarationForPipeline(selection) {
  return {
    id: selection.id,
    version: selection.version ? `>=${selection.version}` : '',
    origin: selection.origin || 'built-in',
  };
}

function authoringNodePackPromptLines(taskText, workspaceSnapshot = {}, options = {}) {
  const selected = Array.isArray(options.selectedNodePacks)
    ? options.selectedNodePacks
    : selectAuthoringNodePacks(taskText, workspaceSnapshot, options);
  const lines = [
    '## Situation Node Pack Catalog',
    '',
  ];

  if (!selected.length) {
    lines.push(
      '- No situation-specific starter pack matched this prompt or workspace snapshot. Use `orpad.core` and `orpad.workstream`, and only add a custom pack when the request evidence clearly names one.',
      '',
    );
    return lines;
  }

  lines.push(
    'These packs matched the prompt or workspace. Use them as reusable orchestration packages: the materialized pipeline will declare them in `nodePacks`; your spec should borrow their graph/skill/rule names and reflect their lenses in context, probe, gate, worker, and artifact nodes.',
    '',
  );
  for (const pack of selected) {
    const hints = pack.authoringHints || {};
    const graphIds = (pack.graphs || []).map(graph => graph.id).filter(Boolean);
    const skillIds = (pack.skills || []).map(skill => skill.id).filter(Boolean);
    const ruleIds = (pack.rules || []).map(rule => rule.id).filter(Boolean);
    const criteria = Array.isArray(hints.verifyCriteria) ? hints.verifyCriteria.slice(0, 3) : [];
    const targetPolicy = Array.isArray(hints.candidateTargetPolicy) ? hints.candidateTargetPolicy.slice(0, 3) : [];
    const finalGate = hints.finalQualityGate && typeof hints.finalQualityGate === 'object'
      ? hints.finalQualityGate
      : null;
    const finalGateCriteria = Array.isArray(finalGate?.criteria) ? finalGate.criteria.slice(0, 3) : [];
    const finalGateArtifacts = Array.isArray(finalGate?.expectedEvaluationArtifacts)
      ? finalGate.expectedEvaluationArtifacts.slice(0, 2)
      : [];
    const finalGateJudgeArtifacts = Array.isArray(finalGate?.expectedJudgeArtifacts)
      ? finalGate.expectedJudgeArtifacts.slice(0, 2)
      : [];
    lines.push(
      `- \`${pack.id}\` (${pack.name}): ${pack.reason}`,
      `  Matched signals: ${pack.matchedSignals.length ? pack.matchedSignals.join(', ') : 'selected by request context'}.`,
      `  Reusable graphs: ${graphIds.length ? graphIds.map(id => `\`${id}\``).join(', ') : '(none)'}.`,
      `  Skills/rules: ${[...skillIds, ...ruleIds].map(id => `\`${id}\``).join(', ') || '(none)'}.`,
      `  Preferred context: ${hints.context?.summary || 'Use a task-specific context lens.'}`,
      `  Preferred probe lens: ${hints.probe?.lens || 'task-specific'}.`,
      ...(criteria.length ? [`  Verification criteria: ${criteria.join('; ')}.`] : []),
      ...(finalGate ? [`  Final quality gate: ${finalGate.label || finalGate.id || 'final quality gate'}; evaluationMode=${finalGate.evaluationMode || 'content-editorial-quality'}; judgePolicy=${finalGate.judgePolicy || 'rule-only'}; expected artifacts: ${finalGateArtifacts.join(', ') || 'OrPAD-owned worker evaluation artifacts'}; expected judge artifacts: ${finalGateJudgeArtifacts.join(', ') || 'configured when judgePolicy uses LLM'}; ${finalGateCriteria.join('; ')}.`] : []),
      ...(targetPolicy.length ? [`  Candidate target policy: ${targetPolicy.join(' ')}`] : []),
    );
  }
  lines.push('');
  return lines;
}

module.exports = {
  BLOCKED_LIFECYCLE_SCRIPTS,
  BUILT_IN_NODE_PACK_MANIFESTS,
  EXECUTABLE_HANDLER_KINDS,
  PACK_ASSET_COLLECTIONS,
  RESERVED_TYPE_PREFIX,
  STARTER_NODE_PACK_MANIFESTS,
  authoringNodePackPromptLines,
  collectNodePackDeclarations,
  createLosslessNodePlaceholder,
  createNodePackLockEntry,
  declaredNodeTypes,
  defaultBuiltInNodePacksRoot,
  discoverNodePackManifests,
  discoverNodePackRoots,
  nodePackDeclarationForPipeline,
  resolveNodeTypeCompatibility,
  satisfiesSimpleRange,
  scoreAuthoringNodePack,
  selectAuthoringNodePacks,
  validatePipelineNodePacks,
  validateNodePackManifest,
};
