import assert from "node:assert/strict";
import fs from "node:fs";

const hooks = new Map();
globalThis.Hooks = {
  once(name, fn) { hooks.set(`once:${name}`, fn); },
  on(name, fn) { hooks.set(`on:${name}`, fn); }
};

const settings = new Map([
  ["movementStyle", "trail"],
  ["copyFollowersWithLeader", true],
  ["snapToGrid", false],
  ["testCollisions", false],
  ["orientToMovement", false],
  ["stopOnManualMove", true],
  ["combatBehavior", "pause"],
  ["stopOnTeleport", false],
  ["teleportDistance", 60]
]);

globalThis.game = {
  settings: {get: (_scope, key) => settings.get(key)},
  i18n: {localize: key => key, format: (key, data) => `${key}:${JSON.stringify(data)}`},
  user: {id: "gm", isGM: true, targets: new Set()},
  users: [{id: "gm", isGM: true, active: true}],
  modules: new Map([["companion-follow", {}]]),
  scenes: [],
  keybindings: {register() {}},
  combat: null
};
globalThis.canvas = {scene: null, grid: {size: 100}, tokens: {controlled: [], hover: null}};
globalThis.ui = {notifications: {info() {}, warn() {}}};
globalThis.CONST = {KEYBINDING_PRECEDENCE: {NORMAL: 0}};
globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    randomID: (() => { let id = 0; return () => `marker-${++id}`; })(),
    getProperty(object, path) {
      return path.split(".").reduce((value, key) => value?.[key], object);
    },
    setProperty(object, path, value) {
      const keys = path.split(".");
      const last = keys.pop();
      const target = keys.reduce((current, key) => (current[key] ??= {}), object);
      target[last] = value;
      return true;
    }
  }
};

class SceneMock {
  constructor(id, gridSize = 100) {
    this.id = id;
    this.uuid = `Scene.${id}`;
    this.grid = {size: gridSize, distance: 5};
    this.width = 4000;
    this.height = 4000;
    this.tokens = [];
    this.lastUpdates = [];
  }

  async updateEmbeddedDocuments(_type, updates) {
    this.lastUpdates = structuredClone(updates);
    for (const update of updates) {
      const token = this.tokens.find(entry => entry.id === update._id);
      for (const [path, value] of Object.entries(update)) {
        if (path === "_id") continue;
        const keys = path.split(".");
        const deletionIndex = keys.findIndex(key => key.startsWith("-="));
        if (deletionIndex >= 0) {
          const parent = keys.slice(0, deletionIndex).reduce((current, key) => current?.[key], token);
          delete parent?.[keys[deletionIndex].slice(2)];
          continue;
        }
        const last = keys.pop();
        const parent = keys.reduce((current, key) => (current[key] ??= {}), token);
        parent[last] = structuredClone(value);
      }
    }
    return updates;
  }
}

class TokenMock {
  constructor(scene, id, x, y, link = null) {
    this.id = id;
    this._id = id;
    this.uuid = `Scene.${scene.id}.Token.${id}`;
    this.documentName = "Token";
    this.parent = scene;
    this.actorId = `actor-${id}`;
    this.name = id;
    this.x = x;
    this.y = y;
    this.width = 1;
    this.height = 1;
    this.rotation = 0;
    this.flags = {"companion-follow": {}};
    if (link) this.flags["companion-follow"].link = structuredClone(link);
    scene.tokens.push(this);
  }

  getFlag(scope, key) {
    return this.flags?.[scope]?.[key];
  }

  toObject() {
    return structuredClone({
      _id: this.id,
      name: this.name,
      actorId: this.actorId,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      rotation: this.rotation,
      flags: this.flags
    });
  }
}

const {__testing} = await import("../scripts/companion-follow.mjs");

assert.equal(hooks.has("on:getSceneControlButtons"), false, "the module does not add scene-control buttons");
assert.equal(hooks.has("on:renderTokenHUD"), false, "the module does not add Token HUD buttons");

function pasteToken(scene, data, index) {
  const token = new TokenMock(scene, `new-${index}`, data.x, data.y);
  token.actorId = data.actorId;
  token.flags = structuredClone(data.flags ?? {});
  return token;
}

