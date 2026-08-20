const MODULE_ID = "companion-follow";
const FLAG_SCOPE = MODULE_ID;
const FLAG_LINK = "link";
const FLAG_PASTE_NODE = "pasteNode";
const FLAG_PASTE_PARENT = "pasteParent";

const previousPositions = new Map();
const pasteResolutionTimers = new Map();
const movementQueues = new Map();

function localize(key) {
  return game.i18n.localize(`COMPANION_FOLLOW.${key}`);
}

function format(key, data) {
  return game.i18n.format(`COMPANION_FOLLOW.${key}`, data);
}

function moduleOption(options = {}) {
  return options?.[MODULE_ID] ?? options?.companionFollow;
}

function duplicate(value) {
  const clone = foundry?.utils?.deepClone ?? globalThis.duplicate;
  return clone ? clone(value) : JSON.parse(JSON.stringify(value));
}

function randomId() {
  return foundry?.utils?.randomID?.() ?? globalThis.randomID?.() ?? crypto.randomUUID();
}

function getProperty(object, path) {
  return foundry?.utils?.getProperty?.(object, path) ?? path.split(".").reduce((value, key) => value?.[key], object);
}

function setProperty(object, path, value) {
  if (foundry?.utils?.setProperty) return foundry.utils.setProperty(object, path, value);
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((value, key) => (value[key] ??= {}), object);
  target[last] = value;
  return true;
}

function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

function sceneGridSize(scene) {
  return Number(scene?.grid?.size) || Number(globalThis.canvas?.grid?.size) || 100;
}

function tokenCenter(document, position = document) {
  const gridSize = sceneGridSize(document.parent);
  const width = Number(document.width ?? 1) * gridSize;
  const height = Number(document.height ?? 1) * gridSize;
  return {
    x: Number(position.x ?? document.x ?? 0) + width / 2,
    y: Number(position.y ?? document.y ?? 0) + height / 2
  };
}

function sourcePosition(document) {
  return {
    x: Number(document.x ?? 0),
    y: Number(document.y ?? 0),
    rotation: Number(document.rotation ?? 0)
  };
}

function tokenUuid(document) {
  return document?.uuid ?? `Scene.${document?.parent?.id}.Token.${document?.id}`;
}

function tokenLink(document) {
  return duplicate(document?.getFlag?.(FLAG_SCOPE, FLAG_LINK) ?? document?.flags?.[FLAG_SCOPE]?.[FLAG_LINK] ?? null);
}

function canManage(document) {
  return game.user.isGM || document?.isOwner;
}

function primaryActiveGM() {
  return game.users?.find(user => user.active && user.isGM) ?? null;
}

function isResponsible(userId, documents = []) {
  const gm = primaryActiveGM();
  if (gm) return gm.id === game.user.id;
  if (userId !== game.user.id) return false;
  return documents.every(document => canManage(document));
}

function sceneTokens(scene) {
  return Array.from(scene?.tokens ?? []);
}

function followersOf(leader, scene = leader?.parent) {
  const uuid = tokenUuid(leader);
  return sceneTokens(scene).filter(token => tokenLink(token)?.leaderUuid === uuid);
}

function wouldCreateCycle(follower, leader) {
  const scene = leader?.parent;
  const followerUuid = tokenUuid(follower);
  const visited = new Set();
  let current = leader;
  while (current) {
    const uuid = tokenUuid(current);
    if (uuid === followerUuid) return true;
    if (visited.has(uuid)) return true;
    visited.add(uuid);
    const parentUuid = tokenLink(current)?.leaderUuid;
    if (!parentUuid) return false;
    current = sceneTokens(scene).find(token => tokenUuid(token) === parentUuid);
  }
  return false;
}

function notifyInvalidSelection() {
  ui.notifications.warn(localize("Notifications.SelectFollowersAndLeader"));
}

async function establishFollow(followers, leader) {
  followers = followers.filter(token => token && token.id !== leader?.id && token.parent?.id === leader?.parent?.id);
  if (!leader || !followers.length) return notifyInvalidSelection();
  if (followers.some(token => !canManage(token))) {
    return ui.notifications.warn(localize("Notifications.NoPermission"));
  }

  const validFollowers = followers.filter(follower => !wouldCreateCycle(follower, leader));
  if (validFollowers.length !== followers.length) ui.notifications.warn(localize("Notifications.CycleSkipped"));
  followers = validFollowers;
  if (!followers.length) return;

  const leaderCenter = tokenCenter(leader);
  const updates = followers.map(follower => {
    const center = tokenCenter(follower);
    const distance = Math.max(0, Math.hypot(center.x - leaderCenter.x, center.y - leaderCenter.y));
    return {
      _id: follower.id,
      [`flags.${FLAG_SCOPE}.${FLAG_LINK}`]: {
        leaderUuid: tokenUuid(leader),
        leaderActorId: leader.actorId ?? null,
        distance,
        offsetX: Number(follower.x) - Number(leader.x),
        offsetY: Number(follower.y) - Number(leader.y),
        createdAt: Date.now()
      }
    };
  });

  await leader.parent.updateEmbeddedDocuments("Token", updates, {[MODULE_ID]: true});
  ui.notifications.info(format("Notifications.NowFollowing", {
    count: followers.length,
    leader: leader.name
  }));
}

