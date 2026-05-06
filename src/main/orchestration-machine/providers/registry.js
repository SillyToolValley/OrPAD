const plugins = new Map();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertPluginShape(plugin) {
  if (!isPlainObject(plugin)) {
    throw new Error('Provider plugin must be an object.');
  }
  if (typeof plugin.id !== 'string' || !plugin.id.trim()) {
    throw new Error('Provider plugin must declare a non-empty string id.');
  }
  const family = plugin.family;
  if (family !== 'api' && family !== 'cli') {
    throw new Error(`Provider plugin "${plugin.id}" must declare family 'api' or 'cli'.`);
  }
  if (plugin.dangerousArgs !== undefined) {
    if (!Array.isArray(plugin.dangerousArgs)
      || plugin.dangerousArgs.some(arg => typeof arg !== 'string' || !arg)) {
      throw new Error(`Provider plugin "${plugin.id}" dangerousArgs must be an array of non-empty strings.`);
    }
  }
}

function registerProviderPlugin(plugin) {
  assertPluginShape(plugin);
  if (plugins.has(plugin.id)) {
    throw new Error(`Provider plugin already registered: ${plugin.id}`);
  }
  plugins.set(plugin.id, plugin);
  return plugin;
}

function getProviderPlugin(id) {
  return plugins.get(id) || null;
}

function hasProviderPlugin(id) {
  return plugins.has(id);
}

function listProviderPlugins() {
  return [...plugins.values()];
}

function listProviderPluginIds() {
  return [...plugins.keys()];
}

function unregisterProviderPlugin(id) {
  return plugins.delete(id);
}

function dangerousArgsForProvider(id) {
  const plugin = getProviderPlugin(id);
  return plugin && Array.isArray(plugin.dangerousArgs) ? [...plugin.dangerousArgs] : [];
}

function resolveProviderIdFromAdapter(adapter) {
  if (!isPlainObject(adapter)) return '';
  if (adapter.schemaVersion === 'orpad.machineAdapter.v2'
    && isPlainObject(adapter.default)
    && typeof adapter.default.providerId === 'string') {
    return adapter.default.providerId.trim();
  }
  if (typeof adapter.providerId === 'string' && adapter.providerId.trim()) {
    return adapter.providerId.trim();
  }
  if (typeof adapter.type === 'string' && adapter.type.trim()) {
    return adapter.type.trim();
  }
  return '';
}

function getProviderPluginForAdapter(adapter) {
  const providerId = resolveProviderIdFromAdapter(adapter);
  if (!providerId) return null;
  return getProviderPlugin(providerId);
}

module.exports = {
  dangerousArgsForProvider,
  getProviderPlugin,
  getProviderPluginForAdapter,
  hasProviderPlugin,
  listProviderPluginIds,
  listProviderPlugins,
  registerProviderPlugin,
  resolveProviderIdFromAdapter,
  unregisterProviderPlugin,
};

registerProviderPlugin(require('./plugins/codex-cli'));
registerProviderPlugin(require('./plugins/anthropic'));
