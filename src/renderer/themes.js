// ==================== Built-in Themes ====================
export const DEFAULT_THEME_ID = 'orpad-hero';

export const builtinThemes = {
  'orpad-hero': {
    name: 'OrPAD Hero', type: 'dark',
    colors: {
      bgPrimary: '#050b1f', bgSecondary: '#0b1530', borderColor: '#2d60a9',
      textPrimary: '#edf5ff', textSecondary: '#a9bee6', textTertiary: '#647ca9',
      accentColor: '#38a3ff', linkColor: '#77c7ff',
      hoverBg: 'rgba(56,163,255,0.16)', activeBg: 'rgba(56,163,255,0.22)',
      codeBg: 'rgba(35,79,145,0.26)', preBg: '#071228',
      tableBorder: '#2d60a9', tableHeaderBg: '#101d3b', tableRowBg: 'rgba(56,163,255,0.09)',
      scrollbarThumb: 'rgba(119,199,255,0.22)', scrollbarThumbHover: 'rgba(119,199,255,0.42)',
      editorBg: '#071228', editorGutterBg: '#08162f', editorGutterColor: '#3e69a7',
      editorActiveLine: '#0d1c3c', editorSelection: 'rgba(56,163,255,0.36)', editorCursor: '#bfe9ff',
      syntaxComment: '#5f78a8', syntaxKeyword: '#8fb7ff', syntaxString: '#73e6c2',
      syntaxNumber: '#ffd27a', syntaxFunction: '#77c7ff', syntaxVariable: '#edf5ff',
      syntaxTag: '#ff8ba7', syntaxAttribute: '#8ad8ff', syntaxOperator: '#9be7ff',
      syntaxMeta: '#b8d8ff', syntaxAdded: '#73e6c2', syntaxDeleted: '#ff8ba7',
      syntaxAddedBg: 'rgba(115,230,194,0.14)', syntaxDeletedBg: 'rgba(255,139,167,0.14)',
    },
  },
  'github-light': {
    name: 'GitHub Light', type: 'light',
    colors: {
      bgPrimary: '#ffffff', bgSecondary: '#f6f8fa', borderColor: '#d1d9e0',
      textPrimary: '#1f2328', textSecondary: '#656d76', textTertiary: '#8b949e',
      accentColor: '#0969da', linkColor: '#0969da',
      hoverBg: 'rgba(208,215,222,0.32)', activeBg: 'rgba(9,105,218,0.08)',
      codeBg: 'rgba(175,184,193,0.2)', preBg: '#f6f8fa',
      tableBorder: '#d1d9e0', tableHeaderBg: '#f6f8fa', tableRowBg: '#f6f8fa',
      scrollbarThumb: 'rgba(0,0,0,0.15)', scrollbarThumbHover: 'rgba(0,0,0,0.3)',
      editorBg: '#ffffff', editorGutterBg: '#f6f8fa', editorGutterColor: '#8b949e',
      editorActiveLine: '#f6f8fa', editorSelection: 'rgba(9,105,218,0.25)', editorCursor: '#1f2328',
      syntaxComment: '#6a737d', syntaxKeyword: '#d73a49', syntaxString: '#032f62',
      syntaxNumber: '#005cc5', syntaxFunction: '#6f42c1', syntaxVariable: '#24292e',
      syntaxTag: '#22863a', syntaxAttribute: '#005cc5', syntaxOperator: '#d73a49',
      syntaxMeta: '#735c0f', syntaxAdded: '#22863a', syntaxDeleted: '#b31d28',
      syntaxAddedBg: '#f0fff4', syntaxDeletedBg: '#ffeef0',
    },
  },
  'github-dark': {
    name: 'GitHub Dark', type: 'dark',
    colors: {
      bgPrimary: '#0d1117', bgSecondary: '#161b22', borderColor: '#30363d',
      textPrimary: '#e6edf3', textSecondary: '#8b949e', textTertiary: '#6e7681',
      accentColor: '#4493f8', linkColor: '#4493f8',
      hoverBg: 'rgba(177,186,196,0.12)', activeBg: 'rgba(68,147,248,0.12)',
      codeBg: 'rgba(110,118,129,0.25)', preBg: '#161b22',
      tableBorder: '#30363d', tableHeaderBg: '#161b22', tableRowBg: 'rgba(110,118,129,0.06)',
      scrollbarThumb: 'rgba(255,255,255,0.15)', scrollbarThumbHover: 'rgba(255,255,255,0.3)',
      editorBg: '#0d1117', editorGutterBg: '#0d1117', editorGutterColor: '#6e7681',
      editorActiveLine: '#161b22', editorSelection: 'rgba(68,147,248,0.40)', editorCursor: '#e6edf3',
      syntaxComment: '#8b949e', syntaxKeyword: '#ff7b72', syntaxString: '#a5d6ff',
      syntaxNumber: '#79c0ff', syntaxFunction: '#d2a8ff', syntaxVariable: '#e6edf3',
      syntaxTag: '#7ee787', syntaxAttribute: '#79c0ff', syntaxOperator: '#ff7b72',
      syntaxMeta: '#d29922', syntaxAdded: '#7ee787', syntaxDeleted: '#ffa198',
      syntaxAddedBg: 'rgba(63,185,80,0.15)', syntaxDeletedBg: 'rgba(248,81,73,0.15)',
    },
  },
  'dracula': {
    name: 'Dracula', type: 'dark',
    colors: {
      bgPrimary: '#282a36', bgSecondary: '#21222c', borderColor: '#44475a',
      textPrimary: '#f8f8f2', textSecondary: '#bfbfbf', textTertiary: '#6272a4',
      accentColor: '#bd93f9', linkColor: '#8be9fd',
      hoverBg: 'rgba(68,71,90,0.5)', activeBg: 'rgba(189,147,249,0.15)',
      codeBg: 'rgba(68,71,90,0.5)', preBg: '#21222c',
      tableBorder: '#44475a', tableHeaderBg: '#21222c', tableRowBg: 'rgba(68,71,90,0.2)',
      scrollbarThumb: 'rgba(255,255,255,0.15)', scrollbarThumbHover: 'rgba(255,255,255,0.3)',
      editorBg: '#282a36', editorGutterBg: '#282a36', editorGutterColor: '#6272a4',
      editorActiveLine: '#44475a', editorSelection: 'rgba(68,71,90,0.6)', editorCursor: '#f8f8f2',
      syntaxComment: '#6272a4', syntaxKeyword: '#ff79c6', syntaxString: '#f1fa8c',
      syntaxNumber: '#bd93f9', syntaxFunction: '#50fa7b', syntaxVariable: '#f8f8f2',
      syntaxTag: '#ff79c6', syntaxAttribute: '#50fa7b', syntaxOperator: '#ff79c6',
      syntaxMeta: '#f8f8f2', syntaxAdded: '#50fa7b', syntaxDeleted: '#ff5555',
      syntaxAddedBg: 'rgba(80,250,123,0.15)', syntaxDeletedBg: 'rgba(255,85,85,0.15)',
    },
  },
  'nord': {
    name: 'Nord', type: 'dark',
    colors: {
      bgPrimary: '#2e3440', bgSecondary: '#3b4252', borderColor: '#4c566a',
      textPrimary: '#eceff4', textSecondary: '#d8dee9', textTertiary: '#4c566a',
      accentColor: '#88c0d0', linkColor: '#88c0d0',
      hoverBg: 'rgba(76,86,106,0.4)', activeBg: 'rgba(136,192,208,0.15)',
      codeBg: 'rgba(76,86,106,0.3)', preBg: '#3b4252',
      tableBorder: '#4c566a', tableHeaderBg: '#3b4252', tableRowBg: 'rgba(76,86,106,0.15)',
      scrollbarThumb: 'rgba(255,255,255,0.12)', scrollbarThumbHover: 'rgba(255,255,255,0.25)',
      editorBg: '#2e3440', editorGutterBg: '#2e3440', editorGutterColor: '#4c566a',
      editorActiveLine: '#3b4252', editorSelection: 'rgba(136,192,208,0.40)', editorCursor: '#d8dee9',
      syntaxComment: '#616e88', syntaxKeyword: '#81a1c1', syntaxString: '#a3be8c',
      syntaxNumber: '#b48ead', syntaxFunction: '#88c0d0', syntaxVariable: '#d8dee9',
      syntaxTag: '#81a1c1', syntaxAttribute: '#8fbcbb', syntaxOperator: '#81a1c1',
      syntaxMeta: '#ebcb8b', syntaxAdded: '#a3be8c', syntaxDeleted: '#bf616a',
      syntaxAddedBg: 'rgba(163,190,140,0.15)', syntaxDeletedBg: 'rgba(191,97,106,0.15)',
    },
  },
  'solarized-light': {
    name: 'Solarized Light', type: 'light',
    colors: {
      bgPrimary: '#fdf6e3', bgSecondary: '#eee8d5', borderColor: '#d3cbb7',
      textPrimary: '#657b83', textSecondary: '#93a1a1', textTertiary: '#93a1a1',
      accentColor: '#268bd2', linkColor: '#268bd2',
      hoverBg: 'rgba(0,0,0,0.06)', activeBg: 'rgba(38,139,210,0.1)',
      codeBg: 'rgba(0,0,0,0.05)', preBg: '#eee8d5',
      tableBorder: '#d3cbb7', tableHeaderBg: '#eee8d5', tableRowBg: '#eee8d5',
      scrollbarThumb: 'rgba(0,0,0,0.15)', scrollbarThumbHover: 'rgba(0,0,0,0.3)',
      editorBg: '#fdf6e3', editorGutterBg: '#eee8d5', editorGutterColor: '#93a1a1',
      editorActiveLine: '#eee8d5', editorSelection: 'rgba(38,139,210,0.25)', editorCursor: '#657b83',
      syntaxComment: '#93a1a1', syntaxKeyword: '#859900', syntaxString: '#2aa198',
      syntaxNumber: '#d33682', syntaxFunction: '#268bd2', syntaxVariable: '#657b83',
      syntaxTag: '#268bd2', syntaxAttribute: '#b58900', syntaxOperator: '#859900',
      syntaxMeta: '#b58900', syntaxAdded: '#859900', syntaxDeleted: '#dc322f',
      syntaxAddedBg: 'rgba(133,153,0,0.1)', syntaxDeletedBg: 'rgba(220,50,47,0.1)',
    },
  },
  'one-dark': {
    name: 'One Dark', type: 'dark',
    colors: {
      bgPrimary: '#282c34', bgSecondary: '#21252b', borderColor: '#3e4452',
      textPrimary: '#abb2bf', textSecondary: '#7f848e', textTertiary: '#5c6370',
      accentColor: '#61afef', linkColor: '#61afef',
      hoverBg: 'rgba(62,68,82,0.5)', activeBg: 'rgba(97,175,239,0.15)',
      codeBg: 'rgba(62,68,82,0.5)', preBg: '#21252b',
      tableBorder: '#3e4452', tableHeaderBg: '#21252b', tableRowBg: 'rgba(62,68,82,0.2)',
      scrollbarThumb: 'rgba(255,255,255,0.12)', scrollbarThumbHover: 'rgba(255,255,255,0.25)',
      editorBg: '#282c34', editorGutterBg: '#282c34', editorGutterColor: '#5c6370',
      editorActiveLine: '#2c313c', editorSelection: 'rgba(97,175,239,0.40)', editorCursor: '#528bff',
      syntaxComment: '#5c6370', syntaxKeyword: '#c678dd', syntaxString: '#98c379',
      syntaxNumber: '#d19a66', syntaxFunction: '#61afef', syntaxVariable: '#e06c75',
      syntaxTag: '#e06c75', syntaxAttribute: '#d19a66', syntaxOperator: '#56b6c2',
      syntaxMeta: '#d19a66', syntaxAdded: '#98c379', syntaxDeleted: '#e06c75',
      syntaxAddedBg: 'rgba(152,195,121,0.15)', syntaxDeletedBg: 'rgba(224,108,117,0.15)',
    },
  },
  'monokai': {
    name: 'Monokai', type: 'dark',
    colors: {
      bgPrimary: '#272822', bgSecondary: '#1e1f1c', borderColor: '#3e3d32',
      textPrimary: '#f8f8f2', textSecondary: '#b8b8b2', textTertiary: '#75715e',
      accentColor: '#a6e22e', linkColor: '#66d9ef',
      hoverBg: 'rgba(62,61,50,0.5)', activeBg: 'rgba(166,226,46,0.12)',
      codeBg: 'rgba(62,61,50,0.5)', preBg: '#1e1f1c',
      tableBorder: '#3e3d32', tableHeaderBg: '#1e1f1c', tableRowBg: 'rgba(62,61,50,0.2)',
      scrollbarThumb: 'rgba(255,255,255,0.12)', scrollbarThumbHover: 'rgba(255,255,255,0.25)',
      editorBg: '#272822', editorGutterBg: '#272822', editorGutterColor: '#75715e',
      editorActiveLine: '#3e3d32', editorSelection: 'rgba(166,226,46,0.40)', editorCursor: '#f8f8f0',
      syntaxComment: '#75715e', syntaxKeyword: '#f92672', syntaxString: '#e6db74',
      syntaxNumber: '#ae81ff', syntaxFunction: '#a6e22e', syntaxVariable: '#f8f8f2',
      syntaxTag: '#f92672', syntaxAttribute: '#a6e22e', syntaxOperator: '#f92672',
      syntaxMeta: '#e6db74', syntaxAdded: '#a6e22e', syntaxDeleted: '#f92672',
      syntaxAddedBg: 'rgba(166,226,46,0.15)', syntaxDeletedBg: 'rgba(249,38,114,0.15)',
    },
  },
  'tokyo-night': {
    name: 'Tokyo Night', type: 'dark',
    colors: {
      bgPrimary: '#1a1b26', bgSecondary: '#16161e', borderColor: '#3b4261',
      textPrimary: '#a9b1d6', textSecondary: '#787c99', textTertiary: '#565f89',
      accentColor: '#7aa2f7', linkColor: '#7aa2f7',
      hoverBg: 'rgba(59,66,97,0.4)', activeBg: 'rgba(122,162,247,0.12)',
      codeBg: 'rgba(59,66,97,0.3)', preBg: '#16161e',
      tableBorder: '#3b4261', tableHeaderBg: '#16161e', tableRowBg: 'rgba(59,66,97,0.15)',
      scrollbarThumb: 'rgba(255,255,255,0.1)', scrollbarThumbHover: 'rgba(255,255,255,0.2)',
      editorBg: '#1a1b26', editorGutterBg: '#1a1b26', editorGutterColor: '#3b4261',
      editorActiveLine: '#1e202e', editorSelection: 'rgba(122,162,247,0.40)', editorCursor: '#c0caf5',
      syntaxComment: '#565f89', syntaxKeyword: '#bb9af7', syntaxString: '#9ece6a',
      syntaxNumber: '#ff9e64', syntaxFunction: '#7aa2f7', syntaxVariable: '#c0caf5',
      syntaxTag: '#f7768e', syntaxAttribute: '#7dcfff', syntaxOperator: '#89ddff',
      syntaxMeta: '#e0af68', syntaxAdded: '#9ece6a', syntaxDeleted: '#f7768e',
      syntaxAddedBg: 'rgba(158,206,106,0.15)', syntaxDeletedBg: 'rgba(247,118,142,0.15)',
    },
  },
  'catppuccin-mocha': {
    name: 'Catppuccin Mocha', type: 'dark',
    colors: {
      bgPrimary: '#1e1e2e', bgSecondary: '#181825', borderColor: '#45475a',
      textPrimary: '#cdd6f4', textSecondary: '#a6adc8', textTertiary: '#6c7086',
      accentColor: '#89b4fa', linkColor: '#89b4fa',
      hoverBg: 'rgba(69,71,90,0.4)', activeBg: 'rgba(137,180,250,0.12)',
      codeBg: 'rgba(69,71,90,0.35)', preBg: '#181825',
      tableBorder: '#45475a', tableHeaderBg: '#181825', tableRowBg: 'rgba(69,71,90,0.15)',
      scrollbarThumb: 'rgba(255,255,255,0.1)', scrollbarThumbHover: 'rgba(255,255,255,0.2)',
      editorBg: '#1e1e2e', editorGutterBg: '#1e1e2e', editorGutterColor: '#6c7086',
      editorActiveLine: '#181825', editorSelection: 'rgba(137,180,250,0.40)', editorCursor: '#f5e0dc',
      syntaxComment: '#6c7086', syntaxKeyword: '#cba6f7', syntaxString: '#a6e3a1',
      syntaxNumber: '#fab387', syntaxFunction: '#89b4fa', syntaxVariable: '#cdd6f4',
      syntaxTag: '#f38ba8', syntaxAttribute: '#89dceb', syntaxOperator: '#94e2d5',
      syntaxMeta: '#f9e2af', syntaxAdded: '#a6e3a1', syntaxDeleted: '#f38ba8',
      syntaxAddedBg: 'rgba(166,227,161,0.15)', syntaxDeletedBg: 'rgba(243,139,168,0.15)',
    },
  },
  'catppuccin-latte': {
    name: 'Catppuccin Latte', type: 'light',
    colors: {
      bgPrimary: '#eff1f5', bgSecondary: '#e6e9ef', borderColor: '#ccd0da',
      textPrimary: '#4c4f69', textSecondary: '#6c6f85', textTertiary: '#9ca0b0',
      accentColor: '#1e66f5', linkColor: '#1e66f5',
      hoverBg: 'rgba(204,208,218,0.4)', activeBg: 'rgba(30,102,245,0.1)',
      codeBg: 'rgba(204,208,218,0.35)', preBg: '#e6e9ef',
      tableBorder: '#ccd0da', tableHeaderBg: '#e6e9ef', tableRowBg: '#e6e9ef',
      scrollbarThumb: 'rgba(0,0,0,0.12)', scrollbarThumbHover: 'rgba(0,0,0,0.25)',
      editorBg: '#eff1f5', editorGutterBg: '#e6e9ef', editorGutterColor: '#9ca0b0',
      editorActiveLine: '#e6e9ef', editorSelection: 'rgba(30,102,245,0.25)', editorCursor: '#4c4f69',
      syntaxComment: '#9ca0b0', syntaxKeyword: '#8839ef', syntaxString: '#40a02b',
      syntaxNumber: '#fe640b', syntaxFunction: '#1e66f5', syntaxVariable: '#4c4f69',
      syntaxTag: '#d20f39', syntaxAttribute: '#04a5e5', syntaxOperator: '#179299',
      syntaxMeta: '#df8e1d', syntaxAdded: '#40a02b', syntaxDeleted: '#d20f39',
      syntaxAddedBg: 'rgba(64,160,43,0.1)', syntaxDeletedBg: 'rgba(210,15,57,0.1)',
    },
  },
  'gruvbox-dark': {
    name: 'Gruvbox Dark', type: 'dark',
    colors: {
      bgPrimary: '#282828', bgSecondary: '#1d2021', borderColor: '#504945',
      textPrimary: '#ebdbb2', textSecondary: '#bdae93', textTertiary: '#665c54',
      accentColor: '#83a598', linkColor: '#83a598',
      hoverBg: 'rgba(80,73,69,0.5)', activeBg: 'rgba(131,165,152,0.15)',
      codeBg: 'rgba(80,73,69,0.4)', preBg: '#1d2021',
      tableBorder: '#504945', tableHeaderBg: '#1d2021', tableRowBg: 'rgba(80,73,69,0.15)',
      scrollbarThumb: 'rgba(255,255,255,0.12)', scrollbarThumbHover: 'rgba(255,255,255,0.25)',
      editorBg: '#282828', editorGutterBg: '#282828', editorGutterColor: '#665c54',
      editorActiveLine: '#32302f', editorSelection: 'rgba(131,165,152,0.40)', editorCursor: '#ebdbb2',
      syntaxComment: '#928374', syntaxKeyword: '#fb4934', syntaxString: '#b8bb26',
      syntaxNumber: '#d3869b', syntaxFunction: '#83a598', syntaxVariable: '#ebdbb2',
      syntaxTag: '#fb4934', syntaxAttribute: '#fabd2f', syntaxOperator: '#fe8019',
      syntaxMeta: '#fabd2f', syntaxAdded: '#b8bb26', syntaxDeleted: '#fb4934',
      syntaxAddedBg: 'rgba(184,187,38,0.15)', syntaxDeletedBg: 'rgba(251,73,52,0.15)',
    },
  },
  'gruvbox-light': {
    name: 'Gruvbox Light', type: 'light',
    colors: {
      bgPrimary: '#fbf1c7', bgSecondary: '#f2e5bc', borderColor: '#d5c4a1',
      textPrimary: '#3c3836', textSecondary: '#665c54', textTertiary: '#928374',
      accentColor: '#076678', linkColor: '#076678',
      hoverBg: 'rgba(213,196,161,0.4)', activeBg: 'rgba(7,102,120,0.1)',
      codeBg: 'rgba(213,196,161,0.35)', preBg: '#f2e5bc',
      tableBorder: '#d5c4a1', tableHeaderBg: '#f2e5bc', tableRowBg: '#f2e5bc',
      scrollbarThumb: 'rgba(0,0,0,0.15)', scrollbarThumbHover: 'rgba(0,0,0,0.3)',
      editorBg: '#fbf1c7', editorGutterBg: '#f2e5bc', editorGutterColor: '#928374',
      editorActiveLine: '#f2e5bc', editorSelection: 'rgba(7,102,120,0.25)', editorCursor: '#3c3836',
      syntaxComment: '#928374', syntaxKeyword: '#9d0006', syntaxString: '#79740e',
      syntaxNumber: '#8f3f71', syntaxFunction: '#076678', syntaxVariable: '#3c3836',
      syntaxTag: '#9d0006', syntaxAttribute: '#b57614', syntaxOperator: '#af3a03',
      syntaxMeta: '#b57614', syntaxAdded: '#79740e', syntaxDeleted: '#9d0006',
      syntaxAddedBg: 'rgba(121,116,14,0.1)', syntaxDeletedBg: 'rgba(157,0,6,0.1)',
    },
  },
  'rose-pine': {
    name: 'Rose Pine', type: 'dark',
    colors: {
      bgPrimary: '#191724', bgSecondary: '#1f1d2e', borderColor: '#403d52',
      textPrimary: '#e0def4', textSecondary: '#908caa', textTertiary: '#6e6a86',
      accentColor: '#c4a7e7', linkColor: '#9ccfd8',
      hoverBg: 'rgba(64,61,82,0.5)', activeBg: 'rgba(196,167,231,0.12)',
      codeBg: 'rgba(64,61,82,0.4)', preBg: '#1f1d2e',
      tableBorder: '#403d52', tableHeaderBg: '#1f1d2e', tableRowBg: 'rgba(64,61,82,0.15)',
      scrollbarThumb: 'rgba(255,255,255,0.1)', scrollbarThumbHover: 'rgba(255,255,255,0.2)',
      editorBg: '#191724', editorGutterBg: '#191724', editorGutterColor: '#6e6a86',
      editorActiveLine: '#1f1d2e', editorSelection: 'rgba(196,167,231,0.40)', editorCursor: '#e0def4',
      syntaxComment: '#6e6a86', syntaxKeyword: '#31748f', syntaxString: '#f6c177',
      syntaxNumber: '#c4a7e7', syntaxFunction: '#9ccfd8', syntaxVariable: '#e0def4',
      syntaxTag: '#eb6f92', syntaxAttribute: '#9ccfd8', syntaxOperator: '#31748f',
      syntaxMeta: '#f6c177', syntaxAdded: '#9ccfd8', syntaxDeleted: '#eb6f92',
      syntaxAddedBg: 'rgba(156,207,216,0.15)', syntaxDeletedBg: 'rgba(235,111,146,0.15)',
    },
  },
  'ayu-light': {
    name: 'Ayu Light', type: 'light',
    colors: {
      bgPrimary: '#fafafa', bgSecondary: '#f0f0f0', borderColor: '#d8d8d7',
      textPrimary: '#5c6166', textSecondary: '#8a9199', textTertiary: '#abb0b6',
      accentColor: '#399ee6', linkColor: '#399ee6',
      hoverBg: 'rgba(216,216,215,0.35)', activeBg: 'rgba(57,158,230,0.1)',
      codeBg: 'rgba(216,216,215,0.3)', preBg: '#f0f0f0',
      tableBorder: '#d8d8d7', tableHeaderBg: '#f0f0f0', tableRowBg: '#f0f0f0',
      scrollbarThumb: 'rgba(0,0,0,0.12)', scrollbarThumbHover: 'rgba(0,0,0,0.25)',
      editorBg: '#fafafa', editorGutterBg: '#f0f0f0', editorGutterColor: '#abb0b6',
      editorActiveLine: '#f0f0f0', editorSelection: 'rgba(57,158,230,0.25)', editorCursor: '#5c6166',
      syntaxComment: '#abb0b6', syntaxKeyword: '#fa8d3e', syntaxString: '#86b300',
      syntaxNumber: '#a37acc', syntaxFunction: '#399ee6', syntaxVariable: '#5c6166',
      syntaxTag: '#f07171', syntaxAttribute: '#399ee6', syntaxOperator: '#ed9366',
      syntaxMeta: '#a37acc', syntaxAdded: '#86b300', syntaxDeleted: '#f07171',
      syntaxAddedBg: 'rgba(134,179,0,0.1)', syntaxDeletedBg: 'rgba(240,113,113,0.1)',
    },
  },
};