async function stopFollowing(tokens, {quiet = false} = {}) {
  const byScene = new Map();
  for (const token of tokens.filter(Boolean)) {
    if (!tokenLink(token) || !canManage(token)) continue;
    const entries = byScene.get(token.parent.id) ?? {scene: token.parent, updates: []};
    entries.updates.push({_id: token.id, [`flags.${FLAG_SCOPE}.-=${FLAG_LINK}`]: null});
    byScene.set(token.parent.id, entries);
  }

  let count = 0;
  for (const {scene, updates} of byScene.values()) {
    await scene.updateEmbeddedDocuments("Token", updates, {[MODULE_ID]: true});
    count += updates.length;
  }
  if (!quiet && count) ui.notifications.info(format("Notifications.StoppedFollowing", {count}));
  return count;
}

function currentLeader() {
  return canvas?.tokens?.hover ?? Array.from(game.user.targets ?? [])[0] ?? null;
}

async function followFromCanvas() {
  const leaderObject = currentLeader();
  const leader = leaderObject?.document;
  const followers = (canvas?.tokens?.controlled ?? [])
    .filter(token => token.id !== leaderObject?.id)
    .map(token => token.document);
  return establishFollow(followers, leader);
}

async function stopFromCanvas() {
  const selected = (canvas?.tokens?.controlled ?? []).map(token => token.document);
  if (!selected.length) return notifyInvalidSelection();
  return stopFollowing(selected);
}

function snapPosition(position, gridSize) {
  if (!setting("snapToGrid")) return position;
  return {
    x: Math.round(position.x / gridSize) * gridSize,
    y: Math.round(position.y / gridSize) * gridSize
  };
}

function withinScene(scene, token, position) {
  const gridSize = sceneGridSize(scene);
  const tokenWidth = Number(token.width ?? 1) * gridSize;
  const tokenHeight = Number(token.height ?? 1) * gridSize;
  return {
    x: Math.max(0, Math.min(Number(scene.width ?? Infinity) - tokenWidth, position.x)),
    y: Math.max(0, Math.min(Number(scene.height ?? Infinity) - tokenHeight, position.y))
  };
}

function collisionAt(follower, position) {
  if (!setting("testCollisions")) return false;
  if (follower.parent?.id !== canvas?.scene?.id || !follower.object) return false;
  const destination = tokenCenter(follower, position);
  try {
    return Boolean(follower.object.checkCollision(destination, {type: "move", mode: "any"}));
  } catch (error) {
    console.debug(`${MODULE_ID} | Collision test unavailable`, error);
    return false;
  }
}

function movementTarget(leader, follower, link, previous, current) {
  const gridSize = sceneGridSize(leader.parent);
  const dx = current.x - previous.x;
  const dy = current.y - previous.y;

  if (setting("movementStyle") === "formation") {
    return {x: Number(follower.x) + dx, y: Number(follower.y) + dy};
  }

  const length = Math.hypot(dx, dy);
  if (!length) return {x: follower.x, y: follower.y};
  const leaderCenter = tokenCenter(leader, current);
  const followerCenter = tokenCenter(follower);
  const distance = Number(link.distance || gridSize);
  return {
    x: leaderCenter.x - (dx / length) * distance - (followerCenter.x - Number(follower.x)),
    y: leaderCenter.y - (dy / length) * distance - (followerCenter.y - Number(follower.y))
  };
}

