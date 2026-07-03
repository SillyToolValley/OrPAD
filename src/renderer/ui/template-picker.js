import { createTemplateFile, listTemplates } from '../templates/registry.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function previewFor(template) {
  try {
    return createTemplateFile(template.id, {
      title: template.fields?.find(field => field.key === 'title')?.placeholder || template.label,
      owner: '@owner',
      status: 'Proposed',
    }).content;
  } catch {
    return '';
  }
}

export function openTemplatePicker({ openModal, closeModal, onCreate, notify }) {
  const templates = listTemplates();
  let selected = templates[0];
  const values = {};

  const body = el('div', 'template-picker');
  const list = el('div', 'template-list');
  const detail = el('div', 'template-detail');
  body.append(list, detail);

  function renderDetail() {
    detail.innerHTML = '';
    detail.appendChild(el('h3', '', selected.label));
    detail.appendChild(el('p', 'template-description', selected.description || ''));

    const fieldBox = el('div', 'template-fields');
    for (const field of selected.fields || []) {
      const row = el('label', 'template-field');
      const label = el('span', '', field.required ? `${field.label} *` : field.label);
      const input = document.createElement('input');
      input.type = 'text';
      input.value = values[field.key] || '';
      input.placeholder = field.placeholder || '';
      input.addEventListener('input', () => {
        values[field.key] = input.value;
      });
      row.append(label, input);
      fieldBox.appendChild(row);
    }
    detail.appendChild(fieldBox);

    const preview = el('pre', 'template-preview');
    preview.textContent = previewFor(selected).slice(0, 5000);
    detail.appendChild(preview);
    setTimeout(() => detail.querySelector('input')?.focus(), 0);
  }

  function renderList() {
    list.innerHTML = '';
    for (const template of templates) {
      const btn = el('button', `template-list-item ${template.id === selected.id ? 'active' : ''}`);
      btn.type = 'button';
      btn.appendChild(el('strong', '', template.label));
      btn.appendChild(el('span', '', template.description || ''));
      btn.addEventListener('click', () => {
        selected = template;
        renderList();
        renderDetail();
      });
      list.appendChild(btn);
    }
  }

  function create() {
    for (const field of selected.fields || []) {
      if (field.required && !String(values[field.key] || '').trim()) {
        notify?.('Templates', new Error(`${field.label} is required.`));
        detail.querySelector(`input[placeholder="${field.placeholder || ''}"]`)?.focus();
        return;
      }
    }
    const vars = {};
    for (const field of selected.fields || []) {
      vars[field.key] = String(values[field.key] || field.placeholder || '').trim();
    }
    const file = createTemplateFile(selected.id, vars);
    onCreate?.(file);
    closeModal?.();
  }

  renderList();
  renderDetail();

  openModal({
    title: 'New from Template',
    body,
    footer: [
      { label: 'Cancel', onClick: () => closeModal?.() },
      { label: 'Create', primary: true, onClick: create },
    ],
  });
}