// ==================== CSS variable mapping ====================
function toCssVar(key) {
  return '--' + key.replace(/([A-Z])/g, '-$1').toLowerCase();
}

export function applyThemeColors(colors) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(colors)) {
    root.style.setProperty(toCssVar(key), value);
  }
}

// ==================== Persistence ====================
const STORAGE_THEME_ID = 'orpad-theme';
const STORAGE_CUSTOM_THEMES = 'orpad-custom-themes';

export function getSavedThemeId() {
  return localStorage.getItem(STORAGE_THEME_ID) || DEFAULT_THEME_ID;
}

export function saveThemeId(id) {
  localStorage.setItem(STORAGE_THEME_ID, id);
}

// ==================== Custom Themes CRUD ====================
export function getCustomThemes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_CUSTOM_THEMES)) || {};
  } catch {
    return {};
  }
}

function saveCustomThemes(themes) {
  localStorage.setItem(STORAGE_CUSTOM_THEMES, JSON.stringify(themes));
}

export function addCustomTheme(name, baseThemeId) {
  const base = builtinThemes[baseThemeId] || builtinThemes[DEFAULT_THEME_ID];
  const id = 'custom-' + Date.now();
  const themes = getCustomThemes();
  themes[id] = { name, type: base.type, colors: { ...base.colors } };
  saveCustomThemes(themes);
  return id;
}