async function moveFollowers(leader, changes, options, userId, capturedPrevious) {
  if (moduleOption(options) || !("x" in changes || "y" in changes)) return;
  const directFollowers = followersOf(leader);
  if (!directFollowers.length || !isResponsible(userId, directFollowers)) return;

  const previous = capturedPrevious ?? sourcePosition(leader);
  const current = {
    x: Number(changes.x ?? leader.x),
    y: Number(changes.y ?? leader.y)
  };
  const distancePixels = Math.hypot(current.x - previous.x, current.y - previous.y);
  const gridSize = sceneGridSize(leader.parent);
  const sceneDistance = distancePixels / gridSize * Number(leader.parent?.grid?.distance ?? 1);

  if (setting("stopOnTeleport") && sceneDistance >= Number(setting("teleportDistance"))) {
    await stopFollowing(directFollowers, {quiet: true});
    if (game.user.isGM) ui.notifications.info(localize("Notifications.TeleportDetached"));
    return;
  }

  if (game.combat?.started && setting("combatBehavior") === "pause") return;
  if (game.combat?.started && setting("combatBehavior") === "detach") {
    await stopFollowing(directFollowers, {quiet: true});
    return;
  }

  const updates = [];
  const visited = new Set([tokenUuid(leader)]);
  const queue = [{leader, previous, current}];
  for (const movement of queue) {
    for (const follower of followersOf(movement.leader)) {
      const followerUuid = tokenUuid(follower);
      if (visited.has(followerUuid)) continue;
      visited.add(followerUuid);

      const link = tokenLink(follower);
      let target = movementTarget(movement.leader, follower, link, movement.previous, movement.current);
      target = snapPosition(target, gridSize);
      target = withinScene(leader.parent, follower, target);
      if (collisionAt(follower, target)) continue;

      const update = {_id: follower.id, x: target.x, y: target.y};
      if (setting("orientToMovement")) {
        const dx = target.x - Number(follower.x);
        const dy = target.y - Number(follower.y);
        if (dx || dy) update.rotation = (Math.atan2(dy, dx) * 180 / Math.PI) + 90;
      }
      updates.push(update);
      queue.push({
        leader: follower,
        previous: sourcePosition(follower),
        current: {x: target.x, y: target.y}
      });
    }
  }

  if (updates.length) {
    await leader.parent.updateEmbeddedDocuments("Token", updates, {
      animate: true,
      companionFollow: true,
      [MODULE_ID]: true
    });
  }
}

async function detachManuallyMovedFollower(token, changes, options, userId) {
  if (moduleOption(options) || !("x" in changes || "y" in changes)) return;
  if (!setting("stopOnManualMove") || !tokenLink(token) || !isResponsible(userId, [token])) return;
  await stopFollowing([token], {quiet: true});
  ui.notifications.info(format("Notifications.ManualDetached", {name: token.name}));
}

function setPasteFlag(data, key, value) {
  setProperty(data, `flags.${FLAG_SCOPE}.${key}`, value);
}

function clearCopiedLink(data) {
  const flags = duplicate(getProperty(data, `flags.${FLAG_SCOPE}`) ?? {});
  delete flags[FLAG_LINK];
  setProperty(data, `flags.${FLAG_SCOPE}`, flags);
}

function collectFollowerTree(scene, roots) {
  const all = sceneTokens(scene);
  const selected = new Map(roots.map(entry => [tokenUuid(entry.source), entry]));
  const queue = [...roots];
  for (const entry of queue) {
    for (const follower of all) {
      if (selected.has(tokenUuid(follower))) continue;
      if (tokenLink(follower)?.leaderUuid !== tokenUuid(entry.source)) continue;
      if (!canManage(follower)) continue;
      const child = {source: follower, data: null, root: entry.root ?? entry};
      selected.set(tokenUuid(follower), child);
      queue.push(child);
    }
  }
  return queue;
}

