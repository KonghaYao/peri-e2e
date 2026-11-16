#!/usr/bin/env node
/**
 * 一次性迁移脚本：把 #409 v5 单出口的 builtin 命名与资源面 re-anchor 到 replay world v2。
 * 禁止日常使用：日常 prompt 同步走 `e2e:replay:world-sync`；其他未映射 leaf 变化必须重录。
 *
 * 背景：v5 单出口把六个 builtin server 收敛为 `peri`。`sys.block1.*` 与请求 stub
 * 中残留的旧事实必须确定性地改写：
 * - deferred/skill 模型面名 `mcp__<capability>__*` → `mcp__peri__*`；
 * - `mcp_read_resource` 的四个 server 行合并为单个 `server "peri"` 行（web 无资源）；
 * - `web-researcher` agent 行消失（web 能力不再声明资源）。
 * 脚本逐处改写并断言差异，重建 world，重渲染全部请求 stub（响应字节原样保留），
 * 重封 cassette seal；不允许的差异直接失败。首轮保留响应字节；
 * --responses-only 再按同一旧名 → 新名规则重锚响应片段及 portable source 校验；
 * --transcripts-only 重锚录制请求里的工具错误、资源目录与资源调用参数。
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const worldDir = path.join(fixtures, 'world');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));

const { loadCassette } = await load('llm-replay/cassette.mjs');
const { sha256 } = await load('llm-replay/matcher.mjs');
const {
  CASSETTE_FORMAT_VERSION, canonicalRecordedBody, collectWorldRefs, createWorldBuilder,
  expandTypedTemplateRules, loadWorld, requestCoreSha256, serializeRequestStub,
} = await load('llm-replay/world-store.mjs');
const { replaceWorldDirectory } = await load('scripts/world-sync-swap.mjs');

const BUILTIN_CAPABILITIES = ['workspace', 'web', 'artifact', 'cron', 'monitor', 'workflow'];
const RESOURCE_ORDER = ['workspace', 'cron', 'monitor', 'workflow', 'artifact'];

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
const text = (bytes) => bytes.toString('utf8');

if (process.argv.includes('--responses-only')) {
  const entries = await readdir(fixtures, { withFileTypes: true });
  let changed = 0;
  for (const candidate of entries) {
    if (!candidate.isDirectory()) continue;
    const directory = path.join(fixtures, candidate.name, 'cassette');
    let manifestBytes;
    try { manifestBytes = await readFile(path.join(directory, 'manifest.json')); }
    catch { continue; }
    const manifest = JSON.parse(text(manifestBytes));
    const sealFile = path.join(directory, 'seal.json');
    const seal = JSON.parse(await readFile(sealFile, 'utf8'));
    assert(seal.manifestSha256 === sha256(manifestBytes), `${candidate.name}: manifest seal mismatch`);
    let cassetteChanged = false;
    const responseHashes = new Map();
    for (const entry of manifest.entries) {
      const response = entry.response;
      const responseFile = path.join(directory, response.file);
      const bytes = await readFile(responseFile);
      responseHashes.set(JSON.stringify(entry.identity), response.sha256);
      assert(bytes.length === response.size && sha256(bytes) === response.sha256,
        `${candidate.name}: response bytes mismatch`);
      let sourceOffset = 0;
      let outputOffset = 0;
      const chunks = [];
      for (const chunk of response.chunks) {
        const before = bytes.subarray(chunk.offset, chunk.offset + chunk.length);
        assert(chunk.offset === sourceOffset && sha256(before) === chunk.sha256,
          `${candidate.name}: response chunk mismatch`);
        sourceOffset += chunk.length;
        const after = Buffer.from(migrateNames(before.toString('latin1')), 'latin1');
        chunks.push(after);
        chunk.offset = outputOffset;
        chunk.length = after.length;
        chunk.sha256 = sha256(after);
        outputOffset += after.length;
      }
      if (!chunks.length) continue;
      const updated = Buffer.concat(chunks);
      if (updated.equals(bytes)) continue;
      response.size = updated.length;
      response.submittedBytes = updated.length;
      response.sha256 = sha256(updated);
      responseHashes.set(JSON.stringify(entry.identity), response.sha256);
      await writeFile(responseFile, updated);
      cassetteChanged = true;
      changed += 1;
    }
    if (cassetteChanged) {
      const updatedManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
      seal.manifestSha256 = sha256(updatedManifest);
      await writeFile(path.join(directory, 'manifest.json'), updatedManifest);
      await writeFile(sealFile, `${JSON.stringify(seal)}\n`);
    }
    const scenarioFile = path.join(fixtures, candidate.name, 'scenario.json');
    const scenario = JSON.parse(await readFile(scenarioFile, 'utf8'));
    let scenarioChanged = false;
    for (const portable of scenario.portableResponses ?? []) {
      const updatedHash = responseHashes.get(JSON.stringify(portable.identity));
      if (updatedHash && portable.sourceSha256 !== updatedHash) {
        const entry = manifest.entries.find((item) => JSON.stringify(item.identity) === JSON.stringify(portable.identity));
        const original = execFileSync('git', ['show', `HEAD:fixtures/replay-v2/${candidate.name}/cassette/${entry.response.file}`], { cwd: e2eRoot });
        assert(portable.sourceSha256 === sha256(original), `${candidate.name}: portable source mismatch`);
        portable.sourceSha256 = updatedHash;
        scenarioChanged = true;
      }
    }
    if (scenarioChanged) await writeFile(scenarioFile, `${JSON.stringify(scenario, null, 2)}\n`);
  }
  console.log(JSON.stringify({ responseChunksReanchored: changed }));
  process.exit(0);
}

function migrateNames(value) {
  for (const capability of BUILTIN_CAPABILITIES) {
    value = value.replaceAll(`mcp__${capability}__`, 'mcp__peri__');
  }
  if (value.includes('mcp_read_resource')) {
    value = value.replaceAll(String.raw`\"server_name\":\"workspace\"`, String.raw`\"server_name\":\"peri\"`);
  }
  return value;
}

if (process.argv.includes('--transcripts-only')) {
  const world = await loadWorld(worldDir);
  let updatedStubs = 0;
  for (const candidate of await readdir(fixtures, { withFileTypes: true })) {
    if (!candidate.isDirectory()) continue;
    const directory = path.join(fixtures, candidate.name, 'cassette');
    let seal;
    try { seal = JSON.parse(await readFile(path.join(directory, 'seal.json'), 'utf8')); }
    catch { continue; }
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    let changed = false;
    for (const entry of manifest.entries) {
      const stubFile = entry.request.stub;
      const stubPath = path.join(directory, stubFile);
      const bytes = await readFile(stubPath);
      assert(seal.files[stubFile] === sha256(bytes), `${candidate.name}: request seal mismatch`);
      const stub = JSON.parse(text(bytes));
      const body = JSON.parse(world.renderParts(stub.parts).toString('utf8'));
      let parts = stub.parts;
      for (const message of body.messages ?? []) {
        for (const item of message.content ?? []) {
          if (item.type === 'tool_use' && item.name === 'ExecuteExtraTool'
              && item.input?.tool_name === 'mcp_read_resource'
              && item.input.params?.server_name === 'workspace') {
            const originalInput = JSON.stringify(item.input);
            const nextInput = JSON.stringify({ ...item.input, params: { ...item.input.params, server_name: 'peri' } });
            assert(parts.filter((part) => typeof part === 'string' && part.includes(originalInput)).length === 1,
              `${candidate.name}: resource call must be one literal`);
            parts = parts.map((part) => typeof part === 'string'
              ? part.replace(originalInput, nextInput) : part);
          }
          if (item.type !== 'tool_result') continue;
          for (const content of item.content ?? []) {
            if (content.type !== 'text') continue;
            const originalText = content.text;
            let nextText = originalText;
            for (const capability of BUILTIN_CAPABILITIES) {
              nextText = nextText.replaceAll(`MCP 服务器 "${capability}" 工具`, 'MCP 服务器 "peri" 工具');
            }
            if (nextText.includes('Available resources:')) {
              const result = JSON.parse(nextText);
              for (const tool of result.results ?? []) {
                const description = tool.description;
                if (typeof description !== 'string' || !description.includes('Available resources:')) continue;
                const migrated = description.includes('server "peri"')
                  ? description : migrateText(description, '\n', '"');
                nextText = nextText.replace(JSON.stringify(description), JSON.stringify(migrated));
              }
            }
            if (nextText === originalText) continue;
            const encoded = JSON.stringify(originalText);
            assert(parts.filter((part) => typeof part === 'string' && part.includes(encoded)).length === 1,
              `${candidate.name}: transcript text must be one literal`);
            parts = parts.map((part) => typeof part === 'string'
              ? part.replace(encoded, JSON.stringify(nextText)) : part);
          }
        }
      }
      if (parts.every((part, index) => part === stub.parts[index])) continue;
      stub.parts = parts;
      const raw = world.renderParts(parts);
      stub.rawBytes = raw.length;
      stub.rawSha256 = sha256(raw);
      const expanded = expandTypedTemplateRules(entry.requestRules ?? [], raw);
      stub.canonicalSha256 = sha256(canonicalRecordedBody(raw, expanded.rules, expanded.bindings));
      const updated = serializeRequestStub(stub);
      seal.files[stubFile] = sha256(updated);
      seal.requestMeta[stubFile].requestCoreSha256 = requestCoreSha256(stub);
      await writeFile(stubPath, updated);
      changed = true;
      updatedStubs += 1;
    }
    if (changed) await writeFile(path.join(directory, 'seal.json'), `${JSON.stringify(seal)}\n`);
  }
  console.log(JSON.stringify({ transcriptStubsReanchored: updatedStubs }));
  process.exit(0);
}

/** 把资源行 `- server "<name>": a, b (N resources)` 的列表与计数拆开。 */
function parseResourceLine(line, prefix, quote) {
  assert(line.startsWith(prefix), `资源行前缀不符: ${line}`);
  const rest = line.slice(prefix.length);
  const nameEnd = rest.indexOf(quote);
  assert(nameEnd > 0 && rest.slice(nameEnd + quote.length).startsWith(':'), `资源行缺少 server 名: ${line}`);
  const name = rest.slice(0, nameEnd);
  const value = rest.slice(nameEnd + quote.length + 1).trimStart();
  const match = /^(.*?)(?: \((\d+) resources\))?$/u.exec(value);
  assert(match, `资源行计数不合法: ${line}`);
  const resources = match[1].split(',').map((item) => item.trim()).filter(Boolean);
  const count = match[2] === undefined ? resources.length : Number(match[2]);
  assert(count === resources.length, `资源行计数与列表不符: ${line}`);
  return { name, resources };
}

