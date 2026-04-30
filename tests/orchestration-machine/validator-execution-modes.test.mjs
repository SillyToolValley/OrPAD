import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  validateRunbookFile,
  validateRunbookObject,
} = require('../../src/main/runbooks/validator');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const maintenancePipelinePath = path.join(
  repoRoot,
  '.orpad/pipelines/orpad-maintenance-quality-workstream-20260429/pipeline.or-pipeline',
);
const workstreamNodePackPath = path.join(repoRoot, 'nodes/orpad.workstream/orpad.node-pack.json');

test('maintenance workstream keeps local MVP execution separate from Machine compatibility', async () => {
  const result = await validateRunbookFile(maintenancePipelinePath);

  assert.equal(result.ok, true);
  assert.equal(result.canExecute, false);
  assert.equal(result.canMachineExecute, true);
  assert.deepEqual(result.executionModes, ['machine', 'handoff']);
  assert.deepEqual(result.machineBlockedReasons, []);
  assert.deepEqual(result.machineUnsupportedNodeTypes, []);
  assert.equal(result.handoffCompatibility.available, true);
  assert.equal(result.handoffCompatibility.mode, 'path-only-agent-handoff');
  assert.equal(result.handoffCompatibility.nodeTypes.includes('orpad.workerLoop'), true);
  assert.equal(result.handoffCompatibility.nodeTypes.includes('orpad.workQueue'), true);
  assert.equal(
    result.diagnostics.some(diagnostic => diagnostic.code === 'PIPELINE_AGENT_ORCHESTRATED'),
    true,
  );
});

test('local MVP executable runbooks also advertise Machine execution mode', () => {
  const result = validateRunbookObject({
    kind: 'orpad.graph',
    version: '1.0',
    graph: {
      nodes: [
        {
          id: 'context',
          type: 'orpad.context',
        },
      ],
      edges: [],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.canExecute, true);
  assert.equal(result.canMachineExecute, true);
  assert.deepEqual(result.executionModes, ['local', 'machine']);
  assert.deepEqual(result.machineBlockedReasons, []);
  assert.deepEqual(result.machineUnsupportedNodeTypes, []);
});

test('Machine execution blocks unreviewed trust levels separately from validation success', () => {
  const result = validateRunbookObject({
    kind: 'orpad.graph',
    version: '1.0',
    trustLevel: 'generated-draft',
    graph: {
      nodes: [
        {
          id: 'context',
          type: 'orpad.context',
        },
      ],
      edges: [],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.canExecute, false);
  assert.equal(result.canMachineExecute, false);
  assert.deepEqual(result.executionModes, []);
  assert.deepEqual(result.machineBlockedReasons, ['trust-review-required']);
});

test('workstream node pack declares Machine runtime metadata and adapter capabilities', async () => {
  const nodePack = JSON.parse(await fs.readFile(workstreamNodePackPath, 'utf8'));
  const declaredCapabilities = new Set(nodePack.capabilities);

  assert.equal(nodePack.compatibility.machineApi, 'orpad.machine.v1');
  assert.equal(nodePack.compatibility.adapterProtocol, 'orpad.adapterRequest.v1');
  assert.equal(nodePack.compatibility.nodeRuntime, 'orpad.embedded-machine');

  for (const node of nodePack.nodes) {
    assert.equal(typeof node.runtimeHandlerKind, 'string', `${node.type} should declare runtimeHandlerKind`);
    assert.equal(node.machineApi, 'orpad.machine.v1', `${node.type} should declare the Machine API contract`);
    assert.equal(Array.isArray(node.capabilities), true, `${node.type} should declare capabilities`);
    for (const capability of node.capabilities) {
      assert.equal(declaredCapabilities.has(capability), true, `${node.type} capability ${capability} must be pack-declared`);
    }
    if (node.runtimeHandlerKind === 'adapter-required') {
      assert.equal(node.adapterProtocol, 'orpad.adapterRequest.v1', `${node.type} should declare adapterProtocol`);
    }
  }
});
