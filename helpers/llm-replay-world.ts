import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const storeModule = new URL("../llm-replay/world-store.mjs", import.meta.url).href;
const slotsModule = new URL("../llm-replay/world-slots.mjs", import.meta.url).href;
const cassetteModule = new URL("../llm-replay/cassette.mjs", import.meta.url).href;
const swapModule = new URL("../scripts/world-sync-swap.mjs", import.meta.url).href;

export interface RecordWorldSession {
  worldDir: string;
  stagingWorldDir: string;
  builder: any;
  slots: (field: any, rawText: string) => any;
  sealAndValidate(cassetteDir: string): Promise<{ entries: number; stubs: number; refStubs: number }>;
  commit(): Promise<{ replaced: boolean }>;
  close(): Promise<void>;
}

/** 全局 world 锁：同一 fixture root 的录制串行化，避免并发 builder 覆盖。 */
async function acquireWorldLock(fixtureRoot: string) {
  const lock = path.join(fixtureRoot, ".lock-world");
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readFile(path.join(lock, "owner.json"), "utf8").catch(() => "owner metadata unavailable");
    throw new Error(`recording world lock already exists; verify its owner before removing it: ${owner}`);
  }
  const token = randomUUID();
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({
    kind: "world", token, pid: process.pid, invocation: process.env.PERI_E2E_REPLAY_INVOCATION ?? null,
    startedAt: new Date().toISOString(), fixtureRoot,
  }, null, 2));
  return { lock, token };
}

async function releaseWorldLock(lock: string, token: string): Promise<void> {
  const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
  if (owner.token !== token) throw new Error("recording world lock ownership changed during this run");
  await rm(lock, { recursive: true, force: true });
}

/** 录制必须锚定已封存的共享 world；空 world 会让 block0 失去稳定语义。 */
export async function openRecordWorld(fixtureRoot: string): Promise<RecordWorldSession> {
  const store = await import(storeModule);
  const worldDir = path.join(fixtureRoot, "world");
  let world;
  try { world = await store.loadWorld(worldDir); }
  catch (error: any) {
    if (error?.code === "unsealed_world") {
      throw new Error(`recording requires the shared world at ${worldDir}; run e2e:replay:world-sync first`, { cause: error });
    }
    throw error;
  }
  const { lock, token } = await acquireWorldLock(fixtureRoot);
  let staging: string | undefined;
  try {
    const builder = store.createWorldBuilderFromWorld(world);
    const { slots } = await import(slotsModule).then((module) => module.createSlotResolver({ world: builder, builder }));
    staging = path.join(fixtureRoot, `.record-world-${randomUUID()}`);
    const session: RecordWorldSession = {
      worldDir,
      get stagingWorldDir() {
        if (!staging) throw new Error("recording world staging already consumed");
        return staging;
      },
      builder,
      slots,
      async sealAndValidate(cassetteDir: string) {
        if (!staging) throw new Error("recording world staging already consumed");
        await builder.seal(staging);
        const stagedWorld = await store.loadWorld(staging);
        const { loadCassette } = await import(cassetteModule);
        const cassette = await loadCassette(cassetteDir, { worldDir: staging });
        if (cassette.report.legacy.length) throw new Error(`recorded cassette contains legacy stubs: ${JSON.stringify(cassette.report.legacy)}`);
        if (cassette.report.worldDrift.length) throw new Error(`recorded cassette drifted from staging world: ${JSON.stringify(cassette.report.worldDrift)}`);
        const refs = await assertRecordedRefs(cassetteDir, stagedWorld);
        return { entries: cassette.entries.size, ...refs };
      },
      async commit() {
        if (!staging) throw new Error("recording world staging already consumed");
        const [stagedManifest, stagedSeal, currentManifest, currentSeal] = await Promise.all([
          readFile(path.join(staging, "manifest.json")), readFile(path.join(staging, "seal.json")),
          readFile(path.join(worldDir, "manifest.json")), readFile(path.join(worldDir, "seal.json")),
        ]);
        if (stagedManifest.equals(currentManifest) && stagedSeal.equals(currentSeal)) {
          await rm(staging, { recursive: true, force: true });
          staging = undefined;
          return { replaced: false };
        }
        const { replaceWorldDirectory } = await import(swapModule);
        await replaceWorldDirectory(worldDir, staging, { validate: (dir: string) => store.loadWorld(dir) });
        staging = undefined;
        return { replaced: true };
      },
      async close() {
        if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
        staging = undefined;
        await releaseWorldLock(lock, token);
      },
    };
    return session;
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    await releaseWorldLock(lock, token).catch(() => {});
    throw error;
  }
}

function collectRefs(world: any, parts: any[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.leaf !== undefined) out.push(part.leaf);
    else if (part.recipe !== undefined) out.push(...collectRefs(world, world.recipeParts(part.recipe) ?? []));
  }
  return out;
}

/**
 * 录制后的结构门禁：prompt 请求必须带 world ref，且 block0 必须落在稳定 leaf 上。
 * 新 literal stub 会让 prompt 变更再次扩散到全部请求文件，因此直接拒绝。
 */
export async function assertRecordedRefs(cassetteDir: string, world: any): Promise<{ stubs: number; refStubs: number }> {
  const requests = path.join(cassetteDir, "requests");
  const files = (await readdir(requests)).filter((file) => file.endsWith(".stub.json"));
  if (!files.length) throw new Error("recorded cassette has no request stubs");
  let refStubs = 0;
  for (const file of files) {
    const stub = JSON.parse(await readFile(path.join(requests, file), "utf8"));
    if (!Array.isArray(stub.parts) || !stub.parts.length) throw new Error(`${file}: recorded stub has no parts`);
    const hasRef = stub.parts.some((part: any) => part && typeof part === "object" && (part.leaf !== undefined || part.recipe !== undefined));
    const raw = hasRef ? world.renderParts(stub.parts) : Buffer.from(stub.parts.join(""), "utf8");
    let body: any;
    try { body = JSON.parse(raw.toString("utf8")); }
    catch { throw new Error(`${file}: recorded stub does not render to JSON`); }
    const prompts = body && typeof body === "object" && (body.system !== undefined || body.tools !== undefined);
    if (!prompts) continue;
    if (!hasRef) throw new Error(`${file}: recorded prompt stub is literal; record requires world + slots`);
    const refs = collectRefs(world, stub.parts);
    if (!refs.length) throw new Error(`${file}: recorded prompt stub has no world ref`);
    const first = Array.isArray(body.system) ? body.system[0]?.text : body.system;
    if (typeof first === "string") {
      const block0 = world.leafBytes("sys.block0.main");
      if (!block0) throw new Error(`${file}: world has no sys.block0.main`);
      if (first !== block0.toString("utf8")) throw new Error(`${file}: system[0] is not anchored to sys.block0.main`);
      if (!refs.includes("sys.block0.main")) throw new Error(`${file}: system[0] must reference sys.block0.main, not a content-addressed leaf`);
    }
    refStubs += 1;
  }
  return { stubs: files.length, refStubs };
}