/** 确定性改写文本；newline/quote 是目标文本的转义形态（leaf 为原始字符，stub 为 JSON 片段）。 */
function migrateText(before, newline, quote) {
  let value = before;
  for (const capability of BUILTIN_CAPABILITIES) {
    value = value.replaceAll(`mcp__${capability}__`, 'mcp__peri__');
    value = value.replaceAll(`[MCP:${capability}]`, '[MCP:peri]');
  }
  const connectionOld = 'MCP: 6 connected, 0 failed, 0 disabled' + newline
    + '- artifact (connected, 1 tools)' + newline
    + '- cron (connected, 5 tools)' + newline
    + '- monitor (connected, 4 tools)' + newline
    + '- web (connected, 2 tools)' + newline
    + '- workflow (connected, 9 tools)' + newline
    + '- workspace (connected, 7 tools)';
  const connectionNew = 'MCP: 1 connected, 0 failed, 0 disabled' + newline
    + '- peri (connected, 21 tools)';
  value = value.replace(connectionOld, connectionNew);
  value = value.replaceAll('MCP: 6 connected, 0 failed, 0 disabled', 'MCP: 1 connected, 0 failed, 0 disabled');

  const serverPrefix = `- server ${quote}`;
  const lines = value.split(newline);
  const serverLines = lines.filter((line) => line.startsWith(serverPrefix));
  const migrated = [];
  if (serverLines.length > 0) {
    const parsed = serverLines.map((line) => parseResourceLine(line, serverPrefix, quote));
    assert(new Set(parsed.map((entry) => entry.name)).size === parsed.length, '同一资源块出现重复 server');
    assert(!parsed.some((entry) => entry.name === 'peri'), '资源块已包含 peri，不能重复迁移');
    const resources = [];
    let total = 0;
    for (const capability of RESOURCE_ORDER) {
      const entry = parsed.find((candidate) => candidate.name === capability);
      if (!entry) continue;
      resources.push(...entry.resources);
      total += entry.resources.length;
    }
    assert(total > 0, '资源块没有任何可保留的资源');
    const collapsed = `${serverPrefix}peri${quote}: ${resources.join(', ')} (${total} resources)`;
    let inserted = false;
    for (const line of lines) {
      if (line.startsWith(serverPrefix)) {
        if (!inserted) {
          migrated.push(collapsed);
          inserted = true;
        }
        continue;
      }
      migrated.push(line);
    }
  } else {
    migrated.push(...lines);
  }

  return migrated
    .filter((line) => !line.startsWith('- web-researcher ['))
    .join(newline);
}

