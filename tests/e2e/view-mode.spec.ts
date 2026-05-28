import { test, expect } from '@playwright/test';
import { launchElectron } from '../helpers';

test('editor-only mode fills the workspace after split pane resize', async () => {
  const app = await launchElectron();
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  try {
    await win.locator('#btn-split').click();
    await win.evaluate(() => {
      const editorPane = document.getElementById('editor-pane') as HTMLElement | null;
      const previewPane = document.getElementById('preview-pane') as HTMLElement | null;
      if (!editorPane || !previewPane) throw new Error('view panes not found');
      editorPane.style.flex = 'none';
      editorPane.style.width = '320px';
      previewPane.style.flex = '1';
    });

    await win.locator('#btn-editor').click();
    await expect(win.locator('#preview-pane')).toBeHidden();

    const layout = await win.evaluate(() => {
      const workspace = document.getElementById('workspace')?.getBoundingClientRect();
      const sidebar = document.getElementById('sidebar')?.getBoundingClientRect();
      const sidebarResize = document.getElementById('sidebar-resize')?.getBoundingClientRect();
      const editorPane = document.getElementById('editor-pane')?.getBoundingClientRect();
      const visibleWidth = (rect?: DOMRect) => rect && rect.width > 0 ? rect.width : 0;
      return {
        workspaceWidth: workspace?.width || 0,
        sidebarWidth: visibleWidth(sidebar),
        sidebarResizeWidth: visibleWidth(sidebarResize),
        editorWidth: editorPane?.width || 0,
      };
    });
    const availableEditorArea = layout.workspaceWidth - layout.sidebarWidth - layout.sidebarResizeWidth;

    expect(layout.editorWidth).toBeGreaterThan(availableEditorArea - 2);
  } finally {
    await app.close();
  }
});