function prepareFollowerPaste(copiedObjects, createData, options = {}) {
  if (!setting("copyFollowersWithLeader") || options.cut || !Array.isArray(createData)) return;
  const copied = Array.from(copiedObjects ?? []).filter(object => object?.document?.documentName === "Token" || object?.documentName === "Token");
  if (!copied.length) return;

  const roots = copied.map((object, index) => ({
    source: object.document ?? object,
    data: createData[index],
    root: null
  })).filter(entry => entry.source && entry.data);
  if (!roots.length) return;

  const sourceScene = roots[0].source.parent;
  const transfer = collectFollowerTree(sourceScene, roots);
  if (
    transfer.length === roots.length &&
    !roots.some(entry => followersOf(entry.source).length) &&
    !roots.some(entry => tokenLink(entry.source))
  ) return;

  const markerByUuid = new Map(transfer.map(entry => [tokenUuid(entry.source), randomId()]));
  const rootSourceSet = new Set(roots.map(entry => tokenUuid(entry.source)));

  function findRoot(entry) {
    if (rootSourceSet.has(tokenUuid(entry.source))) return entry;
    let current = entry;
    const visited = new Set();
    while (current) {
      const uuid = tokenUuid(current.source);
      if (visited.has(uuid)) return roots[0];
      visited.add(uuid);
      const parentUuid = tokenLink(current.source)?.leaderUuid;
      const parent = transfer.find(candidate => tokenUuid(candidate.source) === parentUuid);
      if (!parent || rootSourceSet.has(tokenUuid(parent.source))) return parent ?? roots[0];
      current = parent;
    }
    return roots[0];
  }

  for (const entry of transfer) {
    if (!entry.data) {
      entry.data = entry.source.toObject();
      delete entry.data._id;
      const root = findRoot(entry);
      const rootData = root.data;
      const sourceGrid = sceneGridSize(sourceScene);
      const destinationGrid = sceneGridSize(canvas.scene);
      const scale = destinationGrid / sourceGrid;
      const requestedPosition = {
        x: Number(rootData.x) + (Number(entry.source.x) - Number(root.source.x)) * scale,
        y: Number(rootData.y) + (Number(entry.source.y) - Number(root.source.y)) * scale
      };
      const safePosition = withinScene(canvas.scene, entry.source, requestedPosition);
      entry.data.x = safePosition.x;
      entry.data.y = safePosition.y;
      createData.push(entry.data);
    }

    const sourceUuid = tokenUuid(entry.source);
    setPasteFlag(entry.data, FLAG_PASTE_NODE, markerByUuid.get(sourceUuid));
    const link = tokenLink(entry.source);
    if (link?.leaderUuid && markerByUuid.has(link.leaderUuid)) {
      setPasteFlag(entry.data, FLAG_PASTE_PARENT, markerByUuid.get(link.leaderUuid));
      clearCopiedLink(entry.data);
    } else if (link) {
      clearCopiedLink(entry.data);
    }
  }

  if (transfer.length > roots.length) {
    ui.notifications.info(format("Notifications.CopyPrepared", {count: transfer.length - roots.length}));
  }
}

function schedulePasteResolution(scene) {
  clearTimeout(pasteResolutionTimers.get(scene.id));
  pasteResolutionTimers.set(scene.id, setTimeout(() => resolveFollowerPaste(scene), 100));
}

async function resolveFollowerPaste(scene) {
  pasteResolutionTimers.delete(scene.id);
  const tokens = sceneTokens(scene);
  const byMarker = new Map();
  for (const token of tokens) {
    const marker = token.getFlag(FLAG_SCOPE, FLAG_PASTE_NODE);
    if (marker) byMarker.set(marker, token);
  }

  const updates = [];
  let linked = 0;
  for (const token of tokens) {
    const parentMarker = token.getFlag(FLAG_SCOPE, FLAG_PASTE_PARENT);
    const ownMarker = token.getFlag(FLAG_SCOPE, FLAG_PASTE_NODE);
    if (!ownMarker && !parentMarker) continue;

    const update = {
      _id: token.id,
      [`flags.${FLAG_SCOPE}.-=${FLAG_PASTE_NODE}`]: null
    };
    if (parentMarker) update[`flags.${FLAG_SCOPE}.-=${FLAG_PASTE_PARENT}`] = null;
    if (parentMarker) {
      const leader = byMarker.get(parentMarker);
      if (leader) {
        const tokenCenterPoint = tokenCenter(token);
        const leaderCenterPoint = tokenCenter(leader);
        update[`flags.${FLAG_SCOPE}.${FLAG_LINK}`] = {
          leaderUuid: tokenUuid(leader),
          leaderActorId: leader.actorId ?? null,
          distance: Math.hypot(tokenCenterPoint.x - leaderCenterPoint.x, tokenCenterPoint.y - leaderCenterPoint.y),
          offsetX: Number(token.x) - Number(leader.x),
          offsetY: Number(token.y) - Number(leader.y),
          createdAt: Date.now()
        };
        linked += 1;
      }
    }
    updates.push(update);
  }

  if (updates.length) await scene.updateEmbeddedDocuments("Token", updates, {[MODULE_ID]: true});
  if (linked) ui.notifications.info(format("Notifications.CopyComplete", {count: linked}));
}