function migrateLiteralParts(parts) {
  return parts.map((part) => (typeof part === 'string' ? migrateText(part, '\\n', '\\"') : part));
}

function assertMigrated(label, before, after, newline, quote) {
  const expected = migrateText(before, newline, quote);
  if (after !== expected && process.env.PERI_DEBUG_REANCHOR) {
    let index = 0;
    while (index < after.length && index < expected.length && after[index] === expected[index]) index += 1;
    console.error(JSON.stringify({
      label,
      index,
      actual: after.slice(Math.max(0, index - 200), index + 500),
      expected: expected.slice(Math.max(0, index - 200), index + 500),
    }, null, 2));
  }
  assert(after === expected,
    `${label}: 差异不是 v5 单出口的命名/资源面改写（before=${before.length}, after=${after.length}）`);
}

const manifestBytes = await readFile(path.join(worldDir, 'manifest.json'));
const manifest = JSON.parse(text(manifestBytes));
const previousSeal = JSON.parse(await readFile(path.join(worldDir, 'seal.json'), 'utf8'));
assert(manifest.formatVersion === 2 && manifest.kind === 'world', 'world manifest 不是 v2');
assert(previousSeal.manifestSha256 === sha256(manifestBytes), 'world manifest 与旧 seal 不一致');
assert(previousSeal.formatVersion === 2, 'world seal 不是 v2');