export function updateCustomThemeColors(id, colors) {
  const themes = getCustomThemes();
  if (themes[id]) {
    themes[id].colors = { ...themes[id].colors, ...colors };
    saveCustomThemes(themes);
  }
}

export function updateCustomThemeName(id, name) {
  const themes = getCustomThemes();
  if (themes[id]) {
    themes[id].name = name;
    saveCustomThemes(themes);
  }
}

export function deleteCustomTheme(id) {
  const themes = getCustomThemes();
  delete themes[id];
  saveCustomThemes(themes);
}

// ==================== Customize field definitions ====================
export const CUSTOMIZE_GROUPS = [
  {
    i18n: 'group.background',
    fields: [
      { key: 'bgPrimary', i18n: 'field.bgPrimary' },
      { key: 'bgSecondary', i18n: 'field.bgSecondary' },
      { key: 'borderColor', i18n: 'field.border' },
    ],
  },
  {
    i18n: 'group.text',
    fields: [
      { key: 'textPrimary', i18n: 'field.textPrimary' },
      { key: 'textSecondary', i18n: 'field.textSecondary' },
      { key: 'accentColor', i18n: 'field.accent' },
    ],
  },
  {
    i18n: 'group.editor',
    fields: [
      { key: 'editorBg', i18n: 'field.editorBg' },
      { key: 'editorGutterBg', i18n: 'field.gutterBg' },
      { key: 'editorGutterColor', i18n: 'field.gutterColor' },
      { key: 'editorActiveLine', i18n: 'field.activeLine' },
      { key: 'editorCursor', i18n: 'field.cursor' },
    ],
  },
  {
    i18n: 'group.syntax',
    fields: [
      { key: 'syntaxKeyword', i18n: 'field.keyword' },
      { key: 'syntaxString', i18n: 'field.string' },
      { key: 'syntaxComment', i18n: 'field.comment' },
      { key: 'syntaxNumber', i18n: 'field.number' },
      { key: 'syntaxFunction', i18n: 'field.function' },
      { key: 'syntaxTag', i18n: 'field.tag' },
    ],
  },
];