function registerSettings() {
  game.settings.register(MODULE_ID, "movementStyle", {
    name: "COMPANION_FOLLOW.Settings.MovementStyle.Name",
    hint: "COMPANION_FOLLOW.Settings.MovementStyle.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      trail: "COMPANION_FOLLOW.Settings.MovementStyle.Trail",
      formation: "COMPANION_FOLLOW.Settings.MovementStyle.Formation"
    },
    default: "trail"
  });
  game.settings.register(MODULE_ID, "copyFollowersWithLeader", {
    name: "COMPANION_FOLLOW.Settings.CopyFollowers.Name",
    hint: "COMPANION_FOLLOW.Settings.CopyFollowers.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "snapToGrid", {
    name: "COMPANION_FOLLOW.Settings.Snap.Name",
    hint: "COMPANION_FOLLOW.Settings.Snap.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "testCollisions", {
    name: "COMPANION_FOLLOW.Settings.Collisions.Name",
    hint: "COMPANION_FOLLOW.Settings.Collisions.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "orientToMovement", {
    name: "COMPANION_FOLLOW.Settings.Orient.Name",
    hint: "COMPANION_FOLLOW.Settings.Orient.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "stopOnManualMove", {
    name: "COMPANION_FOLLOW.Settings.ManualMove.Name",
    hint: "COMPANION_FOLLOW.Settings.ManualMove.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, "combatBehavior", {
    name: "COMPANION_FOLLOW.Settings.Combat.Name",
    hint: "COMPANION_FOLLOW.Settings.Combat.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      pause: "COMPANION_FOLLOW.Settings.Combat.Pause",
      detach: "COMPANION_FOLLOW.Settings.Combat.Detach",
      continue: "COMPANION_FOLLOW.Settings.Combat.Continue"
    },
    default: "pause"
  });
  game.settings.register(MODULE_ID, "stopOnTeleport", {
    name: "COMPANION_FOLLOW.Settings.Teleport.Name",
    hint: "COMPANION_FOLLOW.Settings.Teleport.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });
  game.settings.register(MODULE_ID, "teleportDistance", {
    name: "COMPANION_FOLLOW.Settings.TeleportDistance.Name",
    hint: "COMPANION_FOLLOW.Settings.TeleportDistance.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 60,
    range: {min: 1, max: 1000, step: 1}
  });
}

function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "follow", {
    name: "COMPANION_FOLLOW.Keybindings.Follow.Name",
    hint: "COMPANION_FOLLOW.Keybindings.Follow.Hint",
    editable: [{key: "KeyF"}],
    onDown: () => {
      followFromCanvas();
      return true;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
  game.keybindings.register(MODULE_ID, "stop", {
    name: "COMPANION_FOLLOW.Keybindings.Stop.Name",
    hint: "COMPANION_FOLLOW.Keybindings.Stop.Hint",
    editable: [{key: "KeyF", modifiers: ["Shift"]}],
    onDown: () => {
      stopFromCanvas();
      return true;
    },
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
  });
}

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();
});

Hooks.once("ready", () => {
  game.modules.get(MODULE_ID).api = {
    follow: establishFollow,
    stop: stopFollowing,
    followersOf
  };
});

Hooks.on("preUpdateToken", (token, changes, options) => {
  if (moduleOption(options) || !("x" in changes || "y" in changes)) return;
  previousPositions.set(tokenUuid(token), sourcePosition(token));
});

Hooks.on("updateToken", async (token, changes, options, userId) => {
  const uuid = tokenUuid(token);
  const previous = previousPositions.get(uuid) ?? sourcePosition(token);
  previousPositions.delete(uuid);
  const prior = movementQueues.get(uuid) ?? Promise.resolve();
  const queued = prior.then(async () => {
    await detachManuallyMovedFollower(token, changes, options, userId);
    await moveFollowers(token, changes, options, userId, previous);
  }).catch(error => {
    console.error(`${MODULE_ID} | Failed to process token movement`, error);
  }).finally(() => {
    if (movementQueues.get(uuid) === queued) movementQueues.delete(uuid);
  });
  movementQueues.set(uuid, queued);
});

Hooks.on("combatStart", async () => {
  if (setting("combatBehavior") !== "detach" || primaryActiveGM()?.id !== game.user.id) return;
  const followers = Array.from(game.scenes).flatMap(scene => sceneTokens(scene).filter(token => tokenLink(token)));
  await stopFollowing(followers, {quiet: true});
});

Hooks.on("deleteToken", async (token, options, userId) => {
  const followers = followersOf(token, token.parent);
  if (!followers.length || moduleOption(options) || !isResponsible(userId, followers)) return;
  await stopFollowing(followers, {quiet: true});
});

Hooks.on("pasteToken", prepareFollowerPaste);
Hooks.on("createToken", (token, options, userId) => {
  if (!isResponsible(userId, [token])) return;
  if (token.getFlag(FLAG_SCOPE, FLAG_PASTE_NODE) || token.getFlag(FLAG_SCOPE, FLAG_PASTE_PARENT)) {
    schedulePasteResolution(token.parent);
  }
});

export const __testing = {
  collectFollowerTree,
  movementTarget,
  prepareFollowerPaste,
  resolveFollowerPaste,
  tokenLink,
  tokenUuid,
  wouldCreateCycle
};