const leafBytes = new Map();
for (const [id, meta] of Object.entries(manifest.leaves)) {
  const file = path.resolve(worldDir, meta.file);
  assert(file.startsWith(`${worldDir}${path.sep}`), `${id}: leaf 路径越出 world 根目录`);
  const bytes = await readFile(file);
  assert(previousSeal.leaves[id] !== undefined, `${id}: 旧 seal 未覆盖该 leaf`);
  leafBytes.set(id, bytes);
}

const changedLeaves = [];
const nextLeaves = new Map(leafBytes);
for (const [id, bytes] of leafBytes) {
  const before = text(bytes);
  const hasLegacy = BUILTIN_CAPABILITIES.some((capability) => before.includes(`mcp__${capability}__`));
  if (!hasLegacy && !before.includes('[MCP:') && !before.includes('- web-researcher [') && !before.includes('- server "')) continue;
  const after = migrateText(before, '\n', '"');
  assertMigrated(id, before, after, '\n', '"');
  nextLeaves.set(id, Buffer.from(after, 'utf8'));
  changedLeaves.push(id);
}
assert(changedLeaves.length > 0, 'world 中没有需要迁移的 leaf');

function buildWorld(overrides) {
  const builder = createWorldBuilder({ generation: manifest.generation });
  for (const [id] of Object.entries(manifest.leaves)) builder.addLeaf(id, overrides.get(id) ?? leafBytes.get(id));
  for (const [id, parts] of Object.entries(manifest.recipes)) builder.addRecipe(id, parts);
  return builder;
}
const newWorld = buildWorld(nextLeaves);
const previousWorld = buildWorld(leafBytes);

const cassetteIds = [];
for (const entry of await readdir(fixtures, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'world') continue;
  try {
    await readFile(path.join(fixtures, entry.name, 'cassette', 'manifest.json'));
    cassetteIds.push(entry.name);
  } catch { /* 非 cassette 目录 */ }
}
cassetteIds.sort();
assert(cassetteIds.length > 0, '没有找到 cassette');

const stagingBase = await mkdtemp(path.join(fixtures, '.reanchor-v5-single-exit-'));
const stagedWorldDir = path.join(stagingBase, 'world');
const stagedById = new Map();
const expectedCanonical = new Map();
let stubCount = 0;
let updatedStubs = 0;
let unchangedStubs = 0;
let responseCount = 0;
let sealCount = 0;