{
  const source = new SceneMock("source", 100);
  const leader = new TokenMock(source, "leader", 100, 100);
  const follower = new TokenMock(source, "follower", 0, 100, {leaderUuid: leader.uuid, distance: 100});
  new TokenMock(source, "nested", 0, 200, {leaderUuid: follower.uuid, distance: 100});
  const destination = new SceneMock("destination", 100);
  globalThis.canvas.scene = destination;

  const createData = [{...leader.toObject(), x: 500, y: 500}];
  delete createData[0]._id;
  __testing.prepareFollowerPaste([{document: leader}], createData, {cut: false});

  assert.equal(createData.length, 3, "leader paste includes direct and nested followers");
  assert.deepEqual(
    createData.map(data => [data.x, data.y]),
    [[500, 500], [400, 500], [400, 600]],
    "copied followers preserve their formation relative to the pasted leader"
  );

  const pasted = createData.map((data, index) => pasteToken(destination, data, index));
  await __testing.resolveFollowerPaste(destination);
  const [newLeader, newFollower, newNested] = pasted;
  assert.equal(newFollower.getFlag("companion-follow", "link").leaderUuid, newLeader.uuid);
  assert.equal(newNested.getFlag("companion-follow", "link").leaderUuid, newFollower.uuid);
  assert.equal(newLeader.getFlag("companion-follow", "pasteNode"), undefined);
  assert.equal(newFollower.getFlag("companion-follow", "pasteParent"), undefined);
}

{
  const scene = new SceneMock("orphan-source", 100);
  const externalLeader = new TokenMock(scene, "external", 0, 0);
  const follower = new TokenMock(scene, "orphan", 100, 0, {leaderUuid: externalLeader.uuid, distance: 100});
  const destination = new SceneMock("orphan-destination", 100);
  globalThis.canvas.scene = destination;
  const createData = [{...follower.toObject(), x: 500, y: 500}];
  delete createData[0]._id;
  __testing.prepareFollowerPaste([{document: follower}], createData, {cut: false});
  const pasted = pasteToken(destination, createData[0], 0);
  await __testing.resolveFollowerPaste(destination);
  assert.equal(pasted.getFlag("companion-follow", "link"), undefined, "copying a follower alone does not retain a cross-scene leader reference");
}

{
  const scene = new SceneMock("cycle", 100);
  const first = new TokenMock(scene, "first", 0, 0);
  const second = new TokenMock(scene, "second", 100, 0, {leaderUuid: first.uuid, distance: 100});
  assert.equal(__testing.wouldCreateCycle(first, second), true, "reverse links which create a cycle are rejected");
  assert.equal(__testing.wouldCreateCycle(second, first), false, "an existing valid follower relationship is accepted");
}

{
  const scene = new SceneMock("movement", 100);
  const leader = new TokenMock(scene, "leader", 100, 100);
  const follower = new TokenMock(scene, "follower", 0, 100, {leaderUuid: leader.uuid, distance: 100});
  const target = __testing.movementTarget(leader, follower, follower.getFlag("companion-follow", "link"), {x: 100, y: 100}, {x: 200, y: 100});
  assert.deepEqual(target, {x: 100, y: 100}, "trail movement places the follower at the leader's previous position");
}

{
  const source = new SceneMock("scaled-source", 100);
  const leader = new TokenMock(source, "scaled-leader", 100, 100);
  new TokenMock(source, "scaled-follower", 0, 100, {leaderUuid: leader.uuid, distance: 100});
  const destination = new SceneMock("scaled-destination", 200);
  globalThis.canvas.scene = destination;

  const createData = [{...leader.toObject(), x: 500, y: 500}];
  delete createData[0]._id;
  __testing.prepareFollowerPaste([{document: leader}], createData, {cut: false});
  assert.deepEqual(
    createData.map(data => [data.x, data.y]),
    [[500, 500], [300, 500]],
    "cross-Scene copy scales follower offsets to the destination grid"
  );
}

{
  function paths(object, prefix = "") {
    return Object.entries(object).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return value && typeof value === "object" ? paths(value, path) : [path];
    });
  }

  const en = JSON.parse(fs.readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const ptBR = JSON.parse(fs.readFileSync(new URL("../lang/pt-BR.json", import.meta.url), "utf8"));
  const pt = JSON.parse(fs.readFileSync(new URL("../lang/pt.json", import.meta.url), "utf8"));
  assert.deepEqual(paths(ptBR).sort(), paths(en).sort(), "Brazilian Portuguese includes every English localization key");
  assert.deepEqual(paths(pt).sort(), paths(en).sort(), "Portuguese includes every English localization key");
}

console.log("Companion Follow tests passed");