// ==================== Helpers for custom theme derivation ====================
function hexToRgb(hex) {
  const m = hex.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!m) return { r: 128, g: 128, b: 128 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

export function deriveFullColors(base, isDark) {
  const accent = hexToRgb(base.accentColor || '#0969da');
  const border = hexToRgb(base.borderColor || '#d1d9e0');
  return {
    ...base,
    linkColor: base.linkColor || base.accentColor,
    textTertiary: base.textTertiary || base.textSecondary,
    hoverBg: `rgba(${border.r},${border.g},${border.b},${isDark ? 0.4 : 0.32})`,
    activeBg: `rgba(${accent.r},${accent.g},${accent.b},0.12)`,
    codeBg: `rgba(${border.r},${border.g},${border.b},${isDark ? 0.3 : 0.2})`,
    preBg: base.bgSecondary,
    tableBorder: base.borderColor,
    tableHeaderBg: base.bgSecondary,
    tableRowBg: base.bgSecondary,
    scrollbarThumb: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)',
    scrollbarThumbHover: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
    editorGutterBg: base.editorGutterBg || base.editorBg,
    editorGutterColor: base.editorGutterColor || base.textSecondary,
    editorSelection: `rgba(${accent.r},${accent.g},${accent.b},${isDark ? 0.40 : 0.25})`,
    syntaxVariable: base.syntaxVariable || base.textPrimary,
    syntaxAttribute: base.syntaxAttribute || base.syntaxNumber || base.accentColor,
    syntaxOperator: base.syntaxOperator || base.syntaxKeyword,
    syntaxMeta: base.syntaxMeta || base.syntaxNumber,
    syntaxAdded: base.syntaxAdded || base.syntaxString,
    syntaxDeleted: base.syntaxDeleted || base.syntaxKeyword,
    syntaxAddedBg: `rgba(${hexToRgb(base.syntaxAdded || base.syntaxString || '#22863a').r},${hexToRgb(base.syntaxAdded || base.syntaxString || '#22863a').g},${hexToRgb(base.syntaxAdded || base.syntaxString || '#22863a').b},0.15)`,
    syntaxDeletedBg: `rgba(${hexToRgb(base.syntaxDeleted || base.syntaxKeyword || '#d73a49').r},${hexToRgb(base.syntaxDeleted || base.syntaxKeyword || '#d73a49').g},${hexToRgb(base.syntaxDeleted || base.syntaxKeyword || '#d73a49').b},0.15)`,
  };
}