try {
  for (const id of cassetteIds) {
    const directory = path.join(fixtures, id, 'cassette');
    const cassetteManifestBytes = await readFile(path.join(directory, 'manifest.json'));
    const cassetteManifest = JSON.parse(text(cassetteManifestBytes));
    const seal = JSON.parse(await readFile(path.join(directory, 'seal.json'), 'utf8'));
    assert(cassetteManifest.formatVersion === CASSETTE_FORMAT_VERSION, `${id}: cassette 不是 v2`);
    assert(seal.formatVersion === CASSETTE_FORMAT_VERSION && seal.manifestSha256 === sha256(cassetteManifestBytes),
      `${id}: cassette seal 或 manifest 校验失败`);
    assert(seal.requestMeta && seal.files && typeof seal.requestMeta === 'object' && typeof seal.files === 'object',
      `${id}: seal 缺少元数据`);

    const stubFiles = cassetteManifest.entries.map((entry) => entry.request.stub);
    const metaFiles = Object.keys(seal.requestMeta);
    assert(new Set(stubFiles).size === stubFiles.length, `${id}: manifest 中 stub 路径重复`);
    assert(metaFiles.length === stubFiles.length && stubFiles.every((file) => Object.hasOwn(seal.requestMeta, file)),
      `${id}: seal.requestMeta 未精确覆盖 manifest 的全部 stub`);

    const output = path.join(stagingBase, 'cassettes', id, 'cassette');
    await mkdir(path.join(output, 'requests'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(output, 'responses'), { recursive: true, mode: 0o700 });
    const sealedFiles = {};
    const requestMeta = {};

    for (const entry of cassetteManifest.entries) {
      const stubFile = entry.request.stub;
      const stubBytes = await readFile(path.join(directory, stubFile));
      assert(seal.files[stubFile] === sha256(stubBytes), `${id}/${stubFile}: stub 未纳入 seal 或哈希不符`);
      const stub = JSON.parse(text(stubBytes));
      assert(stub.v === 2 && Array.isArray(stub.parts), `${id}/${stubFile}: stub 不是 v2`);

      const beforeBytes = previousWorld.renderParts(stub.parts);
      assert(sha256(beforeBytes) === stub.rawSha256, `${id}/${stubFile}: 逆推旧 world 渲染与录制 rawSha256 不符`);
      const migratedParts = migrateLiteralParts(stub.parts);
      const literalChanged = migratedParts.some((part, index) => part !== stub.parts[index]);
      const afterBytes = newWorld.renderParts(migratedParts);
      const affected = literalChanged
        || collectWorldRefs(stub.parts, previousWorld).some((ref) => changedLeaves.includes(ref.id));

      const beforeText = text(beforeBytes);
      const beforeExpanded = expandTypedTemplateRules(entry.requestRules ?? [], beforeBytes);
      const beforeCanonical = canonicalRecordedBody(beforeBytes, beforeExpanded.rules, beforeExpanded.bindings);
      assert(sha256(beforeCanonical) === stub.canonicalSha256, `${id}/${stubFile}: 逆推旧 canonicalSha256 不符`);

      const afterExpanded = expandTypedTemplateRules(entry.requestRules ?? [], afterBytes);
      const afterCanonical = canonicalRecordedBody(afterBytes, afterExpanded.rules, afterExpanded.bindings);

      if (affected) {
        assertMigrated(`${id}/${stubFile} raw`, beforeText, text(afterBytes), '\\n', '\\"');
        assertMigrated(`${id}/${stubFile} canonical`, beforeCanonical, afterCanonical, '\\n', '\\"');
        updatedStubs += 1;
      } else {
        assert(afterBytes.equals(beforeBytes), `${id}/${stubFile}: 未引用目标 leaf 却渲染出不同字节`);
        assert(afterCanonical === beforeCanonical, `${id}/${stubFile}: 未引用目标 leaf 却 canonical 不同`);
        unchangedStubs += 1;
      }

      const nextStub = {
        ...stub,
        parts: migratedParts,
        rawBytes: afterBytes.length,
        rawSha256: sha256(afterBytes),
        canonicalSha256: sha256(afterCanonical),
      };
      const nextStubBytes = serializeRequestStub(nextStub);
      if (!affected) assert(nextStubBytes.equals(stubBytes), `${id}/${stubFile}: 未变化 stub 重新序列化产生差异`);
      await writeFile(path.join(output, stubFile), nextStubBytes, { mode: 0o600 });
      sealedFiles[stubFile] = sha256(nextStubBytes);
      requestMeta[stubFile] = {
        requestCoreSha256: requestCoreSha256(nextStub),
        worldRefs: collectWorldRefs(nextStub.parts, newWorld),
      };
      expectedCanonical.set(`${id}/${stubFile}`, afterCanonical);

      const responseBytes = await readFile(path.join(directory, entry.response.file));
      assert(responseBytes.length === entry.response.size && sha256(responseBytes) === entry.response.sha256,
        `${id}/${entry.response.file}: 响应字节与 manifest 不符`);
      await writeFile(path.join(output, entry.response.file), responseBytes, { mode: 0o600 });
      responseCount += 1;
      stubCount += 1;
    }

    await writeFile(path.join(output, 'manifest.json'), cassetteManifestBytes, { mode: 0o600 });
    const nextSeal = {
      formatVersion: CASSETTE_FORMAT_VERSION,
      manifestSha256: sha256(cassetteManifestBytes),
      files: sortedObject(Object.entries(sealedFiles)),
      requestMeta: sortedObject(Object.entries(requestMeta)),
    };
    await writeFile(path.join(output, 'seal.json'), `${JSON.stringify(nextSeal)}\n`, { mode: 0o600 });
    stagedById.set(id, output);
    sealCount += 1;
  }

  const sealedWorld = await newWorld.seal(stagedWorldDir);
  const stagedManifestBytes = await readFile(path.join(stagedWorldDir, 'manifest.json'));
  assert(stagedManifestBytes.equals(manifestBytes), '重封 world 改变了 manifest；generation/结构必须保持不变');
  const stagedWorld = await loadWorld(stagedWorldDir);

  for (const [id, output] of stagedById) {
    const staged = await loadCassette(output, { worldDir: stagedWorldDir });
    assert(staged.report.legacy.length === 0 && staged.report.worldDrift.length === 0,
      `${id}: staging 出现 legacy/world drift`);
    const manifestEntries = staged.manifest.entries.length;
    assert(staged.entries.size === manifestEntries, `${id}: staging entry 数量变化`);
    for (const entry of staged.entries.values()) {
      assert(entry.request.canonicalBody === expectedCanonical.get(`${id}/${entry.request.stub}`),
        `${id}/${entry.request.stub}: staging canonical body 与重算值不一致`);
    }
  }

  const swap = await replaceWorldDirectory(worldDir, stagedWorldDir, { validate: (dir) => loadWorld(dir) });
  if (!swap.removed) console.error(`world 已替换，但旧目录清理失败：${swap.previous}`);

  const backups = [];
  try {
    for (const [id, output] of stagedById) {
      const target = path.join(fixtures, id, 'cassette');
      const backup = path.join(stagingBase, 'backup', id, 'cassette');
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(target, backup);
      await rename(output, target);
      backups.push({ target, backup });
    }
  } catch (error) {
    for (const { target, backup } of backups.reverse()) {
      await rm(target, { recursive: true, force: true });
      await rename(backup, target).catch(() => {});
    }
    throw error;
  }

  for (const id of cassetteIds) {
    const loaded = await loadCassette(path.join(fixtures, id, 'cassette'));
    assert(loaded.report.legacy.length === 0 && loaded.report.worldDrift.length === 0,
      `${id}: 最终 cassette 出现 legacy/world drift`);
  }

  console.log(JSON.stringify({
    command: 'reanchor-v5-single-exit',
    oneTimeMigration: 'v5 single exit -> replay world v2 block1 leaves',
    world: {
      generation: sealedWorld.generation,
      manifestUnchanged: true,
      leaves: stagedWorld.leaves.length,
      recipes: stagedWorld.recipes.length,
      changedLeaves,
    },
    cassettes: cassetteIds.length,
    seals: sealCount,
    stubs: stubCount,
    updatedStubs,
    unchangedStubs,
    responsesUnchanged: responseCount,
  }, null, 2));
} finally {
  if (!process.env.PERI_KEEP_REANCHOR) await rm(stagingBase, { recursive: true, force: true });
}
