const MACHINE_STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,190}$/;

function machineStorageIdError(value, label) {
  const err = new Error(`${label} must be a Machine storage id segment.`);
  err.code = 'MACHINE_STORAGE_ID_INVALID';
  err.field = label;
  err.value = value;
  return err;
}

function assertMachineStorageId(value, label = 'id') {
  if (typeof value !== 'string') throw machineStorageIdError(value, label);
  if (!MACHINE_STORAGE_ID_PATTERN.test(value)) throw machineStorageIdError(value, label);
  return value;
}

module.exports = {
  MACHINE_STORAGE_ID_PATTERN,
  assertMachineStorageId,
};
