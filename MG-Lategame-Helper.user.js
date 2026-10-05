// ==UserScript==
// @name         MG Lategame Helper
// @namespace    mg-pet-culler
// @version      0.15.42
// @homepageURL  https://github.com/godgamerover9k/MG-late-game-helper
// @updateURL    https://raw.githubusercontent.com/godgamerover9k/MG-late-game-helper/main/MG-Lategame-Helper.user.js
// @downloadURL  https://raw.githubusercontent.com/godgamerover9k/MG-late-game-helper/main/MG-Lategame-Helper.user.js
// @description  Magic Garden QoL: lists pets outclassed under your own rules and sells the ones you confirm; best pet teams (hatching, selling, levelling) with one-click swap-in; journal tab with logging and an egg plan; shop overview with a confirmed buy-everything button (skips buildings, one-time and Magic Dust items). Works alongside QPM and Arie's Mod.
// @match        https://magicgarden.gg/*
// @match        https://*.magicgarden.gg/*
// @match        https://magiccircle.gg/*
// @match        https://*.magiccircle.gg/*
// @match        https://starweaver.org/*
// @match        https://*.starweaver.org/*
// @match        https://1227719606223765687.discordsays.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
//
// Credits
//  - QPM by TOKYO.#6464 (https://github.com/mg-tokyo/QPM-GR): command envelope and numbering, pet swap/storage/shop
//    command shapes, inventory stack ids, Magic Dust formula, XP rates, and the pity tracker this mod reads (if installed).
//  - Arie's Mod / Ariedam64 (https://github.com/Ariedam64): live game data and sprites from mg-api.ariedam.fr,
//    ability badge colours, the PurchaseShopItem viewMode fix (mg-afk-android) and the LogItem target format
//    (MG-Websocket-Helper).
//  - Everything else (the pet rules, teams, planner and UI) is this mod's own.

(function () {
'use strict';
const TEST_BUILD = false; // true only in the automated-test build: lets scripted clicks through
const MOD_VERSION = '0.15.42';
// ---------------------------------------------------------------------------
// Core: storage, command channel (socket hook), live game state
// ---------------------------------------------------------------------------
const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
if (W.__mgPetCuller) return;
W.__mgPetCuller = true;
const LOG = (...a) => console.log('%c[Lategame Helper]', 'color:#5bbf73;font-weight:bold', ...a);

// ---- storage (Tampermonkey storage, falls back to localStorage) ----
const store = {
  get(key, fallback) {
    try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback); } catch {}
    try { const v = W.localStorage.getItem('mgpc.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { if (typeof GM_setValue === 'function') return GM_setValue(key, value); } catch {}
    try { W.localStorage.setItem('mgpc.' + key, JSON.stringify(value)); } catch {}
  },
};

// ---- command channel ----
// The server numbers gameplay commands per connection and only accepts "last executed + 1".
// The game, QPM and Arie's Mod may all send commands on the same socket, so this mod:
// (envelope and result format as documented in QPM's websocket/envelope.ts)
//  - seeds its counter from every Welcome (executedCommandSequence),
//  - sends its own commands through the game's own send path (rc.trySendMessageNow). If QPM is
//    installed it wraps that path, so QPM numbers our commands together with the game's,
//  - watches each socket's own `send` (after QPM, before Arie's Mod, which hooks the shared
//    prototype). Every command goes out as max(its own number, next free number), so nothing is
//    ever sent with a duplicate number. With nothing injected that is a no-op (vanilla bytes), and
//    Arie's Mod always sees the final numbers, so its counter stays in step.
// Selling is refused at this level unless the pet was confirmed by you (see authorizeSell).
const net = (() => {
  const NativeWS = W.WebSocket;
  let next = 1;
  let seeded = false;
  let socket = null;
  let desync = false;
  // Keeping the counter right. The server answers a number that's too HIGH with invalid_sequence, and silently ignores
  // one that's too LOW (so that can only end in a timeout). So the counter is never pulled down on a guess:
  //  - every answered command tells us its number worked: the counter never sits at or below a number that worked;
  //  - after invalid_sequence, the same command is retried one number lower at a time until it's accepted. Too-high
  //    tries are just answered again, and it never goes below a number known to have worked.
  //  - after a timeout (no answer, outcome unknown) sending stops, until a later command is answered fine.
  let frontier = 0, lastOk = 0, desyncAt = 0;
  let lastPosition = null; // where the game last said the player stands
  const sentNum = new Map(); // requestId -> number it went out with (kept for the last 500 commands)
  const pending = new Map();
  const sellAllowed = new Map(); // itemId -> expiry time, set only by a confirmed sale
  const sentListeners = new Set(); // told about every command sent on the socket (read-only: used for warnings)
  const ownRequests = new Set();
  // Recent traffic, for diagnosing stuck commands: in the F12 console run  copy(__mglhNet())  and paste it to the author
  const trace = [];
  const note = (e) => { trace.push({ t: Date.now() % 1e7, ...e }); if (trace.length > 400) trace.shift(); };
  try { W.__mglhNet = () => JSON.stringify({ next, frontier, lastOk, desync, desyncAt, seeded, others: (() => { try { return others(); } catch { return []; } })(), trace }); } catch {}

  const onMessage = (ev) => {
    const raw = ev.data;
    if (typeof raw !== 'string') return;
    const ex = /"executedCommandSequence"\s*:\s*(\d+)/.exec(raw);
    if (ex) { if (Number(ex[1]) > frontier) note({ ev: 'frame', exec: Number(ex[1]) }); frontier = Math.max(frontier, Number(ex[1])); if (desync && frontier >= desyncAt) desync = false; } // the server got past the unanswered one
    if (raw.indexOf('"Welcome"') === -1 && raw.indexOf('QuinoaCommandResult') === -1) return;
    let j;
    try { j = JSON.parse(raw); } catch { return; }
    if (j?.type === 'Welcome') {
      const executed = Number(j.executedCommandSequence);
      if (Number.isFinite(executed) && executed >= 0) { next = executed + 1; frontier = executed; lastOk = executed; seeded = true; desync = false; socket = ev.target; }
    } else if (j?.type === 'QuinoaCommandResult') {
      // Any answer other than a number complaint means that number was taken in order
      const n = sentNum.get(j.requestId);
      note({ ev: 'result', n, ok: !!j.ok, code: j.code ?? null, mine: pending.has(j.requestId) });
      if (n && j.code !== 'invalid_sequence') {
        lastOk = Math.max(lastOk, n);
        if (next <= n) next = n + 1;
        if (desync && n >= desyncAt) desync = false; // numbers are working again (or the unanswered one was answered late)
      }
      const p = pending.get(j.requestId);
      if (p) { pending.delete(j.requestId); clearTimeout(p.timer); p.resolve({ ok: !!j.ok, code: j.code ?? null, num: n }); }
    }
  };

  // Runs for every message this socket sends, whoever sent it (game, QPM, Arie's Mod, us).
  const instanceSend = function (data, ...rest) {
    try {
      // The game's own position updates: remembered for the keep-awake ping (it resends the same spot)
      if (typeof data === 'string' && data.indexOf('"PlayerPosition"') !== -1) {
        try { const m = JSON.parse(data); if (m?.type === 'PlayerPosition' && m.position && Number.isFinite(m.position.x)) { lastPosition = { x: m.position.x, y: m.position.y }; socket = this; } } catch {}
      }
      if (typeof data === 'string' && data.indexOf('"QuinoaCommand"') !== -1) {
        const env = JSON.parse(data);
        if (env?.type === 'QuinoaCommand' && env.command) {
          socket = this;
          const ours = ownRequests.delete(env.requestId);
          sentListeners.forEach((f) => { try { f(env.command, ours); } catch {} });
          const num = Number(env.commandSequence);
          if (!seeded) {
            if (Number.isFinite(num) && num >= next) next = num + 1;
          } else {
            // Always the next number in line: every send on this socket passes through here, so `next` is exact. Taking
            // the game's own number when it's higher would leave a gap whenever a command it numbered was never sent
            // (a hatch held back by the hatch check), and the server refuses everything after a gap (invalid_sequence).
            // Never at or below a number the server has already executed (it ignores those in silence: a timeout). That
            // happens if a command reached the server without passing through here.
            const final = Math.max(next, frontier + 1);
            if (final !== num) { env.commandSequence = final; data = JSON.stringify(env); }
            next = final + 1;
          }
          sentNum.set(env.requestId, Number(env.commandSequence));
          note({ ev: 'send', n: Number(env.commandSequence), was: num, type: env.command.type, ours, ...(/Storage/.test(env.command.type) ? { cmd: env.command } : {}) });
          if (sentNum.size > 500) sentNum.delete(sentNum.keys().next().value);
        }
      }
    } catch {}
    return NativeWS.prototype.send.call(this, data, ...rest); // current shared send, so Arie's Mod's hook still runs
  };

  const attach = (ws) => {
    if (!ws || ws.__mgpc) return;
    ws.__mgpc = true;
    try { Object.defineProperty(ws, 'send', { value: instanceSend, writable: true, configurable: true }); } catch {}
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', () => { if (socket === ws) { socket = null; seeded = false; } });
  };

  W.WebSocket = new Proxy(NativeWS, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      try { attach(ws); } catch {}
      return ws;
    },
  });

  const others = () => {
    const found = [];
    const rc = W.MagicCircle_RoomConnection;
    // our own hatch guard is an own property too: it only counts if it was wrapped over someone else's
    const own = (k) => rc && Object.prototype.hasOwnProperty.call(rc, k) && (!rc[k]?.__mgpcGuard || rc[k].__mgpcHadOwn);
    if (W.QPM || W.QPM_DEBUG_API || own('trySendMessageNow') || own('sendMessage')) found.push('QPM');
    if (NativeWS.prototype.__qwsSendPatched || W.inGameHotkeys) found.push("Arie's Mod");
    return found;
  };

  // strict (selling): an unanswered command blocks everything until a later one is answered. Otherwise the next
  // command you press goes out and serves as the check: answered = numbering fine; invalid_sequence = it steps down.
  const readiness = (strict = false) => {
    if (desync && strict) return { ok: false, reason: "A command got no answer from the game. Move or do anything in the game (so a command goes through), then try again; if it keeps happening, reload the page." };
    if (!seeded) return { ok: false, reason: 'The mod started after the game connected. Reload the page once so it can sync, then selling works.' };
    if (!socket || socket.readyState !== 1 || socket.send !== instanceSend) return { ok: false, reason: 'Not connected to the game right now (or the connection is not one this mod can watch). Reload the page.' };
    const rc = W.MagicCircle_RoomConnection;
    if (!rc) return { ok: false, reason: 'The game connection is not ready yet.' };
    if (rc.isCommandSessionReady === false) return { ok: false, reason: 'The game is still connecting.' };
    return { ok: true };
  };

  const uuid = () => {
    try { if (W.crypto?.randomUUID) return W.crypto.randomUUID(); } catch {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16); });
  };

  // Only the confirm dialog calls this, with the exact ids you confirmed. Each id can be sold once, within 10 minutes.
  const authorizeSell = (ids) => { const until = Date.now() + 10 * 60 * 1000; ids.forEach((id) => sellAllowed.set(id, until)); };
  const revokeSell = () => sellAllowed.clear();

  // Sends one gameplay command and resolves with the server's verdict ({ok, code}). If the server refuses it only for
  // its number (invalid_sequence: the counter had got ahead), wait for the line to go quiet, resync, and try once more.
  const send = async (command, timeoutMs = 6000) => {
    for (let r = resyncing; r; r = resyncing) await r; // wait out a correction in progress
    let r = await sendOnce(command, timeoutMs);
    // Ignored by the server for an old number (nothing happened): send it once more, numbered past the server's count
    if (r.code === 'timeout' && r.stale) r = await sendOnce(command, timeoutMs, true);
    if (r.code !== 'invalid_sequence' || !r.num) return r;
    // Our number was too high. One fix at a time, with every other send waiting: let what's in flight come back
    // (their answers move the counter), then step this command down one number at a time, never below a number known
    // to have worked. Commands that were waiting then go out with the corrected counter.
    for (let r = resyncing; r; r = resyncing) await r; // wait out a correction in progress
    let done;
    resyncing = new Promise((res) => { done = res; });
    try {
      const until = Date.now() + 5000;
      while (pending.size && Date.now() < until) await new Promise((res) => setTimeout(res, 50));
      // If the counter was already corrected meanwhile (another command's fix), the current number is the one to try
      let n = Math.min(next, r.num - 1);
      for (let tries = 0; tries < 12 && n > Math.max(lastOk, frontier); tries++) {
        next = n;
        r = await sendOnce(command, timeoutMs, true);
        if (r.code !== 'invalid_sequence') break;
        n = (r.num ?? n) - 1;
      }
    } finally { resyncing = null; done(); }
    return r;
  };
  let resyncing = null;
  const sendOnce = (command, timeoutMs, retry = false) => {
    // Credits are the game's paid currency (spent only through …WithCredits commands): this mod never sends those
    if (/credit/i.test(String(command?.type))) return Promise.resolve({ ok: false, code: 'credits_blocked' });
    if (command?.type === 'SellPet') {
      const until = sellAllowed.get(command.itemId);
      if (!retry) {
        if (!until || until < Date.now()) return Promise.resolve({ ok: false, code: 'not_confirmed' });
        sellAllowed.delete(command.itemId); // single use (a retry of the same confirmed sale after invalid_sequence is allowed)
      }
    }
    const ready = readiness(command?.type === 'SellPet');
    if (!ready.ok) return Promise.resolve({ ok: false, code: 'not_ready', reason: ready.reason });
    const rc = W.MagicCircle_RoomConnection;
    const requestId = uuid();
    const env = { scopePath: ['Room', 'Quinoa'], type: 'QuinoaCommand', requestId, commandSequence: next, command };
    ownRequests.add(requestId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        const num = sentNum.get(requestId);
        // At or below what the server has executed: it was a stale number, ignored by the server (nothing happened).
        // Otherwise the outcome is unknown: selling waits until a later command is answered.
        const stale = !!(num && num <= frontier);
        note({ ev: 'timeout', n: num, frontier, type: command?.type });
        if (!stale) { desync = true; desyncAt = num ?? next; }
        resolve({ ok: false, code: 'timeout', stale });
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      let sent = false;
      try {
        if (typeof rc.trySendMessageNow === 'function') sent = rc.trySendMessageNow(env) !== false;
        else { socket.send(JSON.stringify(env)); sent = true; }
      } catch { sent = false; }
      if (!sent) { clearTimeout(timer); pending.delete(requestId); resolve({ ok: false, code: 'send_failed' }); return; }
      // Handed over, but did it reach the connection? Another mod can swallow a command on the way (QPM's Locker does
      // for purchases when your inventory is nearly full). Then nothing comes back, so say so instead of waiting it out.
      setTimeout(() => {
        if (sentNum.has(requestId) || !pending.has(requestId)) return;
        clearTimeout(timer); pending.delete(requestId);
        resolve({ ok: false, code: 'blocked', reason: "another mod stopped it before it was sent (QPM's Locker does this for purchases when your inventory is nearly full)" });
      }, 1500);
    });
  };

  // Keep-awake ping: tells the server you're still at the spot the game last reported (a flat, unnumbered message, as
  // the game itself sends when you move; the same as Arie's Mod's anti-AFK). Does nothing until the game has moved you.
  const pingPosition = () => {
    if (!lastPosition || !socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify({ scopePath: ['Room', 'Quinoa'], type: 'PlayerPosition', position: { ...lastPosition } })); return true; } catch { return false; }
  };
  return { send, readiness, others, authorizeSell, revokeSell, pingPosition, lastPosition: () => lastPosition, socketNow: () => socket, onSent: (f) => sentListeners.add(f) };
})();

// ---- Hatch guard: lets the UI stop a hatch while the Strength Crystal isn't out ----
// Same approach as QPM's Locker (features/locker/guard.ts): wrap the room connection's sendMessage / trySendMessageNow
// and drop a held-back HatchEgg before it gets a command number, so nothing goes out of step. The UI decides; a
// held hatch is only ever sent again when you press "Hatch anyway". Only HatchEgg is looked at.
const hatchGuard = (() => {
  const deciders = new Map(); // command type -> (resend, payload) => true to hold it back (HatchEgg, SellAllCrops)
  let bypass = false;
  const wrapped = new WeakMap(); // room connection -> names already wrapped (each wrapped once)
  const typeOf = (p) => (p && typeof p === 'object' ? (p.command?.type ?? p.type) : null);
  const wrap = (rc, name) => {
    const done = wrapped.get(rc) ?? new Set(); wrapped.set(rc, done);
    const orig = rc[name];
    if (done.has(name) || typeof orig !== 'function') return;
    done.add(name);
    const hadOwn = Object.prototype.hasOwnProperty.call(rc, name); // another mod (QPM) already wrapped it
    const call = orig.bind(rc);
    const guarded = function (payload, ...rest) {
      const decide = !bypass && deciders.get(typeOf(payload));
      if (decide) {
        let hold = false;
        const resend = () => { bypass = true; try { return call(payload, ...rest); } finally { bypass = false; } };
        try { hold = decide(resend, payload); } catch {}
        if (hold) return name === 'trySendMessageNow' ? false : undefined; // what a closed connection returns
      }
      return call(payload, ...rest);
    };
    guarded.__mgpcGuard = true; guarded.__mgpcHadOwn = hadOwn;
    try { rc[name] = guarded; } catch {}
  };
  setInterval(() => {
    const rc = W.MagicCircle_RoomConnection;
    if (rc) { wrap(rc, 'sendMessage'); wrap(rc, 'trySendMessageNow'); }
  }, 1000);
  return { onHatch: (f) => { deciders.set('HatchEgg', f); }, onCommand: (type, f) => { deciders.set(type, f); } };
})();

// ---- live game state ----
const game = (() => {
  let state = null;
  const listeners = new Set();
  let attachedTo = null;

  const setState = (s) => { if (s && typeof s === 'object') { state = s; listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); } };
  const tryAttach = () => {
    const rc = W.MagicCircle_RoomConnection;
    if (!rc || rc === attachedTo) return;
    attachedTo = rc;
    try {
      const r = rc.subscribeToPatches?.((_patches, full) => setState(full));
      if (r && typeof r === 'object' && r.currentState) setState(r.currentState);
    } catch {}
    try { rc.subscribeToWelcome?.((s) => setState(s)); } catch {}
    if (!state && rc.lastRoomStateJsonable) setState(rc.lastRoomStateJsonable);
  };
  setInterval(tryAttach, 1000);
  tryAttach();

  const ownerId = (s) => s?.userId ?? s?.playerId ?? null;
  // Who you are, tried in order (as QPM does): the game's playerIdAtom / playerAtom (via W.__mglhIdFromStore, set by
  // the UI), the playerId on the game connection's URL (the room connection's socket, then the one this mod watches),
  // the room connection's own fields, and finally the id remembered from last time if that player is in this room.
  const fromUrl = (ws) => { try { const raw = new URL(ws.url).searchParams.get('playerId'); if (raw) { try { return JSON.parse(raw); } catch { return raw.replace(/^"|"$/g, ''); } } } catch {} return null; };
  const myPlayerId = () => {
    const rc = W.MagicCircle_RoomConnection;
    let id = null;
    try { id = W.__mglhIdFromStore?.() || null; } catch {}
    id = id || (rc && fromUrl(rc.currentWebSocket ?? rc.ws ?? rc.socket)) || fromUrl(net.socketNow?.() ?? {}) || rc?.playerId || rc?.userId || null;
    if (id) { if (store.get('myPlayerId', null) !== id) store.set('myPlayerId', id); return id; }
    const saved = store.get('myPlayerId', null);
    return saved && slots().some((sl) => ownerId(sl) === saved) ? saved : null;
  };
  const players = () => state?.data?.players ?? [];
  const slots = () => (state?.child?.data?.userSlots ?? []).filter(Boolean);
  const nameOf = (id) => players().find((p) => p?.id === id)?.name ?? id;

  const mySlot = (chosenId) => {
    const all = slots();
    // a garden picked by hand earlier (maybe in another room) only counts while that player is in this room
    const picked = chosenId && all.find((s) => ownerId(s) === chosenId);
    if (picked) return picked;
    const id = myPlayerId();
    return all.find((s) => ownerId(s) === id) ?? (all.length === 1 ? all[0] : null);
  };

  // All my pets: garden (active), inventory, hutch — plus the set of locked ids
  const readPets = (chosenId) => {
    const slot = mySlot(chosenId);
    if (!slot) return null;
    const inv = slot.data?.inventory ?? {};
    const hutch = (inv.storages ?? []).find((s) => [s?.decorId, s?.storageId, s?.id].includes('PetHutch'));
    const toPet = (loc) => (it) => ({
      id: it.id ?? it.petId, loc, species: it.petSpecies ?? it.species, name: it.name ?? '',
      xp: +it.xp || 0, scale: +it.targetScale || 1,
      mutations: Array.isArray(it.mutations) ? it.mutations : [], abilities: Array.isArray(it.abilities) ? it.abilities : [],
    });
    return {
      pets: [
        ...(slot.data?.petSlots ?? []).filter((p) => p && (p.petSpecies || p.species)).map(toPet('garden')),
        ...(inv.items ?? []).filter((i) => i?.itemType === 'Pet').map(toPet('inventory')),
        ...(hutch?.items ?? []).filter((i) => i?.itemType === 'Pet').map(toPet('hutch')),
      ],
      locked: new Set(inv.favoritedItemIds ?? []),
      // Journal: which pet variants are logged ("Normal", "Gold", "Rainbow", "Max Weight"); null if it can't be read
      journal: (() => { const j = slot.data?.journal ?? slot.journal; return j && typeof j === 'object' ? (j.pets ?? {}) : null; })(),
      // Crop journal: { [species]: { variantsLogged: [{ variant }] } } (null if it can't be read)
      cropJournal: (() => { const j = slot.data?.journal ?? slot.journal; return j && typeof j === 'object' ? (j.produce ?? {}) : null; })(),
      inventoryCount: (inv.items ?? []).length,
      // Seconds left on a placed, active Strength Crystal (0 = none out). Garden tiles hold { objectType: 'crystal',
      // crystalType, remainingActiveSeconds } (format as read by Arie's mg-afk-android, CrystalParser.kt).
      strengthCrystal: (() => {
        const g = slot.data?.garden ?? {};
        let best = 0;
        for (const tiles of [g.tileObjects, g.boardwalkTileObjects]) {
          if (!tiles || typeof tiles !== 'object') continue;
          for (const t of Object.values(tiles)) if (t?.objectType === 'crystal' && t.crystalType === 'Strength') best = Math.max(best, Number(t.remainingActiveSeconds) || 0);
        }
        return best;
      })(),
      // Where a Strength Crystal sits right now ({ tileType: 'Dirt' | 'Boardwalk', index }), or null
      strengthSpot: (() => {
        const g = slot.data?.garden ?? {};
        for (const [tileType, tiles] of [['Dirt', g.tileObjects], ['Boardwalk', g.boardwalkTileObjects]]) {
          if (!tiles || typeof tiles !== 'object') continue;
          for (const [i, t] of Object.entries(tiles)) if (t?.objectType === 'crystal' && t.crystalType === 'Strength') return { tileType, index: Number(i) };
        }
        return null;
      })(),
      // Eggs planted in your garden: { eggId, maturedAt }
      eggs: (() => {
        const g = slot.data?.garden ?? {};
        const out = [];
        for (const tiles of [g.tileObjects, g.boardwalkTileObjects]) {
          if (!tiles || typeof tiles !== 'object') continue;
          for (const t of Object.values(tiles)) if (t && t.objectType === 'egg' && t.eggId) out.push({ eggId: t.eggId, maturedAt: +t.maturedAt || 0 });
        }
        return out;
      })(),
      // Crops growing in your garden (dirt tiles), one per grow slot. The game's photo target is
      // { kind: 'growSlot', slot: tile index, slotsIndex: the slot's slotId } (game bundle, 2026-10-02).
      gardenCrops: (() => {
        const tiles = slot.data?.garden?.tileObjects, out = [];
        if (!tiles || typeof tiles !== 'object') return out;
        for (const [k, t] of Object.entries(tiles)) {
          if (!t || t.objectType !== 'plant' || !Array.isArray(t.slots)) continue;
          t.slots.forEach((sl, i) => {
            if (!sl || typeof sl.species !== 'string') return;
            const muts = Array.isArray(sl.mutations) && sl.mutations.length ? sl.mutations : (Array.isArray(t.mutations) ? t.mutations : []);
            const end = Number(sl.endTime ?? sl.readyAt ?? sl.harvestReadyAt);
            out.push({ tile: Number(k), slotsIndex: i, slotId: Number.isInteger(sl.slotId) ? sl.slotId : null, species: sl.species, mutations: muts.filter((x) => typeof x === 'string'), size: Number.isFinite(Number(sl.size)) && sl.size != null ? Number(sl.size) : null, targetScale: Number(sl.targetScale) || null, endTime: Number.isFinite(end) ? end : null });
          });
        }
        return out;
      })(),
    };
  };

  // Shops: what's in stock and how much of it you've already bought this restock
  const ID_FIELDS = [['species', 'Seed'], ['eggId', 'Egg'], ['toolId', 'Tool'], ['decorId', 'Decor']];
  const shopItemOf = (e) => {
    if (!e || typeof e !== 'object') return null;
    for (const [f, t] of ID_FIELDS) if (typeof e[f] === 'string' && e[f]) return { itemType: typeof e.itemType === 'string' ? e.itemType : t, idField: f, id: e[f] };
    for (const [k, v] of Object.entries(e)) {
      const m = /^([a-z]+)Id$/.exec(k);
      if (m && k !== 'itemId' && typeof v === 'string' && v) return { itemType: typeof e.itemType === 'string' ? e.itemType : m[1][0].toUpperCase() + m[1].slice(1), idField: k, id: v };
    }
    return null;
  };
  // Items that cost Magic Dust (or anything but coins): never bought by the mod
  const NOT_FOR_COINS = new Set(['ReplenishPotion', 'XPPotion']);
  const costsDust = (e, id) => NOT_FOR_COINS.has(id) || e.currency === 'magicDust' || e.currency === 'credits'
    || [e.priceMagicDust, e.magicDustPrice, e.dustPrice, e.priceDust].some((v) => Number(v) > 0);
  const readShops = (chosenId) => {
    const shops = state?.child?.data?.shops;
    if (!shops || typeof shops !== 'object') return null;
    const slot = mySlot(chosenId);
    const mine = slot?.data?.shopPurchases ?? {};
    // Weather shops (Dawn, Amber, …) can have a stock of their own per player
    const custom = slot?.customRestockInventories ?? slot?.data?.customRestockInventories ?? {};
    const keys = new Set([...Object.keys(shops), ...Object.keys(custom || {})]);
    const out = [];
    for (const key of keys) {
      const own = custom?.[key];
      const shop = own && Array.isArray(own.items) ? { ...(shops[key] || {}), inventory: own.items } : shops[key];
      if (!shop || !Array.isArray(shop.inventory)) continue;
      // Your purchase record is per restock: one left over from an earlier restock counts for nothing now
      const rec = mine[key];
      const sameRestock = !rec?.restockId || !shop.restockId ? !(rec?.startedAtMs && shop.startedAtMs && rec.startedAtMs !== shop.startedAtMs)
        : rec.restockId === shop.restockId;
      const bought = sameRestock ? (rec?.purchases ?? shop.purchases ?? {}) : {};
      const items = shop.inventory.map((e) => {
        const it = shopItemOf(e);
        if (!it) return null;
        const stock = Number(e.initialStock ?? e.stock ?? 0) || 0;
        const left = Math.max(0, stock - (Number(bought?.[it.id]) || 0));
        return { ...it, shop: key, restockId: shop.restockId ?? shop.startedAtMs ?? null, name: e.name || e.displayName || it.id, stock, left, price: Number(e.priceCoins ?? e.price) || null, dust: costsDust(e, it.id) };
      }).filter(Boolean);
      // Countdown: newer game builds give deadlineMs (UTC ms when this stock ends, 0 while closed) instead of
      // secondsUntilRestock (game dev's note, 2026-10). Measured against this computer's clock: the room state's
      // currentTime only changes when a patch arrives, so it would freeze the countdown between patches.
      const nowMs = Date.now();
      const restockIn = Number(shop.secondsUntilRestock) || (Number(shop.deadlineMs) > 0 ? Math.max(0, Math.round((Number(shop.deadlineMs) - nowMs) / 1000)) : null);
      out.push({ key, items, restockId: shop.restockId ?? shop.startedAtMs ?? null, restockIn: restockIn || null });
    }
    return out;
  };
  const where = (itemId, chosenId) => readPets(chosenId)?.pets.find((p) => p.id === itemId)?.loc ?? null;
  const waitFor = (test, timeoutMs = 4000) => new Promise((resolve) => {
    if (test()) return resolve(true);
    const t0 = Date.now();
    const iv = setInterval(() => { if (test()) { clearInterval(iv); resolve(true); } else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); resolve(false); } }, 100);
  });

  return {
    ready: () => !!state,
    onChange: (f) => listeners.add(f),
    readPets, where, waitFor, readShops,
    // Inventory stacks (id + what they are) and which storages you have, for putting purchases away
    readStorage: (chosenId) => {
      const d = mySlot(chosenId)?.data ?? {};
      const inv = d.inventory ?? {};
      return {
        coins: Number(d.coinsCount) || 0,
        dust: Number(d.magicDustCount) || 0,
        items: (inv.items ?? []).filter(Boolean),
        storages: (inv.storages ?? []).map((s) => s?.storageId ?? s?.decorId ?? s?.id).filter(Boolean),
        // what's inside each storage, by its id (PetHutch, ToolShack, …)
        storageItems: Object.fromEntries((inv.storages ?? []).filter(Boolean).map((s) => [s.storageId ?? s.decorId ?? s.id, (s.items ?? []).filter(Boolean)])),
        favorites: new Set(inv.favoritedItemIds ?? []),
        // free stack spots per storage (capacitySlots minus stacks in it); unknown capacity = no limit known
        storageFree: Object.fromEntries((inv.storages ?? []).filter(Boolean).map((s) => [s.storageId ?? s.decorId ?? s.id, Number.isFinite(Number(s.capacitySlots)) ? Number(s.capacitySlots) - (s.items ?? []).filter(Boolean).length : Infinity])),
      };
    },
    // The pet you ride (slot.riddenPetId, outside data) and your garden's slot number in the room
    riding: (chosenId) => {
      const slot = mySlot(chosenId); const all = state?.child?.data?.userSlots ?? [];
      return slot ? { petId: typeof slot.riddenPetId === 'string' ? slot.riddenPetId : null, slotIdx: all.indexOf(slot), garden: slot.data?.garden ?? null, pets: (slot.data?.petSlots ?? []).filter(Boolean) } : null;
    },
    lastPosition: () => net.lastPosition?.() ?? null,
    // Room size: garden slots in this room and how many have a player (the friend bonus on crop sales grows with it)
    room: () => { const all = state?.child?.data?.userSlots; return Array.isArray(all) ? { slots: all.length, filled: all.filter(Boolean).length } : null; },
    gardens: () => slots().map((s) => ({ id: ownerId(s), name: nameOf(ownerId(s)) })),
    autoDetected: () => !!slots().find((s) => ownerId(s) === myPlayerId()) || slots().length === 1,
    // you're known but have no garden here (e.g. the room was full and you're watching)
    noGardenHere: () => { const id = myPlayerId(); return !!id && slots().length > 0 && !slots().some((s) => ownerId(s) === id); },
  };
})();

// ---------------------------------------------------------------------------
// Rules (generated from model.js — edit there, then run build-mod.js)
// ---------------------------------------------------------------------------
function analyzeRules(pets, OPTS) {
  // ---- game data (mg-api.ariedam.fr, fetched 2026-09-30) ----
  const MAX_SCALE = { Worm: 2, Snail: 2, Bee: 2.5, Chicken: 2, Bunny: 2, Dragonfly: 2.5, Pig: 2.5, Cow: 2.5, Turkey: 2.5,
    Squirrel: 2, Turtle: 2.5, Goat: 2, SnowFox: 2, Stoat: 2, WhiteCaribou: 2.5, Pony: 2, Sheep: 2.5, Horse: 2.5,
    Ostrich: 2.5, FireHorse: 2.5, Rooster: 2.5, RedFox: 2.5, Phoenix: 2.5, Butterfly: 2.5, Peacock: 2.5, Capybara: 2.5,
    Bat: 2, Platypus: 2, ThunderWolf: 2.5 };
  
  // Abilities that never protect a pet (your preferences; OPTS.ignored replaces this list)
  const DEFAULT_IGNORED = [
    'CoinFinderI', 'CoinFinderII', 'CoinFinderIII', 'CoinFinderIV', 'SnowyCoinFinder', 'DawnCoinFinder', 'ThunderCoinFinder', // coin finders: useless to you
    'SnowGranter', 'FrostGranter', // Chilled/Frozen potions are freely available in the Snow Shop
    'SeedFinderI', // only finds Common/Uncommon seeds, which the shop sells; Gold/Rainbow ones are still kept by the collection rules
  ];
  const IGNORED = new Set(OPTS.ignored ?? DEFAULT_IGNORED);
  // Ignored abilities that still count on Gold/Rainbow pets (a Gold Seed Finder I worm has its uses)
  const COUNT_ON_MUTATED = new Set(['SeedFinderI']);
  const ignoredFor = (p, a) => IGNORED.has(a) && !(COUNT_ON_MUTATED.has(a) && (p.mutations ?? []).some((m) => m === 'Gold' || m === 'Rainbow'));
  
  // Share of time each weather is active (magicgarden.wiki/Weather_Events), pets left out, no micromanagement.
  // Hydro: one event every 40-60 min (taken as ~50 min start-to-start, the generous reading), 10 min long,
  //   Rain 50% / Snow 30% / Thunder 20%.  Lunar: every 4 h, 10 min, Dawn 67% / Amber 33%.
  const HYDRO = 10 / 50, LUNAR = 10 / 240;
  const WEATHER_UPTIME = { Rain: HYDRO * 0.5, Frost: HYDRO * 0.3, Thunder: HYDRO * 0.2, Dawn: LUNAR * 0.67, Amber: LUNAR * 0.33, any: HYDRO + LUNAR };
  
  // Minutes a full hunger bar lasts ("stamina"), magicgarden.wiki/Pets
  const STAMINA = { Worm: 30, Snail: 60, Bee: 15, Chicken: 60, Bunny: 45, Dragonfly: 15, Pig: 60, Cow: 75, Turkey: 60,
    SnowFox: 45, Stoat: 60, WhiteCaribou: 75, Squirrel: 30, Turtle: 90, Goat: 60, Pony: 60, Sheep: 60, Horse: 75,
    Ostrich: 45, Bat: 30, Platypus: 60, ThunderWolf: 60, Butterfly: 30, Peacock: 60, Capybara: 60, Rooster: 60,
    RedFox: 45, FireHorse: 90, Phoenix: 90 };
  
  // Categories whose abilities fire on an event (selling, hatching, harvesting, player use),
  // so stamina doesn't matter for them. Everything else runs continuously.
  const EVENT_CATS = new Set(['sell', 'petRefund', 'dust', 'doubleHarvest', 'hatchXp', 'hatchSize', 'doubleHatch', 'petMut',
    'capture:Dawn', 'capture:Amber', 'capture:Thunder']);
  const isContinuous = (c) => c !== 'HARMFUL' && !EVENT_CATS.has(c) && !c.startsWith('capture:') && !c.startsWith('event:');
  
  // ability -> [category, baseProbability% per roll (null = always on), effect size]
  // Abilities in the same category are compared by expected effect at the pet's max strength.
  const A = {
    CoinFinderI: ['coins', 35, 120000], CoinFinderII: ['coins', 13, 1200000], CoinFinderIII: ['coins', 6, 10000000], CoinFinderIV: ['coins', 3, 40000000],
    SnowyCoinFinder: ['coins:Frost', 15, 5000000], DawnCoinFinder: ['coins:Dawn', 45, 6000000], ThunderCoinFinder: ['coins:Thunder', 35, 5500000],
    // Seed finders find different seed pools per tier, so each tier is its own category
    SeedFinderI: ['seedFinderI', 40, 1], SeedFinderII: ['seedFinderII', 20, 1], SeedFinderIII: ['seedFinderIII', 10, 1], SeedFinderIV: ['seedFinderIV', 0.72, 1],
    DustBoost: ['dust', 10, 20], Rebirth: ['rebirth', 20, 1],
    PlantGrowthBoost: ['plantGrowth', 24, 3], PlantGrowthBoostII: ['plantGrowth', 27, 5], PlantGrowthBoostIII: ['plantGrowth', 30, 7],
    SnowyPlantGrowthBoost: ['plantGrowth:Frost', 40, 6], DawnPlantGrowthBoost: ['plantGrowth:Dawn', 60, 6],
    AmberPlantGrowthBoost: ['plantGrowth:Amber', 80, 6], ThunderPlantGrowthBoost: ['plantGrowth:Thunder', 50, 6],
    ProduceEater: ['HARMFUL', 60, 1],
    // Crop Size Boost adds its Size points flat: STR only changes how often it procs (game's `tge` switch, per Arie's Mod)
    ProduceScaleBoost: ['cropSize', 0.3, 4, 'fixed'], ProduceScaleBoostII: ['cropSize', 0.4, 7, 'fixed'], ProduceScaleBoostIII: ['cropSize', 0.5, 9, 'fixed'], SnowyCropSizeBoost: ['cropSize:Frost', 0.8, 8, 'fixed'],
    ProduceMutationBoost: ['weatherMut', null, 15], ProduceMutationBoostII: ['weatherMut', null, 20], ProduceMutationBoostIII: ['weatherMut', null, 25],
    SnowyCropMutationBoost: ['weatherMut:Frost', null, 32], DawnBoost: ['weatherMut:Dawn', null, 36], AmberMoonBoost: ['weatherMut:Amber', null, 40], ThunderBoost: ['weatherMut:Thunder', null, 34],
    EggGrowthBoost: ['eggGrowth', 21, 7], EggGrowthBoostII_NEW: ['eggGrowth', 24, 9], EggGrowthBoostII: ['eggGrowth', 27, 11],
    SnowyEggGrowthBoost: ['eggGrowth:Frost', 35, 10], ThunderEggGrowthBoost: ['eggGrowth:Thunder', 50, 10], AmberEggGrowthBoost: ['eggGrowth:Amber', 90, 16],
    PetXpBoost: ['xp', 30, 300], PetXpBoostII: ['xp', 35, 400], PetXpBoostIII: ['xp', 40, 500],
    SnowyPetXpBoost: ['xp:Frost', 50, 450], DawnXpBoost: ['xp:Dawn', 75, 850], ThunderXpBoost: ['xp:Thunder', 65, 650], AmberXpBoost: ['xp:Amber', 90, 1400],
    HungerBoost: ['hungerBoost', null, 12], HungerBoostII: ['hungerBoost', null, 16], HungerBoostIII: ['hungerBoost', null, 20], SnowyHungerBoost: ['hungerBoost:Frost', null, 30],
    HungerRestore: ['hungerRestore', 12, 30], HungerRestoreII: ['hungerRestore', 14, 35], HungerRestoreIII: ['hungerRestore', 16, 40], SnowyHungerRestore: ['hungerRestore:Frost', 20, 38],
    PetMutationBoost: ['petMut', null, 7], PetMutationBoostII: ['petMut', null, 10], PetMutationBoostIII: ['petMut', null, 13],
    // Sell Boost and Crop Refund share a category: see where cats are built.
    SellBoostI: ['sell', 10, 20], SellBoostII: ['sell', 12, 30], SellBoostIII: ['sell', 14, 40], SellBoostIV: ['sell', 16, 50], ProduceRefund: ['sell', 20, 0],
    DoubleHarvest: ['doubleHarvest', 5, 1],
    PetAgeBoost: ['hatchXp', 50, 8000], PetAgeBoostII: ['hatchXp', 60, 12000], PetAgeBoostIII: ['hatchXp', 70, 16000],
    PetHatchSizeBoost: ['hatchSize', 12, 2.4], PetHatchSizeBoostII: ['hatchSize', 14, 3.5], PetHatchSizeBoostIII: ['hatchSize', 16, 4.6],
    // Hatch abilities, with the egg pity system (Gold by hatch 200, Rainbow by 2000, rare species by pull 40):
    //  - Double Hatch: the sibling is a full extra hatch that also counts toward pity; it doesn't double-hatch again
    //    (one extra pet per egg at most: the extra pet doesn't double again). Pets are compared by chance.
    //  - Pet Mutation Boost: assumed it multiplies the base Gold/Rainbow chance (1% -> 1% x (1 + boost)); pity trims its gain ~30%.
    // Each is compared only with its own kind, so these assumptions don't change which pets are flagged.
    DoubleHatch: ['doubleHatch', 3, 1], DoubleHatchII: ['doubleHatch', 5, 1],
    PetRefund: ['petRefund', 5, 1], PetRefundII: ['petRefund', 7, 1],
    RainDance: ['granter:Wet', 10, 1], SnowGranter: ['granter:Chilled', 8, 1], FrostGranter: ['granter:Frozen', 6, 1],
    DawnlitGranter: ['granter:Dawnlit', 4, 1], AmberlitGranter: ['granter:Amberlit', 2, 1], ThunderstruckGranter: ['granter:Thunderstruck', 5, 1],
    GoldGranter: ['GOLD granter', 0.72, 1], RainbowGranter: ['RAINBOW granter', 0.72, 1],
    DawnbinderBoost: ['dawnbinder', null, 40], Copycat: ['copycat', 1, 1],
    DawnCapture: ['capture:Dawn', null, 1], AmberCapture: ['capture:Amber', null, 1], Thundercharger: ['capture:Thunder', null, 1],
  };
  
  // Strength Crystal (charged Strength Shard): active pets get +10 STR and +10 max STR (can reach 110).
  // Applied only to one-time-use (specific-use) abilities: you'd have it up while selling/hatching, not all day.
  // On by default (OPTS.crystal = false, or CRYSTAL=0 in Node, turns it off).
  const CRYSTAL_BONUS = OPTS.crystal === false ? 0 : 10;
  
  const maxStr = (p) => {
    const ms = MAX_SCALE[p.species];
    if (!ms) return null;
    return Math.min(100, Math.floor(80 + 20 * (p.scale - 1) / (ms - 1))) + CRYSTAL_BONUS;
  };
  
  // ---- Magic Dust from selling a pet (formula as in QPM's calculator; mg-api.ariedam.fr data) ----
  // dust = floor(100 x rarity x pull-rate x mutation x scale), scale = targetScale x currentSTR / maxSTR
  // Base value only: Dust Boost pets and other bonuses at the moment of selling are not included.
  const RARITY = { Worm: 'Common', Snail: 'Common', Bee: 'Common', Chicken: 'Uncommon', Bunny: 'Uncommon', Dragonfly: 'Uncommon',
    Pig: 'Rare', Cow: 'Rare', Turkey: 'Rare', Squirrel: 'Legendary', Turtle: 'Legendary', Goat: 'Legendary', SnowFox: 'Legendary',
    Stoat: 'Legendary', WhiteCaribou: 'Legendary', Pony: 'Legendary', Sheep: 'Legendary', Horse: 'Legendary', Bat: 'Legendary',
    Platypus: 'Legendary', Ostrich: 'Mythic', FireHorse: 'Mythic', Rooster: 'Mythic', RedFox: 'Mythic', Butterfly: 'Mythic',
    Peacock: 'Mythic', Capybara: 'Mythic', ThunderWolf: 'Mythic', Phoenix: 'Divine' };
  const RARITY_DUST = { Common: 1, Uncommon: 2, Rare: 5, Legendary: 10, Mythic: 50, Mythical: 50, Divine: 50, Celestial: 50 };
  // pull-rate multiplier from the pet's share of its egg: >=51% x1, >=11% x2, otherwise x5
  const PULL_DUST = { Worm: 1, Snail: 2, Bee: 5, Chicken: 1, Bunny: 2, Dragonfly: 5, Pig: 1, Cow: 2, Turkey: 5, Squirrel: 1, Turtle: 2,
    Goat: 5, SnowFox: 1, Stoat: 2, WhiteCaribou: 5, Sheep: 1, Horse: 2, Ostrich: 5, Bat: 1, Platypus: 2, ThunderWolf: 5, Rooster: 1,
    RedFox: 2, FireHorse: 5, Phoenix: 5, Pony: 1, Butterfly: 1, Peacock: 2, Capybara: 5 };
  const MUTATION_DUST = { Gold: 25, Rainbow: 50 };
  const HOURS_TO_MATURE = { Worm: 12, Snail: 12, Bee: 12, Chicken: 24, Bunny: 24, Dragonfly: 24, Pig: 72, Cow: 72, Turkey: 72, Squirrel: 100,
    Turtle: 100, Goat: 100, SnowFox: 100, Stoat: 100, WhiteCaribou: 100, Pony: 72, Sheep: 100, Horse: 100, Ostrich: 144, FireHorse: 144,
    Rooster: 144, RedFox: 144, Phoenix: 168, Butterfly: 144, Peacock: 144, Capybara: 144, Bat: 100, Platypus: 100, ThunderWolf: 144 };
  // ---- live game data (optional) ----
  // OPTS.liveData = { pets, abilities, eggs } as served by mg-api.ariedam.fr (/data/pets, /data/abilities, /data/eggs).
  // Updates the built-in numbers above and adds species/abilities the game has added since. Stamina isn't in that data,
  // so new species get a cautious default (60 min) until they're added to the table.
  const LIVE = { used: false, // exported for the mod's Settings tab
    newSpecies: [], newAbilities: [], unmatched: [] };
  (function applyLiveData(live) {
    if (!live || typeof live !== 'object') return;
    const unwrap = (o) => (o && typeof o === 'object' && o.data && typeof o.data === 'object' && !Array.isArray(o.data) ? o.data : o);
    const pets = unwrap(live.pets), abilities = unwrap(live.abilities), eggs = unwrap(live.eggs);
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (pets && typeof pets === 'object') {
      for (const [sp, d] of Object.entries(pets)) {
        if (!d || typeof d !== 'object' || !num(d.maxScale)) continue;
        if (!(sp in MAX_SCALE)) LIVE.newSpecies.push(sp);
        MAX_SCALE[sp] = d.maxScale;
        if (num(d.hoursToMature)) HOURS_TO_MATURE[sp] = d.hoursToMature;
        if (typeof d.rarity === 'string') RARITY[sp] = d.rarity;
        if (!(sp in STAMINA)) STAMINA[sp] = 60;
      }
    }
    if (eggs && typeof eggs === 'object') {
      for (const egg of Object.values(eggs)) {
        const w = egg && egg.faunaSpawnWeights;
        if (!w || typeof w !== 'object') continue;
        const total = Object.values(w).reduce((t, x) => t + (num(x) ? x : 0), 0);
        if (total <= 0) continue;
        for (const [sp, x] of Object.entries(w)) { const pct = (100 * x) / total; PULL_DUST[sp] = pct >= 51 ? 1 : pct >= 11 ? 2 : 5; }
      }
    }
    if (abilities && typeof abilities === 'object') {
      const WEATHER = { Frost: 'Frost', Snow: 'Frost', Dawn: 'Dawn', AmberMoon: 'Amber', Amber: 'Amber', Thunderstorm: 'Thunder', Thunder: 'Thunder', Rain: 'Rain' };
      // which parameter carries an ability's effect size, per category
      const SIZE_KEY = { coins: 'baseMaxCoinsFindable', plantGrowth: 'plantGrowthReductionMinutes', cropSize: 'sizeIncrease', weatherMut: 'mutationChanceIncreasePercentage',
        eggGrowth: 'eggGrowthTimeReductionMinutes', xp: 'bonusXp', hungerBoost: 'hungerRefundPercentage', hungerRestore: 'hungerRestorePercentage',
        petMut: 'mutationChanceIncreasePercentage', sell: 'cropSellPriceIncreasePercentage', hatchXp: 'bonusXp', hatchSize: 'maxStrengthIncreasePercentage',
        dust: 'petDustIncreasePercentage', dawnbinder: 'plantAbilityChanceBoostPercentage', amberMoonBoost: 'mutationChanceIncreasePercentage' };
      const classify = (id, d) => {
        const p = d.baseParameters || {};
        const w = WEATHER[p.requiredWeather];
        const withW = (cat) => (w ? `${cat}:${w}` : cat);
        if (d.trigger === 'playerActivated') return `capture:${id}`;
        if (/^ProduceEater/.test(id)) return 'HARMFUL';
        if (Array.isArray(p.grantedMutations) && p.grantedMutations.length) {
          const g = p.grantedMutations[0];
          return g === 'Gold' ? 'GOLD granter' : g === 'Rainbow' ? 'RAINBOW granter' : `granter:${g}`;
        }
        if ('baseMaxCoinsFindable' in p) return withW('coins');
        if (/^SeedFinder/.test(id)) return id.replace(/_NEW$/, '').replace(/^SeedFinder/, 'seedFinder');
        if ('plantGrowthReductionMinutes' in p) return withW('plantGrowth');
        if ('sizeIncrease' in p) return withW('cropSize');
        if ('eggGrowthTimeReductionMinutes' in p) return withW('eggGrowth');
        if ('hungerRefundPercentage' in p) return withW('hungerBoost');
        if ('hungerRestorePercentage' in p) return withW('hungerRestore');
        if ('maxStrengthIncreasePercentage' in p) return 'hatchSize';
        if ('petDustIncreasePercentage' in p) return 'dust';
        if ('plantAbilityChanceBoostPercentage' in p) return 'dawnbinder';
        if ('mutationChanceIncreasePercentage' in p) return d.trigger === 'hatchEgg' ? 'petMut' : withW('weatherMut');
        if ('bonusXp' in p) return d.trigger === 'hatchEgg' ? 'hatchXp' : withW('xp');
        if ('cropSellPriceIncreasePercentage' in p) return 'sell';
        if (/^DoubleHatch/.test(id)) return 'doubleHatch';
        if (/^PetRefund/.test(id)) return 'petRefund';
        if (/^DoubleHarvest/.test(id)) return 'doubleHarvest';
        return null; // unknown: becomes its own niche below
      };
      for (const [id, d] of Object.entries(abilities)) {
        if (!d || typeof d !== 'object') continue;
        const prob = num(d.baseProbability) ? d.baseProbability : null;
        const params = d.baseParameters || {};
        if (A[id]) {
          // known ability: keep its category, refresh its numbers
          const cat = A[id][0].split(':')[0];
          const key = SIZE_KEY[cat];
          A[id][1] = prob;
          if (key && num(params[key])) A[id][2] = params[key];
          continue;
        }
        let cat = classify(id, d);
        if (!cat) { cat = d.trigger && d.trigger !== 'continuous' ? `event:${id}` : `other:${id}`; LIVE.unmatched.push(id); }
        const key = SIZE_KEY[cat.split(':')[0]];
        A[id] = [cat, prob, key && num(params[key]) ? params[key] : 1, ...(key === 'sizeIncrease' ? ['fixed'] : [])]; // Size points: flat
        LIVE.newAbilities.push(id);
      }
    }
    LIVE.used = true;
  })(OPTS.liveData);
  
  // Current strength: starts 30 below max and gains 1 per 1/30 of the hours-to-mature in XP
  const curStr = (p) => {
    const ms = MAX_SCALE[p.species], hrs = HOURS_TO_MATURE[p.species];
    if (!ms || !hrs) return null;
    const maxS = Math.min(100, Math.floor(80 + 20 * (p.scale - 1) / (ms - 1)));
    return maxS - 30 + Math.min(30, Math.floor((p.xp || 0) / (3600 * hrs / 30)));
  };
  const petDust = (p) => {
    const ms = MAX_SCALE[p.species], hrs = HOURS_TO_MATURE[p.species];
    if (!ms || !hrs) return null;
    const maxS = Math.min(100, Math.floor(80 + 20 * (p.scale - 1) / (ms - 1))); // the pet's own max STR (no crystal)
    const curS = maxS - 30 + Math.min(30, Math.floor((p.xp || 0) / (3600 * hrs / 30)));
    const mut = Math.max(1, ...p.mutations.map((m) => MUTATION_DUST[m] ?? 1));
    return Math.floor(100 * (RARITY_DUST[RARITY[p.species]] ?? 1) * (PULL_DUST[p.species] ?? 1) * mut * p.scale * curS / maxS);
  };
  
  // expected effect of one ability at strength S: chance and effect both scale with STR
  const effect = (id, S) => {
    const d = A[id];
    if (!d) return null;
    const [, prob, size, mode] = d;
    const chance = prob == null ? 1 : Math.min(1, (prob / 100) * S / 100);
    // Abilities whose only number is their chance (Seed Finder, Double Hatch, Pet Refund, granters, …) scale once, through
    // the chance. Always-on and click abilities (no chance) scale through their effect instead.
    const chanceOnly = size === 1 && prob != null;
    const eff = mode === 'fixed' || chanceOnly ? size : size * S / 100;
    return chance * eff;
  };
  
  const isNamed = (n) => !!n && n !== '~' && n.replace(/[\s\p{Cf}]/gu, '').length > 0;
  
  const unknown = new Set();
  for (const p of pets) {
    p.str = maxStr(p); // used for the maths (includes the Strength Crystal)
    p.baseStr = p.str == null ? null : p.str - CRYSTAL_BONUS; // the pet's in-game max strength, for display
    p.dust = petDust(p);
    p.curStr = curStr(p); // in-game current strength (no crystal)
    p.cats = {};
    p.catAbilities = {}; // which of the pet's abilities feed each category (for display)
    const fed = (key, a) => (p.catAbilities[key] ??= []).push(a);
    let sellBoost = 0, refundChance = 0;
    for (const a of p.abilities) {
      if (!A[a]) { unknown.add(a); continue; }
      const [cat, weather] = A[a][0].split(':');
      // Click abilities (Thundercharger, Dawn/Amber Capture) are active-use abilities: they count in the
      // specific-use role, each as its own niche compared by strength (no weather discount — you click them when it matters).
      if (cat === 'capture') {
        if (ignoredFor(p, a)) continue;
        p.cats[A[a][0]] = (p.cats[A[a][0]] ?? 0) + effect(a, p.str); fed(A[a][0], a);
        continue;
      }
      // Abilities you've said you don't care about
      if (ignoredFor(p, a)) continue;
      if (A[a][0] === 'sell') {
        // Crop Refund: each crop you sell has this chance of not being removed (you're paid and keep it), so a crop is
        // sold 1 / (1 - chance) times on average, each time with the Sell Boost: payout x (1 + boost) / (1 - chance)
        if (a === 'ProduceRefund') refundChance = 1 - (1 - refundChance) * (1 - Math.min(0.99, (A[a][1] / 100) * p.str / 100));
        else sellBoost += effect(a, p.str) / 100;
        fed('sell', a);
        continue;
      }
      // Weather versions merge into their normal category, scaled by how often that weather is up.
      // Normal Weather Mutation Boost only matters while some weather is up, so it's scaled by total weather time.
      // Granters (Thunderstruck, Dawnlit, ...) work in any weather, so they keep their own category.
      let key = A[a][0];
      if (a === 'AmberMoonBoost') key = 'amberMoonBoost'; // own niche: maximizing Amber, only compared with other Amber Moon Boost pets
      else if (weather && cat !== 'granter') key = cat;
      // The Strength Crystal (4 h) only counts for one-time-use abilities; continuous ones run at the pet's own max STR
      let v = effect(a, isContinuous(key) ? p.baseStr : p.str);
      if (weather && cat !== 'granter' && a !== 'AmberMoonBoost') v *= WEATHER_UPTIME[weather];
      else if (cat === 'weatherMut') v *= WEATHER_UPTIME.any;
      p.cats[key] = (p.cats[key] ?? 0) + v; fed(key, a);
    }
    if (sellBoost || refundChance) p.cats.sell = ((1 + sellBoost) / (1 - refundChance) - 1) * 100; // % extra coins
    // Gold Granter is a long-term ability: it always counts in the leave-out role (compared with stamina).
    // A Gold pet with another long-term ability is protected outright; one with no other useful ability is
    // judged on its Gold Granter alone (kept unless 1 pet grants Gold better).
    const others = Object.keys(p.cats).filter((c) => c !== 'GOLD granter' && c !== 'HARMFUL' && p.cats[c] > 0);
    p.goldMatters = p.abilities.includes('GoldGranter') && others.some((c) => c !== 'RAINBOW granter' && isContinuous(c));
    p.goldOnly = p.abilities.includes('GoldGranter') && others.length === 0;
    p.named = OPTS.protectNamed !== false && isNamed(p.name);
  }
  
  // A is at least as good as B: covers every good category of B with >= effect, and is no more harmful
  const atLeastAsGood = (a, b) => {
    let bNeedsStamina = false;
    for (const [c, v] of Object.entries(b.cats)) {
      if (c === 'HARMFUL') continue;
      if (isContinuous(c)) bNeedsStamina = true;
      if ((a.cats[c] ?? 0) < v - 1e-9) return false;
    }
    if (bNeedsStamina && (STAMINA[a.species] ?? 0) < (STAMINA[b.species] ?? 0)) return false;
    if ((a.cats.HARMFUL ?? 0) > (b.cats.HARMFUL ?? 0) + 1e-9) return false;
    return true;
  };
  // strictly better, with exact ties broken by more XP then id (so identical duplicates still get culled)
  const better = (a, b) => {
    if (a === b) return false;
    if (b.goldMatters) return false; // nothing beats a Gold pet that is kept out long term
    if (!atLeastAsGood(a, b)) return false;
    if (!atLeastAsGood(b, a)) return true;
    return a.scale !== b.scale ? a.scale > b.scale : a.xp !== b.xp ? a.xp > b.xp : a.id < b.id;
  };
  
  // Optional (TINY=0.1): ignore abilities worth less than that fraction of your best pet in the same category
  const TINY = +(OPTS.tiny ?? 0);
  if (TINY > 0) {
    const best = {};
    for (const p of pets) for (const [c, v] of Object.entries(p.cats)) if (c !== 'HARMFUL') best[c] = Math.max(best[c] ?? 0, v);
    for (const p of pets) {
      p.tiny = Object.entries(p.cats).filter(([c, v]) => c !== 'HARMFUL' && v > 0 && v < TINY * best[c]).map(([c]) => c);
      for (const c of p.tiny) delete p.cats[c];
    }
  }
  
  // Each pet is judged in two roles, separately:
  //  - leave-out role: only its continuous abilities (stamina counts); deletable with 2 better pets
  //    (the 3rd active slot is kept for a hunger pet like SUPERFOOD)
  //  - specific-use role: only its event abilities (sell/hatch/harvest/pet-sell); deletable with 3 better pets
  // A pet is deletable if it's deletable in every role it has (a role it doesn't have counts as deletable).
  const ROLES = { leaveOut: { test: (c) => isContinuous(c), threshold: OPTS.leaveOutThreshold ?? 2 }, specificUse: { test: (c) => !isContinuous(c) && c !== 'HARMFUL', threshold: OPTS.specificUseThreshold ?? 3 } };
  const roleCats = (p, role) => Object.entries(p.cats).filter(([c, v]) => ROLES[role].test(c) && v > 0);
  const atLeastAsGoodIn = (a, b, role) => {
    const cats = roleCats(b, role);
    for (const [c, v] of cats) if ((a.cats[c] ?? 0) < v - 1e-9) return false;
    if (role === 'leaveOut' && (STAMINA[a.species] ?? 0) < (STAMINA[b.species] ?? 0)) return false;
    if ((a.cats.HARMFUL ?? 0) > (b.cats.HARMFUL ?? 0) + 1e-9) return false;
    return true;
  };
  // Optional (OPTS.mutSameSpecies): a Gold or Rainbow pet is only ever compared with pets of its own species
  const isMutated = (p) => p.mutations.includes('Gold') || p.mutations.includes('Rainbow');
  const betterIn = (a, b, role) => {
    if (a === b || !atLeastAsGoodIn(a, b, role)) return false;
    if (OPTS.mutSameSpecies && isMutated(b) && a.species !== b.species) return false;
    // A left-out pet with Gold Granter also turns crops gold, which isn't always wanted, so it doesn't replace one without
    if (OPTS.goldNotUpgrade !== false && role === 'leaveOut' && (a.cats['GOLD granter'] ?? 0) > 0 && !((b.cats['GOLD granter'] ?? 0) > 0)) return false;
    // An extra ability is an edge, except Gold Granter on a pet that's left out: gold crops aren't always wanted
    const extras = (p) => roleCats(p, role).filter(([c]) => !(OPTS.goldNotUpgrade !== false && role === 'leaveOut' && c === 'GOLD granter')).length;
    if (!atLeastAsGoodIn(b, a, role) || extras(a) > extras(b)) return true;
    return a.scale !== b.scale ? a.scale > b.scale : a.xp !== b.xp ? a.xp > b.xp : a.id < b.id;
  };
  
  // Three-ability pets are only compared with other three-ability pets that have each of their abilities (same or higher
  // tier): a pet with one or two of those abilities doesn't replace one that has all three.
  const rolled = (p) => p.abilities.filter((a) => a !== 'GoldGranter' && a !== 'RainbowGranter');
  const TIER3 = { I: 1, II: 2, III: 3, IV: 4 };
  const split3 = (a) => { const m = /^(.*[a-z])(IV|III|II|I)$/.exec(a); return m ? [m[1], TIER3[m[2]]] : [a, 1]; };
  const covers = (q, a) => { const [fam, tier] = split3(a); return q.abilities.some((b) => split3(b)[0] === fam && split3(b)[1] >= tier); };
  const isTriple = (p) => rolled(p).length >= 3;
  const tripleOn = () => (OPTS.tripleCompare ?? OPTS.collectThreeAbility) !== false; // Maybe sell turns the collection off, not this
  const tripleRival = (q, p) => !tripleOn() || !isTriple(p) || (isTriple(q) && rolled(p).every((a) => covers(q, a)));
  for (const p of pets) {
    p.betterThanMe = pets.filter((q) => better(q, p)); // whole-pet comparison, kept for reference
    p.roles = {};
    for (const role of Object.keys(ROLES)) {
      if (!roleCats(p, role).length) continue;
      const beatenBy = pets.filter((q) => betterIn(q, p, role) && tripleRival(q, p));
      // Keep up to 3 instead of 2 when left out for:
      //  - hunger pets (Hunger Restore / Hunger Boost): they need no other hunger pet beside them, so all three could be out
      //  - Rainbow pets: they're very rare
      const hungerPet = (p.cats.hungerRestore ?? 0) > 0 || (p.cats.hungerBoost ?? 0) > 0;
      const extraCopy = OPTS.extraCopies !== false && role === 'leaveOut' && (hungerPet || p.mutations.includes('Rainbow'));
      // Three-ability pets: one better pet with all three abilities is enough (it already does everything this one does)
      const tripleOne = tripleOn() && isTriple(p);
      const threshold = p.goldOnly || tripleOne ? 1 : ROLES[role].threshold + (extraCopy ? 1 : 0);
      p.roles[role] = { beatenBy, deletable: beatenBy.length >= threshold, threshold };
    }
    p.longTerm = !!p.roles.leaveOut;
  }
  const deletable = (p) => !(p.goldMatters && OPTS.protectLongTermGold !== false) && Object.values(p.roles).every((x) => x.deletable);
  
  // Collection: your best Gold and best Rainbow of every species (highest max STR, then size, then XP) are always kept.
  for (const mut of OPTS.collectMutations === false ? [] : ['Rainbow', 'Gold']) {
    for (const species of new Set(pets.map((p) => p.species))) {
      const group = pets.filter((p) => p.species === species && p.mutations.includes(mut));
      if (!group.length) continue;
      const best = [...group].sort((x, y) => (y.str ?? 0) - (x.str ?? 0) || y.scale - x.scale || y.xp - x.xp)[0];
      if (deletable(best) && !best.named) best.collection = mut;
    }
  }
  // Good Gold/Rainbow collection: a Gold (or Rainbow) pet is kept unless another Gold (Rainbow) pet of its species
  // already covers it: has every one of its abilities (same or a higher tier; granters and ignored abilities don't
  // count) and is at least as strong. So each different useful ability mix is kept once, in its best copy, and only
  // weaker duplicates can go. (Covering is one-way and ends at a pet nobody covers, so a covered pet's better copy stays.)
  if (OPTS.collectUniqueMutated !== false) {
    const TIER = { I: 1, II: 2, III: 3, IV: 4 };
    const split = (a) => { const m = /^(.*[a-z])(IV|III|II|I)$/.exec(a); return m ? [m[1], TIER[m[2]]] : [a, 1]; };
    const counted = (p) => p.abilities.filter((a) => a !== 'GoldGranter' && a !== 'RainbowGranter' && !ignoredFor(p, a));
    const has = (q, a) => { const [fam, tier] = split(a); return q.abilities.some((b) => !ignoredFor(q, b) && split(b)[0] === fam && split(b)[1] >= tier); };
    const rank = (x, y) => (x.str ?? 0) - (y.str ?? 0) || x.scale - y.scale || x.xp - y.xp || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    for (const mut of ['Rainbow', 'Gold']) {
      for (const p of pets.filter((q) => q.mutations.includes(mut) && deletable(q) && !q.named && !q.collection)) {
        const mine = counted(p);
        if (!mine.length) continue; // nothing useful beyond the granter: the best Gold/Rainbow of the species covers that
        const same = pets.filter((q) => q !== p && q.species === p.species && q.mutations.includes(mut));
        if (same.some((q) => rank(q, p) > 0 && mine.every((a) => has(q, a)))) continue;
        const others = same.filter((q) => mine.some((a) => has(q, a)));
        const lone = mine.find((a) => !same.some((q) => has(q, a)));
        p.collection = lone ? `only ${mut} ${p.species} with ${lone}`
          : others.length ? `best ${mut} ${p.species} with ${mine.join(' + ')}` : `${mut} ${p.species}`;
      }
    }
  }
  // Three-ability collection: every pet with 3 rolled abilities (not counting the automatic Gold/Rainbow Granter) is
  // kept, unless another 3-ability pet of the same species is better: it has each of this pet's abilities (same or
  // higher tier), at least its mutations, and is at least as strong (ties: bigger, then older). That one stays.
  if (OPTS.collectThreeAbility !== false) {
    const rank3 = (x, y) => (x.str ?? 0) - (y.str ?? 0) || x.scale - y.scale || x.xp - y.xp || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    const triples = pets.filter((p) => rolled(p).length >= 3);
    for (const p of triples.filter((q) => deletable(q) && !q.named && !q.collection)) {
      const better = triples.some((q) => q !== p && q.species === p.species && rank3(q, p) > 0
        && p.mutations.every((m) => q.mutations.includes(m)) && rolled(p).every((a) => covers(q, a)));
      if (!better) p.collection = 'three abilities';
    }
  }
  const useless = pets.filter((p) => deletable(p) && !p.named && !p.collection);
  const savedByName = pets.filter((p) => deletable(p) && p.named);
  const savedByCollection = pets.filter((p) => p.collection);
  
  
  return { pets, useless, savedByName, savedByCollection, unknown, A, DEFAULT_IGNORED, STAMINA, isContinuous, MAX_SCALE, LIVE, effect, HOURS_TO_MATURE };
}
// Tables the UI reads; refreshed when live game data arrives (refreshRulesMeta)
let RULES_META, A_TABLE, DEFAULT_IGNORED_LIST, STAMINA_MIN, catIsContinuous, MAX_SCALE_OF;
function refreshRulesMeta(liveData) {
  RULES_META = analyzeRules([], { liveData });
  A_TABLE = RULES_META.A; DEFAULT_IGNORED_LIST = RULES_META.DEFAULT_IGNORED; STAMINA_MIN = RULES_META.STAMINA;
  catIsContinuous = RULES_META.isContinuous; MAX_SCALE_OF = RULES_META.MAX_SCALE;
}
refreshRulesMeta(undefined);

// ---------------------------------------------------------------------------
// Settings, analysis, panel UI, sell flow
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  crystal: true, // count the Strength Crystal's +10 STR
  leaveOutThreshold: 2, // better pets needed to flag a leave-out pet (3rd slot is for a hunger pet)
  specificUseThreshold: 3, // better pets needed to flag a specific-use pet
  tiny: 0, // ignore abilities worth less than this share of your best (0 = off)
  protectNamed: true, // never flag pets with a visible name
  protectLongTermGold: true, // never flag Gold pets that also have a long-term ability
  collectMutations: true, // keep one Rainbow and one Gold per species
  collectThreeAbility: true, // keep every three-ability pet unless a better one of its species has the same abilities
  mutSameSpecies: false, // Gold/Rainbow pets are only compared with their own species
  collectUniqueMutated: true, // keep every good Gold/Rainbow: one best copy of each different ability mix per species
  extraCopies: true, // hunger pets and Rainbow pets: keep 3 (not 2) when left out
  goldNotUpgrade: true, // a Gold Granter pet doesn't replace a left-out pet without one
  maybeLooser: 1, // Maybe sell: this many fewer better pets needed
  teamsProtect: true, // pets on one of the mod's best teams are never useless
  pityMutFactor: 0.7, // share of Pet Mutation Boost the pity system leaves (Gold/Rainbow team maths)
  // Feature switches (Settings → Features): every extra can be turned off
  featBuyAll: true, // 🛒 Buy everything
  featLevelUp: true, // 📈 Level up preset on the Teams tab
  featEggPlan: true, // 📖 which team for each egg
  featMountHint: true, // riding a pet with Thundercharger / Dawn or Amber Capture: what pressing it would do here
  featPlantHint: true, // show a plant's missing journal entries above the game's plant card
  fabDrag: true, // drag 🐾 to move the 🐾 / 🛒 / 🧪 buttons
  keepAwake: true, // keep the game running while its tab is in the background (like Arie's Mod's anti-AFK)
  featChargeTeam: true, // 🌩️ Charge & capture team
  featTeamsOrder: true, // Teams tab puts what's due first (hatching / selling / growing)
  featSellFix: true, // sell dialog: swap in the selling team
  featJoin5: true, // 👥 button: join a public room with 5 players
  featHatchFix: true,
  cropSellRoomWarn: true,
  cropSellTeamWarn: true, // …or when no Sell Boost pet is out (and you have a Crop selling team)
  harvestTeamWarn: true, // ask before harvesting a Gold/Rainbow celestial crop without Double Harvest pets out
 // ask before selling valuable crops while the room isn't full (smaller friend bonus)
  cropSellWarnMin: 1000000000, // …when the crops are worth at least this many coins
 // hatch pop-up: swap in a hatching team
  featCrystalPlace: true, // offer to put the Strength Crystal out (hatch pop-up, sell dialog)
  featLogging: true, // 📖 Log buttons (pets and crops)
  featCropJournal: true, // 🌱 crop journal filters
  featSeedButtons: true, // 🌱 Get seeds from the Seed Silo
  featTabOrder: true, // drag tabs to reorder them
  tabOrder: [], // your tab order (empty = default)
  buyOff: [], // Buy everything: items you switched off ('shop:itemId')
  sellTeam: 'dust', // team the sell dialog swaps in: 'dust' (refund + dust boost) or 'refund'
  buyPotions: false, // Buy everything: also buy XP and Hunger potions with Magic Dust (no other dust item is ever bought)
  noLocalStock: ['Grape', 'Lemon', 'Lychee', 'Banana'], // seeds the game lists but doesn't sell you
  retiredEggs: ['WinterEgg', 'HorseEgg'], // eggs left out of the egg plan
  showShopButton: true, // the always-visible 🛒 button
  showTeamButton: true, // the 🧪 button above it while eggs are ready or pets can be sold
  taskWarnings: true, // hatch / sell reminders (Strength Crystal, idle pets)
  crystalBlock: true, // stop a hatch and ask first while the Strength Crystal isn't out
  idleBlock: true, // stop a hatch and ask first while pets are out that don't help with hatching
  pityPopup: true, // pity line-up popup (needs QPM)
  ignored: null, // abilities that never protect a pet (null = defaults)
  keepSpecies: [], // always keep these species
  keepAbilities: [], // always keep pets with any of these abilities
  pinned: [], // pet ids you've marked "keep"
  abilityOrder: 'type', // how ability badges are ordered: 'type' | 'alpha' | 'game'
  sortBy: 'species', // list order: 'species' (then max STR) | 'str' | 'dust'
  gardenOwner: null, // your garden, if it can't be detected
  levelMode: 'auto', // Level-up queue: 'auto' (most gain per hour) | 'list' (your goal order below)
  levelFeeder: 'pet', // Level-up team: 'pet' (a hunger pet keeps the others fed) | 'self' (you feed them all; no feeder)
  levelOrder: ['dust', 'refund', 'mutation', 'maxStr', 'sell', 'rare'], // your goal priority for Level-up
  levelOff: [], // goals Level-up ignores
  levelPinned: [], // pets you've put at the front of the Level-up queue
};
let settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
if (settings.pityMutFactor === 0.77) settings.pityMutFactor = 0.7; // old default (too high), corrected
// 0.14.7: Seed Finder I became ignored by default. A list you've customised gets it added once (untick to undo).
if (Array.isArray(settings.ignored) && !settings.seedFinderMigrated) {
  settings.ignored = [...new Set([...settings.ignored, 'SeedFinderI'])];
  settings.seedFinderMigrated = true; store.set('settings', settings);
}
const saveSettings = () => { store.set('settings', settings); try { applyKeepAwake(); } catch {} }; // (keep-awake follows its switch)

const allAbilities = () => Object.keys(A_TABLE);
// In-game ability names (mg-api.ariedam.fr /data/abilities); anything unknown is spelled out from its id
const ABILITY_NAMES = {
  CoinFinderI: 'Coin Finder I', CoinFinderII: 'Coin Finder II', CoinFinderIII: 'Coin Finder III', CoinFinderIV: 'Coin Finder IV',
  SnowyCoinFinder: 'Snow Coin Finder', DawnCoinFinder: 'Dawn Coin Finder', ThunderCoinFinder: 'Thunder Coin Finder',
  SeedFinderI: 'Seed Finder I', SeedFinderII: 'Seed Finder II', SeedFinderIII: 'Seed Finder III', SeedFinderIV: 'Seed Finder IV',
  DustBoost: 'Dust Boost', Rebirth: 'Rebirth', PlantGrowthBoost: 'Plant Growth Boost I', PlantGrowthBoostII: 'Plant Growth Boost II',
  PlantGrowthBoostIII: 'Plant Growth Boost III', SnowyPlantGrowthBoost: 'Snow Plant Growth Boost', DawnPlantGrowthBoost: 'Dawn Plant Growth Boost',
  AmberPlantGrowthBoost: 'Amber Plant Growth Boost', ThunderPlantGrowthBoost: 'Thunder Plant Growth Boost', ProduceEater: 'Crop Eater',
  ProduceScaleBoost: 'Crop Size Boost I', ProduceScaleBoostII: 'Crop Size Boost II', ProduceScaleBoostIII: 'Crop Size Boost III',
  SnowyCropSizeBoost: 'Snow Crop Size Boost', ProduceMutationBoost: 'Weather Mutation Boost I', ProduceMutationBoostII: 'Weather Mutation Boost II',
  ProduceMutationBoostIII: 'Weather Mutation Boost III', SnowyCropMutationBoost: 'Snow Boost', DawnBoost: 'Dawn Boost', AmberMoonBoost: 'Amber Moon Boost',
  ThunderBoost: 'Thunder Boost', EggGrowthBoost: 'Egg Growth Boost I', EggGrowthBoostII_NEW: 'Egg Growth Boost II', EggGrowthBoostII: 'Egg Growth Boost III',
  SnowyEggGrowthBoost: 'Snowy Egg Growth Boost', ThunderEggGrowthBoost: 'Thunder Egg Growth Boost', AmberEggGrowthBoost: 'Amber Egg Growth Boost',
  PetXpBoost: 'XP Boost I', PetXpBoostII: 'XP Boost II', PetXpBoostIII: 'XP Boost III', SnowyPetXpBoost: 'Snow XP Boost', DawnXpBoost: 'Dawn XP Boost',
  ThunderXpBoost: 'Thunder XP Boost', AmberXpBoost: 'Amber XP Boost', HungerBoost: 'Hunger Boost I', HungerBoostII: 'Hunger Boost II',
  HungerBoostIII: 'Hunger Boost III', SnowyHungerBoost: 'Snow Hunger Boost', HungerRestore: 'Hunger Restore I', HungerRestoreII: 'Hunger Restore II',
  HungerRestoreIII: 'Hunger Restore III', SnowyHungerRestore: 'Snow Hunger Restore', PetMutationBoost: 'Pet Mutation Boost I',
  PetMutationBoostII: 'Pet Mutation Boost II', PetMutationBoostIII: 'Pet Mutation Boost III', SellBoostI: 'Sell Boost I', SellBoostII: 'Sell Boost II',
  SellBoostIII: 'Sell Boost III', SellBoostIV: 'Sell Boost IV', ProduceRefund: 'Crop Refund', DoubleHarvest: 'Double Harvest',
  PetAgeBoost: 'Hatch XP Boost I', PetAgeBoostII: 'Hatch XP Boost II', PetAgeBoostIII: 'Hatch XP Boost III', PetHatchSizeBoost: 'Max Strength Boost I',
  PetHatchSizeBoostII: 'Max Strength Boost II', PetHatchSizeBoostIII: 'Max Strength Boost III', DoubleHatch: 'Double Hatch I', DoubleHatchII: 'Double Hatch II',
  PetRefund: 'Pet Refund I', PetRefundII: 'Pet Refund II', RainDance: 'Rain Granter', SnowGranter: 'Snow Granter', FrostGranter: 'Frost Granter',
  DawnlitGranter: 'Dawnlit Granter', AmberlitGranter: 'Amberlit Granter', GoldGranter: 'Gold Granter', RainbowGranter: 'Rainbow Granter',
  DawnbinderBoost: 'Dawnbinder Boost', Copycat: 'Copycat', DawnCapture: 'Dawn Capture', AmberCapture: 'Amber Capture',
  ThunderstruckGranter: 'Thunderstruck Granter', Thundercharger: 'Thundercharger',
};
const pretty = (id) => ABILITY_NAMES[id] ?? liveNames[id] ?? String(id).replace(/_NEW$/, '').replace(/([a-z])(IV|I{1,3})$/, '$1 $2').replace(/([a-z])([A-Z])/g, '$1 $2');
// Where a pet is: icon with a tooltip (copy-report text keeps the plain words)
const LOC = { inventory: ['🎒', 'In your inventory'], hutch: ['🏠', 'In your pet hutch'], garden: ['🌱', 'Active — out in your garden'] };
const locIcon = (loc) => `<span class="locic" title="${(LOC[loc] || [loc, loc])[1]}">${(LOC[loc] || ['?'])[0]}</span>`;
const nameOnly = (p) => `${p.species}${p.mutations.length ? ' (' + p.mutations.join('/') + ')' : ''}`;
// Max STR in bold; if the pet is still growing, its current STR sits in front, like the game shows it (62/92)
const strCell = (p) => (p.curStr != null && p.baseStr != null && p.curStr < p.baseStr ? `<span class="cstr" title="Current STR ${p.curStr} — grows to ${p.baseStr}">${p.curStr}/</span>` : '') + `<b class="str">${p.baseStr ?? '?'}</b>`;
const label = (p) => `${p.species}${p.mutations.length ? ' (' + p.mutations.join('/') + ')' : ''} · max STR ${p.baseStr}`; // in-game max strength (the crystal bonus is only used in the comparison maths)


// Ability badge colours, as the game shows them (from Arie's Mod's mapping); first matching prefix wins
const ABILITY_COLORS = [
  ['DawnCapture', '#b25a9e'], ['AmberCapture', '#c9783c'], ['DawnbinderBoost', '#b468a0'],
  ['ProduceScaleBoost', '#228b22'], ['SnowyCropSizeBoost', '#228b22'],
  ['PlantGrowthBoost', '#008080'], ['SnowyPlantGrowthBoost', '#008080'], ['DawnPlantGrowthBoost', '#008080'], ['AmberPlantGrowthBoost', '#008080'], ['ThunderPlantGrowthBoost', '#008080'],
  ['EggGrowthBoost', '#b45af0'], ['SnowyEggGrowthBoost', '#b45af0'], ['ThunderEggGrowthBoost', '#b45af0'], ['AmberEggGrowthBoost', '#b45af0'],
  ['PetAgeBoost', '#9370db'], ['PetHatchSizeBoost', '#800080'],
  ['PetXpBoost', '#1e90ff'], ['SnowyPetXpBoost', '#1e90ff'], ['DawnXpBoost', '#1e90ff'], ['ThunderXpBoost', '#1e90ff'], ['AmberXpBoost', '#1e90ff'],
  ['HungerBoost', '#ff1493'], ['SnowyHungerBoost', '#ff1493'], ['HungerRestore', '#ff69b4'], ['SnowyHungerRestore', '#ff69b4'],
  ['SellBoost', '#dc143c'], ['ProduceRefund', '#ff6347'],
  ['CoinFinder', '#b49600'], ['SnowyCoinFinder', '#b49600'], ['DawnCoinFinder', '#b49600'], ['ThunderCoinFinder', '#b49600'],
  ['SeedFinder', '#a86626'],
  ['ProduceMutationBoost', '#8c0f46'], ['SnowyCropMutationBoost', '#8c0f46'], ['DawnBoost', '#8c0f46'], ['AmberMoonBoost', '#8c0f46'], ['ThunderBoost', '#8c0f46'],
  ['PetMutationBoost', '#a03264'], ['DoubleHarvest', '#0078b4'], ['DoubleHatch', '#3c5ab4'],
  ['ProduceEater', '#ff4500'], ['PetRefund', '#005078'], ['Copycat', '#ff8c00'], ['DustBoost', '#6a7bd1'],
  ['GoldGranter', 'linear-gradient(135deg,#e1c837,#e1b40a 40%,#d7b92d 70%,#d2b92d)'],
  ['RainbowGranter', 'linear-gradient(45deg,#c80000,#c87800,#a0aa1e,#3caa3c,#32aaaa,#2896b4,#145ab4,#461e96)'],
  ['RainDance', '#4ccccc'], ['SnowGranter', '#90b8cc'], ['FrostGranter', '#94a0cc'], ['DawnlitGranter', '#c47cb4'],
  ['AmberlitGranter', '#cc9060'], ['ThunderstruckGranter', '#c2b83c'], ['Thundercharger', '#1fa382'],
];
const abilityColor = (id) => (ABILITY_COLORS.find(([prefix]) => id.startsWith(prefix)) || [null, '#646464'])[1];
// Canonical badge order: grouped by what the ability does (the rules' table order), Gold/Rainbow Granter last
const orderByType = () => [...allAbilities().filter((a) => a !== 'GoldGranter' && a !== 'RainbowGranter'), 'GoldGranter', 'RainbowGranter'];
const typeRank = (a) => { const o = orderByType(); const i = o.indexOf(a); return i < 0 ? o.length : i; };
// Abilities that don't count under your settings (ignored list) go last and are dimmed
const isIgnoredAbility = (a, p) => (settings.ignored ?? DEFAULT_IGNORED_LIST).includes(a)
  && !(a === 'SeedFinderI' && p && (p.mutations ?? []).some((m) => m === 'Gold' || m === 'Rainbow')); // counts on Gold/Rainbow pets
const orderAbilities = (list) => {
  if (settings.abilityOrder === 'game') return list;
  const out = [...list];
  const rest = settings.abilityOrder === 'alpha' ? (x, y) => pretty(x).localeCompare(pretty(y)) : (x, y) => typeRank(x) - typeRank(y) || pretty(x).localeCompare(pretty(y));
  return out.sort((x, y) => isIgnoredAbility(x) - isIgnoredAbility(y) || rest(x, y));
};
const abilityTags = (p) => orderAbilities(p.abilities).map((a) => abilityTag(a, p)).join('');
// Ignored abilities are shown dimmed and struck through
const abilityTag = (a, p) => isIgnoredAbility(a, p)
  ? `<span class="tag ab ign" style="background:${abilityColor(a)}" title="Doesn't count: ignored in your settings">${esc(pretty(a))}</span>`
  : `<span class="tag ab" style="background:${abilityColor(a)}">${esc(pretty(a))}</span>`;

// Pet picture from the community sprite server, with Gold/Rainbow applied. Discord's activity frame blocks outside
// images, so there (or if the image fails) it shows the species' initials instead.
const IS_DISCORD = /discordsays\.com$/.test(location.hostname);
const initials = (p) => esc(p.species.replace(/[^A-Z]/g, '').slice(0, 2) || p.species.slice(0, 2));
const petImg = (p, size = 40) => {
  const mut = p.mutations.filter((m) => m === 'Gold' || m === 'Rainbow');
  const fb = `<span class="pimg fb" style="width:${size}px;height:${size}px">${initials(p)}</span>`;
  if (IS_DISCORD) return fb;
  const url = `https://mg-api.ariedam.fr/assets/sprites/composed?key=${encodeURIComponent('sprite/pet/' + p.species)}${mut.length ? '&mutations=' + encodeURIComponent(mut.join(',')) : ''}`;
  return `<span class="pimg" style="width:${size}px;height:${size}px"><img src="${url}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('fb');this.parentNode.textContent='${initials(p)}'"></span>`;
};


// What each comparison category means, and how to show its value (expected effect at max strength, crystal included)
const CAT_INFO = {
  sell: ['Sell value', (v) => `+${v.toFixed(1)}% coins per crop`],
  xp: ['XP boost', (v) => `${Math.round(v)} XP/min`], eggGrowth: ['Egg growth', (v) => `${v.toFixed(2)} min saved/min`],
  plantGrowth: ['Plant growth', (v) => `${v.toFixed(2)} min saved/min`], cropSize: ['Crop size', (v) => `${v.toFixed(3)} size/min`],
  weatherMut: ['Weather mutations', (v) => `+${v.toFixed(1)}%`], amberMoonBoost: ['Amber Moon Boost', (v) => `+${v.toFixed(1)}% in Amber Moon`],
  hungerBoost: ['Hunger drain cut', (v) => `${v.toFixed(1)}%`], hungerRestore: ['Hunger restore', (v) => `${v.toFixed(2)}%/min`],
  petMut: ['Pet mutation chance', (v) => `+${v.toFixed(1)}%`], hatchXp: ['Hatch XP', (v) => `${Math.round(v)} XP/hatch`],
  hatchSize: ['Max strength boost', (v) => `${v.toFixed(2)}%/hatch`], doubleHatch: ['Double hatch', (v) => `${(v * 100).toFixed(2)}%`],
  petRefund: ['Pet refund', (v) => `${(v * 100).toFixed(2)}%`], doubleHarvest: ['Double harvest', (v) => `${(v * 100).toFixed(2)}%`],
  dust: ['Dust boost', (v) => `${v.toFixed(2)}%`], dawnbinder: ['Dawnbinder', (v) => `${v.toFixed(1)}%`],
  'capture:Thunder': ['Thundercharger', (v) => `strength ${Math.round(v * 100)}`], 'capture:Dawn': ['Dawn Capture', (v) => `strength ${Math.round(v * 100)}`],
  'capture:Amber': ['Amber Capture', (v) => `strength ${Math.round(v * 100)}`],
  'GOLD granter': ['Gold granter', (v) => `${(v * 100).toFixed(3)}%/min`], 'RAINBOW granter': ['Rainbow granter', (v) => `${(v * 100).toFixed(3)}%/min`],
};
const catLabel = (c) => CAT_INFO[c]?.[0] ?? (c.startsWith('granter:') ? c.slice(8) + ' granter' : c.startsWith('seedFinder') ? 'Seed Finder ' + c.slice(10) : c);
const catValue = (c, v) => v == null ? '—' : CAT_INFO[c] ? CAT_INFO[c][1](v) : c.startsWith('granter:') || c.startsWith('seedFinder') ? `${(v * 100).toFixed(2)}%/min` : v.toFixed(2);
const expanded = new Set();

// Strongest first; ties by bigger size
const byStr = (a, b) => (b.baseStr ?? 0) - (a.baseStr ?? 0) || b.scale - a.scale;
const listOrder = (a, b) => settings.sortBy === 'str' ? byStr(a, b) || a.species.localeCompare(b.species)
  : settings.sortBy === 'dust' ? (b.dust ?? 0) - (a.dust ?? 0) || byStr(a, b)
  : a.species.localeCompare(b.species) || byStr(a, b);
// Journal variants a pet counts for, and which of them aren't logged yet
const petVariants = (p) => {
  const v = [];
  if (p.mutations.includes('Rainbow')) v.push('Rainbow');
  if (p.mutations.includes('Gold')) v.push('Gold');
  if (!p.mutations.includes('Rainbow') && !p.mutations.includes('Gold')) v.push('Normal');
  const ms = MAX_SCALE_OF[p.species];
  if (ms && p.scale >= ms - 1e-9) v.push('Max Weight');
  return v;
};
const unloggedVariants = (p, journal) => {
  if (!journal) return petVariants(p); // can't read the journal: treat everything as unlogged (never sell blind)
  const logged = new Set((journal[p.species]?.variantsLogged ?? []).map((x) => x.variant));
  return petVariants(p).filter((v) => !logged.has(v));
};

// ---- live game data (mg-api.ariedam.fr, like QPM / Arie's Mod) ----
// Cached for a day. If it can't be fetched (e.g. Discord's activity blocks outside connections) the built-in data is used.
const LIVE_URL = 'https://mg-api.ariedam.fr/data/';
const LIVE_MAX_AGE = 24 * 60 * 60 * 1000;
let liveData = null, liveStatus = { source: 'built-in', at: null, error: null };
let liveNames = {};
const useLive = (d, at) => {
  liveData = { pets: d.pets, abilities: d.abilities, eggs: d.eggs, items: d.items, decors: d.decors, plants: d.plants };
  liveNames = Object.fromEntries(Object.entries((d.abilities && (d.abilities.data || d.abilities)) || {}).map(([id, a]) => [id, a && a.name]).filter(([, n]) => typeof n === 'string'));
  refreshRulesMeta(liveData);
  liveStatus = { source: 'live', at, error: null };
};
async function loadLiveData(force) {
  const cached = store.get('liveData', null);
  if (cached && cached.at && !force) {
    try { useLive(cached, cached.at); } catch {}
    // a copy saved by an older version may lack sections added since (items, decors, plants): refresh it then
    if (Date.now() - cached.at < LIVE_MAX_AGE && cached.items && cached.decors && cached.plants) return;
  }
  try {
    const doFetch = typeof W.fetch === 'function' ? W.fetch.bind(W) : fetch;
    const get = async (name) => { const r = await doFetch(LIVE_URL + name, { credentials: 'omit' }); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); };
    const [pets, abilities, eggs] = await Promise.all([get('pets'), get('abilities'), get('eggs')]);
    const [items, decors, plants] = await Promise.all([get('items').catch(() => null), get('decors').catch(() => null), get('plants').catch(() => null)]); // shop rules + prices only
    const fresh = { at: Date.now(), pets, abilities, eggs, items, decors, plants };
    useLive(fresh, fresh.at);
    store.set('liveData', fresh);
  } catch (e) {
    liveStatus = { ...liveStatus, error: String(e && e.message || e) };
    if (!liveData) refreshRulesMeta(undefined);
  }
  if (document.getElementById(ID)?.classList.contains('open')) { analyze(); render(); }
}

let result = null;
function analyze() {
  const data = game.readPets(settings.gardenOwner);
  if (!data) { result = null; return; }
  const opts = { ...settings, ignored: settings.ignored ?? DEFAULT_IGNORED_LIST, liveData: liveData || undefined };
  const r = analyzeRules(data.pets.map((p) => ({ ...p })), opts);
  // Your own filters on top of the model: pinned pets, always-keep species/abilities
  const keepBecause = (p) => settings.pinned.includes(p.id) ? 'you pinned it'
    : settings.keepSpecies.includes(p.species) ? `you keep all ${p.species}`
    : p.abilities.find((a) => settings.keepAbilities.includes(a)) ? `you keep ${pretty(p.abilities.find((a) => settings.keepAbilities.includes(a)))}` : null;
  const useless = [], keptByYou = [];
  for (const p of r.useless) { const why = keepBecause(p); if (why) keptByYou.push({ p, why }); else useless.push(p); }
  for (const p of r.pets) for (const [role, x] of Object.entries(p.roles || {})) x.beatenBy.sort((a, b) => byCompared(roleCatsOf(p, role))(b, a)); // better pets: biggest effect first
  useless.sort(listOrder); keptByYou.sort((x, y) => listOrder(x.p, y.p)); r.savedByName.sort(listOrder); r.savedByCollection.sort(listOrder);
  for (const p of r.pets) p.unlogged = unloggedVariants(p, data.journal);
  const journalPets = r.pets.filter((p) => p.unlogged.length).sort(listOrder);
  result = { ...r, useless, keptByYou, journalPets, journalReadable: !!data.journal, journal: data.journal, cropJournal: data.cropJournal, eggs: data.eggs ?? [], locked: data.locked, inventoryCount: data.inventoryCount };
  // A pet on one of the mod's best teams is never shown as useless (teams as they are now, and once every pet is
  // fully grown, i.e. the ones Level up is growing). Teams saved in the game don't count.
  const onTeam = new Map();
  for (const g of settings.teamsProtect === false ? [] : teamGoals()) {
    for (const p of bestTeam(g).team) if (!onTeam.has(p.id)) onTeam.set(p.id, `on the ${g.icon} ${g.title} team`);
    for (const p of withStr('all', () => bestTeam(g)).team) if (!onTeam.has(p.id)) onTeam.set(p.id, `on the ${g.icon} ${g.title} team once grown`);
  }
  const stillUseless = [];
  for (const p of useless) { const why = onTeam.get(p.id); if (why) keptByYou.push({ p, why }); else stillUseless.push(p); }
  result.useless = stillUseless;
  keptByYou.sort((x, y) => listOrder(x.p, y.p));
  // "Maybe sell": the same rules applied loosely (one fewer better pet needed; no collection, extra-copy, Gold or
  // same-species protections). Lists pets only those softer protections keep, with the reason. Named pets, your own
  // keep rules and pets on a best team stay out of it.
  const lax = analyzeRules(data.pets.map((p) => ({ ...p })), { ...opts,
    leaveOutThreshold: Math.max(1, (settings.leaveOutThreshold ?? 2) - (settings.maybeLooser ?? 1)), specificUseThreshold: Math.max(1, (settings.specificUseThreshold ?? 3) - (settings.maybeLooser ?? 1)),
    collectMutations: false, collectThreeAbility: false, tripleCompare: settings.collectThreeAbility !== false, collectUniqueMutated: false, extraCopies: false, mutSameSpecies: false, protectLongTermGold: false });
  const strictUseless = new Set(useless.map((p) => p.id));
  const roleWord = { leaveOut: 'left out', specificUse: 'specific use' };
  result.maybe = lax.useless.filter((lp) => !strictUseless.has(lp.id) && !onTeam.has(lp.id)).map((lp) => {
    const p = r.pets.find((q) => q.id === lp.id);
    if (!p || p.named || keepBecause(p)) return null;
    const why = p.collection ? collectionWhy(p)
      : p.goldMatters ? 'Gold with a long-term ability'
      : Object.entries(p.roles).filter(([, x]) => !x.deletable).map(([role, x]) => `${roleWord[role]}: ${x.beatenBy.length} better, needs ${x.threshold}`).join(' · ') || 'kept by a softer rule';
    return { p, why };
  }).filter(Boolean).sort((x, y) => listOrder(x.p, y.p));
}

// ---------- UI ----------
const ID = 'mgpc-panel';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STYLE = `
#${ID}{position:fixed;top:60px;right:16px;width:min(1180px,calc(100vw - 32px));max-width:calc(100vw - 24px);height:min(760px,calc(100vh - 80px));max-height:calc(100vh - 70px);z-index:10050;
  background:#1c1e23;color:#e8e6e1;font:13px/1.4 system-ui,sans-serif;border:1px solid #3a3d45;border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.55);
  display:none;flex-direction:column;overflow:hidden;resize:both}
#${ID}.open{display:flex}
#${ID}.min{height:auto!important;min-height:0;width:max-content!important;min-width:300px;resize:none}
#${ID}.min .hd,#${ID}.min .hd *{white-space:nowrap}
#${ID}.min .hd b{flex:none}
#${ID}.min .tabs,#${ID}.min .bar,#${ID}.min .body{display:none}
#${ID} .hd .minsum{display:none;font-size:12px;color:#a9abb2;white-space:nowrap}
#${ID}.min .hd .minsum{display:inline}
#${ID} .hd button.ic{width:28px;height:28px;padding:0;display:inline-flex;align-items:center;justify-content:center;font-size:16px;line-height:1}
#${ID} *{box-sizing:border-box}
#${ID} .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#25282e;cursor:move;user-select:none}
#${ID} .hd b{flex:1;font-size:14px}
#${ID} .hd .ver{font-weight:400;font-size:12px;color:#8d9098;margin-left:6px}
#${ID} button{background:#343842;color:#e8e6e1;border:1px solid #474b55;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}
#${ID} button:hover:not(:disabled){background:#41464f}
#${ID} button:disabled{opacity:.45;cursor:default}
#${ID} button.danger{background:#5a2b2b;border-color:#7a3a3a}
#${ID} button.danger:hover:not(:disabled){background:#6d3434}
#${ID} .tabs{display:flex;gap:4px;padding:8px 12px 0}
#${ID} .tabs button{border-radius:6px 6px 0 0;border-bottom:none}
#${ID} .tabs button.on{background:#1c1e23;border-color:#5bbf73;color:#fff}
#${ID} .tabs button.dragging{opacity:.45}
#${ID} .tabs button.dropl{box-shadow:inset 3px 0 0 #5bbf73}
#${ID} .tabs button.dropr{box-shadow:inset -3px 0 0 #5bbf73}
#${ID} .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-top:1px solid #30333a;border-bottom:1px solid #30333a;color:#a9abb2}
#${ID} .bar .grow{flex:1}
#${ID} .body{flex:1;overflow:auto;padding:0 0 8px}
#${ID} table{width:100%;border-collapse:collapse;font:inherit;color:inherit}
#${ID} th{position:sticky;top:0;background:#23262c;text-align:left;padding:6px 8px;font-size:12px;color:#b8bac0;z-index:1}
#${ID} td{padding:6px 8px;border-top:1px solid #2a2d33;vertical-align:top}
#${ID} tr:hover td{background:#22252b}
#${ID} .tag{display:inline-block;padding:1px 6px;border-radius:9px;font-size:11px;margin:1px 3px 1px 0;background:#2f343c}
#${ID} .tag.ab.ign,#mgpc-modal .tag.ab.ign{opacity:.4;text-decoration:line-through;text-decoration-thickness:1px}
#${ID} .tag.ab,#mgpc-modal .tag.ab{color:#fff;font-weight:600;text-shadow:0 1px 1px rgba(0,0,0,.45);display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;margin:1px 3px 1px 0}
.pimg{display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:8px;background:#2a2d34;overflow:hidden;vertical-align:middle}
.pimg img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated}
.pimg.fb{font:700 12px system-ui,sans-serif;color:#cfd2d8}
#${ID} .petcell{display:flex;gap:8px;align-items:flex-start}
#${ID} .note.ok{color:#8fc7a0;padding:6px 12px}
#${ID} .list{display:flex;flex-direction:column}
#${ID} .prow{display:grid;grid-template-columns:20px 44px minmax(0,1.2fr) 64px 72px minmax(0,1.5fr) 168px;gap:6px 12px;align-items:center;padding:8px 12px;border-top:1px solid #2a2d33}
#${ID} .prow{cursor:pointer}
#${ID} .prow .pmore{cursor:default}
#${ID} .prow:hover{background:#202329}
#${ID} .prow.open{background:#1f2227}
#${ID} .pname{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px}
#${ID} .pdust{text-align:right;line-height:1.1}
#${ID} .pstr{text-align:center;line-height:1.1}
#${ID} .whyline{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:1px 0}
#${ID} .bchip{display:inline-flex;align-items:center;gap:3px;padding:1px 6px 1px 1px;border-radius:12px;background:#2a2d34;font-size:12px;cursor:help}
#${ID} .bchip .pimg{border-radius:10px}
.locic{cursor:help;font-size:14px}
#${ID} b.str{font-size:16px;color:#fff}
#${ID} .cstr{font-size:12px;color:#8fb4d9;font-weight:600;white-space:nowrap}
#${ID} .pwhy{font-size:12px;line-height:1.45}
#${ID} .pact{display:flex;gap:6px;justify-content:flex-end;white-space:nowrap;min-width:0}
#${ID} .pinfo,#${ID} .pwhy{min-width:0}
#${ID} .pact button{padding:3px 9px}
#${ID} .pmore{grid-column:3 / -1;padding:4px 0 6px}
#${ID} .chip{display:inline-block;padding:0 6px;border-radius:8px;font-size:11px;background:#3a3222;color:#e6b35c;margin-left:4px}
#${ID} .chip.keep{background:#203a28;color:#8fc7a0}
#${ID} .chip.jr{background:#22304a;color:#9cc3ff}
#${ID} .sub{margin:6px 0 10px}
#${ID} .subh{margin-bottom:4px;color:#cfd2d8}
#${ID} .sub table{width:auto;min-width:60%;border:1px solid #2b2e35;border-radius:8px}
#${ID} .sub th{position:static;background:#202329;font-weight:600;white-space:nowrap;padding:5px 10px}
#${ID} .sub td{padding:5px 10px}
#${ID} .sub td.num{white-space:nowrap;text-align:right}
#${ID} .dpet{display:flex;gap:8px;align-items:center}
#${ID} .dnote{color:#e6c46a;margin:2px 0 6px;font-size:12px}
#${ID} .role{margin:6px 0 14px;padding-left:8px;border-left:3px solid #343842}
@media (max-width:820px){#${ID} .prow{grid-template-columns:20px 44px minmax(0,1fr) 64px}#${ID} .pwhy,#${ID} .pdust{grid-column:3 / -1}#${ID} .pact{grid-column:3 / -1;justify-content:flex-start}}
#${ID} .sub tr.self td{background:#2a2420}
#${ID} .muted{color:#8d9098;font-size:12px}
#${ID} .warn{color:#e6b35c}
#${ID} .note{padding:10px 12px;color:#e6b35c}
#${ID} .set details{margin-top:0}#${ID} .set summary{cursor:pointer;padding:4px 0;font-size:13px}#${ID} .set details[open]>summary{margin-bottom:4px}#${ID} .set{padding:12px;display:grid;gap:14px}
#${ID} .set h4{margin:0 0 6px;font-size:13px;color:#fff}
#${ID} .set label{display:flex;gap:6px;align-items:center;margin:3px 0}
#${ID} .set input[type=number]{width:64px}
#${ID} input,#${ID} select,#${ID} textarea{background:#14161a;color:#e8e6e1;border:1px solid #3a3d45;border-radius:6px;padding:4px 6px;font:inherit}
#${ID} .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:2px 10px}
#mgpc-shopfab{position:fixed;left:14px;bottom:62px;z-index:2147483645;min-width:40px;height:40px;padding:0 10px;border-radius:20px;border:1px solid #474b55;background:#25282e;color:#9a9da5;font:600 14px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);opacity:.75}
#mgpc-teamfab{position:fixed;left:14px;bottom:110px;z-index:2147483645;height:40px;padding:0 12px;border-radius:20px;border:1px solid #6f8fd6;background:#2b4a8a;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);display:none}
#mgpc-teamfab.show{display:block}
#mgpc-shopfab.can{background:#c0392b;border-color:#e74c3c;color:#fff;cursor:pointer;opacity:1;animation:mgpcPulse 2s ease-in-out infinite}
@keyframes mgpcPulse{0%,100%{box-shadow:0 4px 14px rgba(0,0,0,.4)}50%{box-shadow:0 0 0 4px rgba(231,76,60,.35),0 4px 14px rgba(0,0,0,.4)}}
#mgpc-fab{position:fixed;left:14px;bottom:14px;z-index:2147483645;width:40px;height:40px;border-radius:50%;border:1px solid #474b55;background:#25282e;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)}
#mgpc-toasts{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}#mgpc-toasts .mgpc-toast{pointer-events:auto}
.mgpc-toast{position:relative;max-width:360px;display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:12px;background:#24301f;border:1px solid #5bbf73;color:#e8e6e1;font:13px/1.45 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)}
.mgpc-toast button{background:none;border:none;color:#e8e6e1;cursor:pointer;font-size:14px}
#mgpc-modal .buylist{max-height:46vh;overflow:auto;display:flex;flex-direction:column;gap:10px}
#mgpc-modal.shopdlg .card{overflow:hidden}
#mgpc-modal.shopdlg .card > *{flex:none}
#mgpc-modal.shopdlg .buyarea{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:6px}
#mgpc-modal.shopdlg .buyarea .buylist{flex:1 1 auto;min-height:70px;max-height:none}
#mgpc-modal.shopdlg .st{max-height:22vh;overflow:auto}
#mgpc-modal.shopdlg details.rules summary{cursor:pointer}
#mgpc-modal .buytiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px;margin-top:4px}
#mgpc-modal .buytile{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 4px;border-radius:8px;background:#2a2d34}
#mgpc-modal .buytile .bq{position:absolute;top:3px;right:5px;font:700 11px system-ui,sans-serif;color:#fff;text-shadow:0 1px 2px #000}
#mgpc-modal .buytile{cursor:pointer;user-select:none}
#${ID} .tag.buytog{cursor:pointer}
#mgpc-modal .buytile:hover{outline:1px solid #5bbf73}
#mgpc-modal .buytile.off{opacity:.4;filter:grayscale(1)}
#mgpc-modal .buytile .bd{font-size:10px;color:#e6c46a}
#mgpc-modal .buytile .bn{font-size:11px;color:#cfd2d8;text-align:center;line-height:1.15;overflow:hidden;text-overflow:ellipsis;max-width:100%;white-space:nowrap}
#mgpc-modal .pimg,#mgpc-panel .shopitems .pimg{background:transparent}
#mgpc-panel .shopitems .tag{display:inline-flex;align-items:center;gap:4px}
#mgpc-modal.shopdlg .card{background:#1a1c21;border:2px solid #3a3d45;transition:background .4s,border-color .4s}
#mgpc-modal.shopdlg.ready .card{background:#5a1717;border-color:#ff5a4a;animation:mgpcReady 1.6s ease-in-out infinite}
#mgpc-modal.shopdlg.buying .card{background:#13284a;border-color:#4a8dff}
@keyframes mgpcReady{0%,100%{box-shadow:0 0 0 0 rgba(255,90,74,.55),0 20px 60px rgba(0,0,0,.6)}50%{box-shadow:0 0 0 10px rgba(255,90,74,0),0 20px 60px rgba(0,0,0,.6)}}
#mgpc-modal.shopdlg .state{font:700 13px system-ui,sans-serif;padding:2px 8px;border-radius:10px;background:#2a2d34;color:#cfd2d8}
#mgpc-modal.shopdlg.ready .state{background:#ff5a4a;color:#fff}
#mgpc-modal.shopdlg.buying .state{background:#4a8dff;color:#fff}
#mgpc-modal .shopdlg-hd{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
#mgpc-modal.shopdlg .buytile{background:rgba(255,255,255,.06)}
#mgpc-modal .dusttoggle{display:flex;gap:8px;align-items:center;cursor:pointer;color:#e6c46a}
#${ID} tr.lvlrow .grip{cursor:grab;color:#7d818a;padding:0 4px;user-select:none}
#${ID} tr.lvlrow.dragging{opacity:.4}
#${ID} tr.dropabove td{box-shadow:inset 0 2px 0 #5bbf73}
#${ID} tr.dropbelow td{box-shadow:inset 0 -2px 0 #5bbf73}
#mgpc-modal .sellwarn{padding:10px 12px;border-radius:10px;background:#5a1717;border:2px solid #ff5a4a;color:#fff}
#mgpc-modal .sellwarn .big{font:700 15px system-ui,sans-serif;margin-bottom:4px}
#mgpc-modal .sellwarn ul{margin:4px 0 6px;padding-left:18px}
#mgpc-modal .sellwarn button.main{background:#fff;color:#5a1717;border-color:#fff;font-weight:700}
#mgpc-modal .sellwarn .sellteam{display:flex;gap:6px;align-items:center;margin:6px 0 2px}
#mgpc-modal .sellwarn select{background:#3a1010;color:#fff;border:1px solid #ff8a7d;border-radius:6px;padding:2px 4px}
#mgpc-modal .sellwarn.ok{background:#1f3a26;border-color:#5bbf73}
#${ID} .cropf{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
#${ID} .cropf button.on{background:#2f6b42;border-color:#5bbf73;color:#fff}
#${ID} .croplist{display:flex;flex-wrap:wrap;gap:6px}
#${ID} .cropc{display:inline-flex;align-items:center;gap:4px;padding:2px 8px 2px 2px;border-radius:12px;background:#2a2d34}
#mgpc-modal .warnbox{padding:8px 10px;border-radius:8px;background:#3a2f17;border:1px solid #8a6d2a;color:#f0d18a}
#mgpc-crystal{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;font:14px/1.45 system-ui,sans-serif;color:#fff}
#mgpc-crystal .card{width:min(440px,92vw);display:flex;flex-direction:column;gap:12px;background:#5a1717;border:2px solid #ff5a4a;border-radius:14px;padding:18px 20px;box-shadow:0 14px 44px rgba(0,0,0,.6)}
#mgpc-crystal .big{font:700 20px/1.25 system-ui,sans-serif}
#mgpc-crystal label{display:flex;gap:8px;align-items:center;cursor:pointer;color:#f3d0cc}
#mgpc-crystal .acts{display:flex;gap:8px;justify-content:flex-end}
#mgpc-crystal button{border-radius:8px;padding:7px 14px;font:600 13px system-ui,sans-serif;cursor:pointer;border:1px solid #ff8a7d;background:#7a2222;color:#fff}
#mgpc-planthint{position:fixed;z-index:2147483640;transform:translate(-50%,-100%);display:none;gap:4px;align-items:center;padding:4px 8px;border-radius:10px;background:rgba(20,22,26,.82);color:#e8e8e8;font:600 12px system-ui,sans-serif;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#mgpc-mounthint{position:fixed;left:50%;top:12px;z-index:2147483640;transform:translateX(-50%);display:none;gap:10px;align-items:center;padding:5px 12px;border-radius:10px;background:rgba(20,22,26,.85);color:#e8e8e8;font:600 13px system-ui,sans-serif;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4)}#mgpc-mounthint .t{opacity:.8}
#mgpc-planthint .t{margin-right:2px;opacity:.85}#mgpc-planthint .v{display:inline-flex}
#mgpc-crystal .hteams{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}
#mgpc-crystal .note{font-size:12px;color:#f3d0cc}
#mgpc-crystal .msg{font-size:13px;color:#ffe08a;min-height:0}
#mgpc-crystal button.main{background:#fff;color:#5a1717;border-color:#fff;padding:9px 22px;font-size:14px}
#mgpc-crystal .foot{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-top:6px;font-size:12px}
#mgpc-crystal .anyway{color:#e8a8a0;font-size:11px;text-decoration:underline;opacity:.8;white-space:nowrap}
#mgpc-modal{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font:13px/1.4 system-ui,sans-serif;color:#e8e6e1}
#mgpc-modal .card{width:min(560px,94vw);max-height:84vh;display:flex;flex-direction:column;gap:10px;background:#16181c;border:1px solid #3a3d45;border-radius:14px;padding:16px 18px}
#mgpc-modal .list{overflow:auto;display:grid;gap:4px;max-height:48vh}
#mgpc-modal .row{padding:5px 8px;border:1px solid #2b2e35;border-radius:8px;background:#1d2025}
#mgpc-modal .row.ok{border-color:#2f6b40}#mgpc-modal .row.bad{border-color:#7a3a3a}
#mgpc-modal .acts{display:flex;justify-content:flex-end;gap:8px}
#${ID} .teams{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px;padding:10px 12px;align-items:start}
#${ID} .team.wide{grid-column:1/-1}
#${ID} .team{border:1px solid #30333a;border-radius:10px;padding:10px 12px;background:#202329}
#${ID} .thd{display:flex;align-items:center;gap:10px;margin-bottom:2px;flex-wrap:wrap}
#${ID} .thd b{font-size:14px;flex:1}
#${ID} .thd .tval{order:3;flex-basis:100%;color:#8fc7a0;font-weight:600}
#${ID} .tpets{display:flex;flex-direction:column;gap:4px;margin-top:6px}
#${ID} .team.wide .tpets{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
#${ID} .tpet{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:8px;background:#25282e}
#${ID} .tpet .tl{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;min-width:0}
#${ID} .tpet .tl .muted{font-size:12px}
#${ID} .team .why{font-size:12px;line-height:1.35}
#${ID} .tpet.out{outline:1px solid #3d6b4a}
#${ID} .warn{color:#e6c46a}
#${ID} .jplan{margin-top:8px}
#${ID} .jplan td{vertical-align:middle}
#${ID} .jplan tr.ready td{background:#1f2a22}
#${ID} .tag.have{opacity:.55}
#${ID} .shopitems{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
#${ID} .lvlprio{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0 2px}
#${ID} .lchip{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 8px;border-radius:12px;background:#2a2e36}
#${ID} .lchip.off{opacity:.45;text-decoration:line-through}
#${ID} button.mini{padding:0 6px;height:20px;font-size:11px;line-height:1;border-radius:10px}
#${ID} button.mini.on{background:#3d6b4a}
#mgpc-modal button{background:#343842;color:#e8e6e1;border:1px solid #474b55;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
#mgpc-modal button.danger{background:#5a2b2b;border-color:#7a3a3a}`;

let tab = 'useless';
const selected = new Set();
let busy = false;

// Where the 🐾 button sits (🛒 and 🧪 stack above it); kept on screen
let fabDragged = false;
const fabPos = () => ({ left: 14, bottom: 14, ...(store.get('fabPos', null) || {}) });
function setFabPos(pos, save) {
  const left = Math.max(0, Math.min(innerWidth - 44, Math.round(pos.left))), bottom = Math.max(0, Math.min(innerHeight - 140, Math.round(pos.bottom)));
  [['mgpc-fab', 0], ['mgpc-shopfab', 48], ['mgpc-teamfab', 96]].forEach(([id, up]) => {
    const b = document.getElementById(id); if (b) { b.style.left = left + 'px'; b.style.bottom = (bottom + up) + 'px'; }
  });
  if (save) store.set('fabPos', { left, bottom });
}
addEventListener('resize', () => { if (document.getElementById('mgpc-fab')) setFabPos(fabPos(), false); });
// Until you've dragged them yourself, the buttons step right, past other mods' buttons in that corner (e.g. Garden
// Companion, Vaxen's Fav Rooms). Anything covering most of the screen (the game's own layers) doesn't count.
function fabsCovered() {
  const mine = ['mgpc-fab', 'mgpc-shopfab', 'mgpc-teamfab'].map((id) => document.getElementById(id)).filter((b) => b && getComputedStyle(b).display !== 'none');
  const big = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height > innerWidth * innerHeight * 0.3; };
  for (const b of mine) {
    const r = b.getBoundingClientRect();
    for (const [x, y] of [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 4, r.top + 4], [r.right - 4, r.bottom - 4], [r.left + 4, r.bottom - 4], [r.right - 4, r.top + 4]]) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (mine.some((m) => m === el || m.contains(el))) continue;
        if (el === document.documentElement || el === document.body || el.tagName === 'CANVAS' || big(el)) continue;
        if (el.closest?.('#mgpc-panel, #mgpc-modal, #mgpc-crystal')) continue;
        return true;
      }
    }
  }
  return false;
}
function avoidOtherButtons() {
  if (store.get('fabPos', null)) return; // you placed them yourself
  const base = fabPos();
  for (let left = base.left; left < Math.min(innerWidth - 60, 600); left += 24) {
    setFabPos({ left, bottom: base.bottom }, false);
    if (!fabsCovered()) return;
  }
  setFabPos(base, false); // nowhere clear: leave them where they were
}
function mount() {
  if (document.getElementById(ID)) return;
  const style = document.createElement('style'); style.textContent = STYLE; document.head.appendChild(style);
  const fab = document.createElement('button'); fab.id = 'mgpc-fab'; fab.title = `Lategame Helper v${MOD_VERSION} (Alt+P)`; fab.textContent = '🐾';
  if (settings.fabDrag !== false) fab.title += ' · drag to move these buttons';
  fab.onclick = (e) => { fab.blur(); if (fabDragged) { fabDragged = false; e.preventDefault(); return; } toggle(); }; document.body.appendChild(fab);
  // Drag 🐾 to move the 🐾 / 🛒 / 🧪 buttons together (e.g. off another mod's buttons); the spot is remembered
  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || settings.fabDrag === false) return;
    const start = { x: e.clientX, y: e.clientY, ...fabPos() };
    let last = null;
    const move = (ev) => {
      const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
      if (!fabDragged && Math.hypot(dx, dy) < 6) return;
      fabDragged = true;
      last = { left: start.left + dx, bottom: start.bottom - dy }; setFabPos(last, false);
    };
    const up = () => { removeEventListener('pointermove', move, true); removeEventListener('pointerup', up, true); if (fabDragged && last) setFabPos(last, true); setTimeout(() => { fabDragged = false; }, 50); };
    addEventListener('pointermove', move, true); addEventListener('pointerup', up, true);
  });
  const sfab = document.createElement('button'); sfab.id = 'mgpc-shopfab'; sfab.textContent = '🛒';
  sfab.onclick = (e) => { sfab.blur(); if (e.isTrusted || TEST_BUILD) startShopBuy(); }; // always opens; the dialog waits for a restock if there's nothing to buy
  document.body.appendChild(sfab);
  updateShopFab();
  const tfab = document.createElement('button'); tfab.id = 'mgpc-teamfab';
  // 💰 part → the Useless tab (pets to sell); the rest → Teams
  tfab.onclick = (e) => { tfab.blur(); openTab(e.target.closest?.('[data-go]')?.dataset.go || tfab.dataset.main || 'teams'); };
  document.body.appendChild(tfab);
  setFabPos(fabPos(), false);
  // other mods add their buttons a bit later: check a few times
  [500, 2000, 5000, 10000, 20000].forEach((ms) => setTimeout(() => { try { avoidOtherButtons(); } catch {} }, ms));
  updateTeamFab();
  const el = document.createElement('div'); el.id = ID;
  el.innerHTML = `<div class="hd"><b>🐾 Lategame Helper <span class="ver">v${MOD_VERSION}</span></b><button data-a="refresh" title="Re-read your pets">Refresh</button><button data-a="join5" title="Join a public room with 5 players (room list from Arie's Mod API)">👥 5-player room</button><span class="minsum"></span><button data-a="minimize" class="ic" title="Minimize">−</button><button data-a="close" class="ic" title="Close (Alt+P)">✕</button></div>
    <div class="tabs"></div><div class="bar"></div><div class="body"></div>`;
  document.body.appendChild(el);
  setMinimized(store.get("minimized", false));
  ['keydown', 'keyup', 'keypress'].forEach((t) => el.addEventListener(t, (e) => e.stopPropagation()));
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  // Tabs: drag one onto another to reorder them; the order is saved in settings.tabOrder
  let dragTab = null;
  const clearTabMarks = () => el.querySelectorAll('.tabs button.dropl, .tabs button.dropr, .tabs button.dragging').forEach((x) => x.classList.remove('dropl', 'dropr', 'dragging'));
  el.addEventListener('dragstart', (e) => {
    const t = e.target.closest?.('.tabs button[data-tab]'); if (!t) return;
    if (settings.featTabOrder === false) { e.preventDefault(); return; }
    dragTab = t.dataset.tab; t.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragTab); } catch {}
  });
  el.addEventListener('dragover', (e) => {
    const t = e.target.closest?.('.tabs button[data-tab]'); if (!dragTab || !t) return;
    e.preventDefault();
    el.querySelectorAll('.tabs button.dropl, .tabs button.dropr').forEach((x) => x.classList.remove('dropl', 'dropr'));
    const r = t.getBoundingClientRect();
    if (t.dataset.tab !== dragTab) t.classList.add(e.clientX < r.left + r.width / 2 ? 'dropl' : 'dropr');
  });
  el.addEventListener('dragend', () => { dragTab = null; clearTabMarks(); });
  el.addEventListener('drop', (e) => {
    const t = e.target.closest?.('.tabs button[data-tab]'); if (!dragTab || !t) return;
    e.preventDefault();
    const after = t.classList.contains('dropr');
    const order = [...el.querySelectorAll('.tabs button[data-tab]')].map((x) => x.dataset.tab).filter((k) => k !== dragTab);
    if (t.dataset.tab !== dragTab) { order.splice(order.indexOf(t.dataset.tab) + (after ? 1 : 0), 0, dragTab); settings.tabOrder = order; saveSettings(); }
    dragTab = null; clearTabMarks(); render();
  });
  // Level up queue: drag a row by its ⠿ handle to reorder. Dropping pins the rows down to where it landed, in that
  // order (pinned pets grow first), so the new order sticks.
  let dragId = null, fromGrip = false;
  el.addEventListener('mousedown', (e) => { fromGrip = !!e.target.closest('.grip'); });
  el.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('tr[data-lvlrow]');
    if (!row || !fromGrip) { if (row) e.preventDefault(); return; }
    dragId = row.dataset.lvlrow; row.classList.add('dragging');
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); } catch {}
  });
  el.addEventListener('dragover', (e) => {
    const row = e.target.closest?.('tr[data-lvlrow]'); if (!dragId || !row) return;
    e.preventDefault();
    el.querySelectorAll('tr.dropabove, tr.dropbelow').forEach((r) => r.classList.remove('dropabove', 'dropbelow'));
    const r = row.getBoundingClientRect();
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'dropabove' : 'dropbelow');
  });
  el.addEventListener('dragend', () => { dragId = null; el.querySelectorAll('tr.dragging, tr.dropabove, tr.dropbelow').forEach((r) => r.classList.remove('dragging', 'dropabove', 'dropbelow')); });
  el.addEventListener('drop', (e) => {
    const row = e.target.closest?.('tr[data-lvlrow]'); if (!dragId || !row) return;
    e.preventDefault();
    const ids = [...el.querySelectorAll('tr[data-lvlrow]')].map((r) => r.dataset.lvlrow).filter((id) => id !== dragId);
    let at = ids.indexOf(row.dataset.lvlrow);
    if (row.dataset.lvlrow === dragId) at = [...el.querySelectorAll('tr[data-lvlrow]')].findIndex((r) => r.dataset.lvlrow === dragId);
    else if (row.classList.contains('dropbelow')) at += 1;
    ids.splice(Math.max(0, at), 0, dragId);
    const pinned = settings.levelPinned ?? [];
    const lastPinned = ids.reduce((m, id, i) => (pinned.includes(id) ? i : m), -1);
    settings.levelPinned = [...ids.slice(0, Math.max(at, lastPinned) + 1), ...pinned.filter((id) => !ids.includes(id))];
    dragId = null; saveSettings(); render();
  });
  // drag by header
  const hd = el.querySelector('.hd');
  hd.addEventListener('dblclick', (e) => { if (e.target.tagName !== 'BUTTON') setMinimized(!el.classList.contains('min')); });
  hd.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const r = el.getBoundingClientRect(), sx = e.clientX, sy = e.clientY;
    const mv = (ev) => { el.style.left = r.left + ev.clientX - sx + 'px'; el.style.top = r.top + ev.clientY - sy + 'px'; el.style.right = 'auto'; keepOnScreen(); };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  });
}
// ---- Window stacking alongside QPM / Arie's Mod windows ----
// Clicking our panel brings it to the front; clicking another mod's floating window lets that one sit on top.
// The confirm dialog always stays above everything.
const Z_CAP = 2147483000;
const zOf = (n) => { const z = parseInt(getComputedStyle(n).zIndex, 10); return Number.isFinite(z) ? z : null; };
// The outermost fixed/absolute element with a z-index around the click: that's the 'window' that was clicked
function overlayOf(node) {
  let hit = null;
  for (let n = node; n && n !== document.body && n.nodeType === 1; n = n.parentElement || n.getRootNode?.().host) {
    const cs = getComputedStyle(n);
    if ((cs.position === 'fixed' || cs.position === 'absolute') && zOf(n) !== null && cs.display !== 'none') hit = n;
  }
  return hit;
}
function topZ(except) {
  let max = 0;
  for (const n of document.body.querySelectorAll('body > *, body > * > *')) {
    if (n === except || except.contains(n) || n.id === 'mgpc-fab' || n.id === 'mgpc-shopfab' || n.id === 'mgpc-teamfab' || n.id === 'mgpc-modal') continue;
    const cs = getComputedStyle(n);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const z = zOf(n); if (z !== null && z < Z_CAP) max = Math.max(max, z);
  }
  return max;
}
function bringToFront() {
  const el = document.getElementById(ID); if (!el) return;
  const want = Math.min(Z_CAP, topZ(el) + 1), cur = zOf(el) ?? 0;
  if (want > cur) el.style.zIndex = String(want);
}
document.addEventListener('pointerdown', (e) => {
  const el = document.getElementById(ID); if (!el || !el.classList.contains('open')) return;
  const target = e.composedPath?.()[0] || e.target;
  if (el.contains(target)) return bringToFront();
  if (target.closest?.('#mgpc-modal, #mgpc-fab, #mgpc-shopfab, #mgpc-teamfab')) return;
  const win = overlayOf(target); if (!win || win.contains(el)) return; // a click on the game itself changes nothing
  const z = zOf(win), mine = zOf(el) ?? 0;
  // Only other mods' floating windows (they sit at z-index 1000+); the game's own bars and menus never push us back
  if (z !== null && z >= 1000 && z <= mine) el.style.zIndex = String(Math.max(1000, z - 1)); // step behind the window you clicked
}, true);

// The whole panel always stays inside the window (minimized or not)
function keepOnScreen() {
  const el = document.getElementById(ID); if (!el || !el.classList.contains('open')) return;
  const vw = document.documentElement.clientWidth || innerWidth, vh = document.documentElement.clientHeight || innerHeight;
  let r = el.getBoundingClientRect();
  if (!el.classList.contains('min')) {
    if (r.width > vw - 8) el.style.width = (vw - 16) + 'px';
    if (r.height > vh - 8) el.style.height = (vh - 16) + 'px';
    r = el.getBoundingClientRect();
  }
  const top = Math.round(Math.min(Math.max(0, r.top), Math.max(0, vh - r.height)));
  const left = Math.round(Math.min(Math.max(0, r.left), Math.max(0, vw - r.width)));
  if (top !== Math.round(r.top) || left !== Math.round(r.left)) { el.style.top = top + 'px'; el.style.left = left + 'px'; el.style.right = 'auto'; }
}
addEventListener('resize', () => keepOnScreen());
setInterval(keepOnScreen, 2000); // e.g. after zooming the page

function setMinimized(on) {
  const el = document.getElementById(ID); if (!el) return;
  el.classList.toggle("min", on); store.set("minimized", on);
  const b = el.querySelector('[data-a="minimize"]'); b.textContent = on ? "▢" : "−"; b.title = on ? "Restore" : "Minimize";
  keepOnScreen();
}
// Open/close the panel (🐾 button or Alt+P)
// Open the panel straight on one tab (used by the 🧪 button)
function openTab(name) {
  mount(); const el = document.getElementById(ID);
  tab = name;
  if (!el.classList.contains('open')) { el.classList.add('open'); keepOnScreen(); bringToFront(); }
  if (el.classList.contains('min')) setMinimized(false);
  analyze(); render();
}
// Closed → opens expanded; open but minimized → expands; open and expanded → closes
function toggle() {
  mount(); const el = document.getElementById(ID);
  if (el.classList.contains('open') && el.classList.contains('min')) { setMinimized(false); keepOnScreen(); bringToFront(); analyze(); render(); return; }
  el.classList.toggle('open');
  if (el.classList.contains('open')) { if (el.classList.contains('min')) setMinimized(false); keepOnScreen(); bringToFront(); analyze(); render(); }
}
document.addEventListener('keydown', (e) => { if (e.altKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); toggle(); } }, true);

let renderQueued = false;
// What the panel shows, boiled down: only redraw when this changes (the game sends updates many times a second)
const viewSignature = () => !result ? 'none' : JSON.stringify([
  result.useless.map((p) => p.id + p.loc), result.keptByYou.map(({ p }) => p.id + p.loc),
  result.savedByName.map((p) => p.id), result.savedByCollection.map((p) => p.id), [...result.locked].sort(), result.pets.length, (result.maybe ?? []).map((x) => x.p.id + x.p.loc),
  result.pets.filter((p) => p.loc === 'garden').map((p) => p.id), teamBusy, JSON.stringify(teamMsg), logBusy, JSON.stringify(logMsg), movedForLog.size, tab === 'shop' ? JSON.stringify(game.readShops(settings.gardenOwner)?.map((x) => x.items.map((i) => i.left))) : '', shopBusy,
]);
let lastSignature = '';
game.onChange(() => {
  const el = document.getElementById(ID);
  if (!el || !el.classList.contains('open') || busy || renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    // never redraw while you're typing or picking in the panel
    const a = document.activeElement;
    if (a && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox') return;
    analyze();
    const sig = viewSignature();
    if (sig === lastSignature) return;
    render();
  }, 500);
});

function render() {
  const el = document.getElementById(ID); if (!el) return;
  const tabs = el.querySelector('.tabs'), bar = el.querySelector('.bar'), body = el.querySelector('.body');
  { const j = el.querySelector('[data-a="join5"]'); if (j) j.style.display = settings.featJoin5 === false ? 'none' : ''; }
  lastSignature = viewSignature();
  const keepScroll = body.scrollTop;
  requestAnimationFrame(() => { body.scrollTop = keepScroll; }); // stay where you were scrolled
  if (!game.ready()) { tabs.innerHTML = ''; bar.innerHTML = ''; body.innerHTML = '<div class="note">Waiting for the game… join your garden.</div>'; return; }
  if (!result) {
    tabs.innerHTML = ''; bar.innerHTML = '';
    if (game.noGardenHere?.()) { body.innerHTML = '<div class="note">You don\'t have a garden in this room (it may be full, so you\'re watching). Join a room with a free spot to use the helper.</div>'; return; }
    if (!game.gardens().length) { body.innerHTML = '<div class="note">Waiting for the room to load…</div>'; return; }
    body.innerHTML = `<div class="note">Couldn't tell which garden is yours. Pick it:</div><div style="padding:0 12px">
      <select data-f="gardenOwner"><option value="">—</option>${game.gardens().map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')}</select></div>`;
    return;
  }
  el.querySelector(".minsum").textContent = `${result.useless.length} useless · ~${result.useless.reduce((t, p) => t + (p.dust || 0), 0).toLocaleString()} dust`;
  const n = { useless: result.useless.length, kept: result.savedByName.length + result.savedByCollection.length + result.keptByYou.length, journal: result.journalPets.length };
  const tabList = [['useless', `Useless (${n.useless})`], ['kept', `Kept anyway (${n.kept})`], ['maybe', `🤔 Maybe sell (${result.maybe?.length ?? 0})`], ['journal', `📖 Journal (${n.journal})`], ['teams', '🧪 Teams'], ['shop', '🛒 Shop'], ['settings', 'Settings']];
  const tabRank = (k) => { const i = settings.featTabOrder === false ? -1 : (settings.tabOrder ?? []).indexOf(k); return i < 0 ? 100 + tabList.findIndex(([x]) => x === k) : i; };
  const drag = settings.featTabOrder === false ? '' : ' draggable="true" title="Drag to reorder"';
  tabs.innerHTML = tabList.sort(([a], [b]) => tabRank(a) - tabRank(b))
    .map(([k, t]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}"${drag}>${t}</button>`).join('');
  if (tab === 'useless') renderUseless(bar, body);
  else if (tab === 'kept') renderKept(bar, body);
  else if (tab === 'maybe') renderMaybe(bar, body);
  else if (tab === 'journal') renderJournal(bar, body);
  else if (tab === 'teams') renderTeams(bar, body);
  else if (tab === 'shop') renderShop(bar, body);
  else renderSettings(bar, body);
}

// Why a pet can't be sold right now (null = it can)
const sellBlock = (p) => p.loc === 'garden' ? 'In your garden: pick it up first to sell it.'
  : result.locked.has(p.id) ? 'Locked: click Unlock first.'
  : !result.journalReadable ? "Can't read your journal, so selling is held back to be safe."
  : p.unlogged?.length ? `Not in your journal yet (${p.unlogged.join(', ')}): log it first.` : null;

// ---- shared row layout (Useless and Kept anyway) ----
// Better pets as small chips: picture, where it is, max STR (full name on hover)
const betterChip = (q) => `<span class="bchip" title="${esc(label(q))} · ${(LOC[q.loc] || [q.loc, q.loc])[1]}${result.locked.has(q.id) ? ' · locked' : ''}">${petImg(q, 20)}${(LOC[q.loc] || ['?'])[0]}<b>${q.baseStr ?? '?'}</b></span>`;
// The "N better" summary shown on each pet row, per role
const whyCell = (p) => Object.keys(p.roles).length
  ? Object.entries(p.roles).map(([role, x]) => `<div class="whyline"><span class="muted">${role === 'leaveOut' ? 'Left out' : 'Specific use'}</span> <b>${x.beatenBy.length} better</b> ${x.beatenBy.slice(0, 4).map(betterChip).join('')}${x.beatenBy.length > 4 ? `<span class="muted">+${x.beatenBy.length - 4}</span>` : ''}</div>`).join('')
  : '<span class="muted">No useful abilities under your rules</span>';

// opts: { ready, kept: 'reason it is kept' | undefined, pinned: bool }
function petRow(p, opts) {
  const { ready, kept, pinned, maybe } = opts;
  const block = sellBlock(p);
  const locked = result.locked.has(p.id);
  let actions;
  if (kept) {
    actions = pinned ? `<button data-unpin="${esc(p.id)}" title="Stop always keeping this pet">Unpin</button>` : '';
  } else {
    actions = (locked && p.loc !== 'garden'
      ? `<button data-unlock="${esc(p.id)}" ${ready.ok ? '' : 'disabled'} title="Unlock it in-game (same as its padlock). Then you can sell it.">🔓 Unlock</button>`
      : `<button data-sellone="${esc(p.id)}" class="danger" ${block || !ready.ok ? 'disabled' : ''} title="${esc(block || (ready.ok ? 'Sell just this pet (asks to confirm)' : ready.reason))}">Sell</button>`)
      + `<button data-pin="${esc(p.id)}" title="Always keep this pet">Keep</button>`;
  }
  const lead = kept || maybe
    ? `<span></span>`
    : `<input type="checkbox" data-sel="${esc(p.id)}" ${selected.has(p.id) ? 'checked' : ''} ${block ? 'disabled' : ''} title="${esc(block || 'Tick to sell several at once')}">`;
  return `<div class="prow${expanded.has(p.id) ? ' open' : ''}" data-loc="${p.loc}" data-id="${esc(p.id)}" title="Click for details">
    ${lead}
    ${petImg(p)}
    <div class="pinfo"><div class="pname">${locIcon(p.loc)} <b>${esc(nameOnly(p))}</b>${maybe ? ` <span class="chip jr" title="Why it's kept under the normal rules">🤔 ${esc(maybe)}</span>` : ''}${p.named ? ` <span class="muted">"${esc(p.name)}"</span>` : ''}${locked ? ' <span class="chip" title="Locked in-game.">🔒 locked</span>' : ''}${p.loc === 'garden' ? ' <span class="chip" title="Active pet: pick it up first to sell it.">active</span>' : ''}${p.unlogged?.length && !(kept || '').startsWith('needs:') ? ` <span class="chip jr" title="Not in your journal yet — log it in the 📖 Journal tab">📖 needs: ${esc(p.unlogged.join(', '))}</span>` : ''}${kept ? (kept.startsWith('needs:') ? ` <span class="chip jr" title="Not in your journal yet">📖 ${esc(kept)}</span>` : ` <span class="chip keep" title="Why it's kept">✓ ${esc(kept)}</span>`) : ''}</div>
      <div>${abilityTags(p)}</div></div>
    <div class="pstr">${strCell(p)}<div class="muted">max STR</div></div>
    <div class="pdust"><b>${p.dust != null ? p.dust.toLocaleString() : '?'}</b><div class="muted">dust</div></div>
    <div class="pwhy">${whyCell(p)}</div>
    <div class="pact">${actions}<button data-more="${esc(p.id)}" title="${expanded.has(p.id) ? 'Hide details' : 'Show details'}">${expanded.has(p.id) ? '▴' : '▾'}</button></div>
    ${expanded.has(p.id) ? `<div class="pmore">${details(p)}</div>` : ''}
  </div>`;
}

function renderUseless(bar, body) {
  const ready = net.readiness(true);
  for (const id of [...selected]) if (!result.useless.find((p) => p.id === id && !sellBlock(p))) selected.delete(id);
  const sellable = result.useless.filter((p) => !sellBlock(p));
  const dustOf = (list) => list.reduce((t, p) => t + (p.dust || 0), 0).toLocaleString();
  const selectedPets = result.useless.filter((p) => selected.has(p.id));
  bar.innerHTML = `<span class="grow"><b>${result.useless.length}</b> useless of ${result.pets.length} · all shown: <b>~${dustOf(result.useless)} dust</b> · ${sellable.length} sellable now${selectedPets.length ? ` · ticked: ~${dustOf(selectedPets)} dust` : ''}</span>
    <span class="muted" title="Where each pet is">🎒 inventory · 🏠 hutch · 🌱 active</span>
    <button data-a="all">Tick all sellable</button><button data-a="none">Clear</button><button data-a="copy">Copy report</button>
    <button data-a="sell" ${selected.size && ready.ok ? '' : 'disabled'} title="Sell all ticked pets in one go (asks to confirm)">Sell ticked (${selected.size})…</button>`;
  const others = net.others();
  const notes = (ready.ok ? '' : `<div class="note">Selling is off: ${esc(ready.reason)}</div>`) +
    (others.length ? `<div class="note ok">Working alongside ${esc(others.join(' and '))} — commands share one numbering, so they don't clash.</div>` : '');
  body.innerHTML = notes + `<div class="list">${result.useless.map((p) => petRow(p, { ready })).join('')}</div>`;
}

// Every pet that beats p, per role, with the numbers that make it better
function details(p) {
  const notes = [];
  const keptGold = p.mutations.includes('Gold') && result.savedByCollection.find((q) => q.species === p.species && q.collection === 'Gold' && q.id !== p.id);
  if (keptGold) notes.push(`Your collection's Gold ${p.species} is kept: ${label(keptGold)} (${(LOC[keptGold.loc] || [keptGold.loc, keptGold.loc])[1].toLowerCase()}).`);
  const noteHtml = notes.map((n) => `<div class="dnote">ℹ ${esc(n)}</div>`).join('');
  return noteHtml + detailsTables(p);
}
// The ability categories a pet is judged on in a role
const roleCatsOf = (p, role) => Object.keys(p.cats).filter((c) => c !== 'HARMFUL' && p.cats[c] > 0 && (role === 'leaveOut' ? catIsContinuous(c) : !catIsContinuous(c)));
// Ascending by the values being compared (first column first), then max STR
const byCompared = (cats) => (a, b) => {
  for (const c of cats) { const d = (a.cats[c] ?? 0) - (b.cats[c] ?? 0); if (Math.abs(d) > 1e-12) return d; }
  return byStr(b, a);
};
function detailsTables(p) {
  const threshold = { leaveOut: settings.leaveOutThreshold, specificUse: settings.specificUseThreshold };
  const roleName = { leaveOut: 'Left out', specificUse: 'Specific use' };
  const MAX_ROWS = 25;
  return Object.entries(p.roles).map(([role, x]) => {
    const mine = roleCatsOf(p, role);
    // One list per use (left out / specific use): the pets that beat it at EVERY ability of that use, which decide the flag.
    // Each of those abilities gets its own column.
    const cont = role === 'leaveOut';
    const nTied = x.beatenBy.filter((q) => mine.every((c) => Math.abs((q.cats[c] ?? 0) - (p.cats[c] ?? 0)) <= 1e-9)).length;
    const verdict = `<div class="subh"><b>${esc(roleName[role])}:</b> ${orderAbilities([...new Set(mine.flatMap((c) => p.catAbilities?.[c] ?? []))]).map(abilityTag).join('')} — flagged when ${x.threshold ?? threshold[role]}+ pets beat it at ${mine.length === 1 ? 'this' : 'all of these'}: <b>${x.beatenBy.length} do</b> ${x.deletable ? '<span class="chip">flagged</span>' : '<span class="chip keep">kept</span>'}${nTied ? ` <span class="muted">(${nTied} tied, ranked above on size/XP)</span>` : ''}${cont ? ' <span class="muted">· only pets with at least as much stamina count</span>' : ''}${settings.collectThreeAbility !== false && p.abilities.filter((a) => a !== 'GoldGranter' && a !== 'RainbowGranter').length >= 3 ? ' <span class="muted">· three abilities: only pets with all three count, and one is enough</span>' : ''}</div>`;
    // The abilities being compared come first on every row (in the same order), so they line up in a column
    const comparedFirst = (q) => {
      const first = mine.flatMap((c) => orderAbilities(q.catAbilities?.[c] ?? []));
      return [...new Set(first), ...orderAbilities(q.abilities).filter((a) => !first.includes(a))].map(abilityTag).join('');
    };
    const rows = [p, ...x.beatenBy].sort(byCompared(mine)); // ascending by the compared values; this pet in its place
    const shown = rows.length > MAX_ROWS ? rows.slice(0, MAX_ROWS - 1).concat(rows.indexOf(p) >= MAX_ROWS - 1 ? [p] : []) : rows;
    const head = `<tr><th>Pet</th><th>Max STR</th>${mine.map((c) => `<th>${esc(catLabel(c))}</th>`).join('')}${cont ? '<th>Stamina</th>' : ''}<th>Dust</th></tr>`;
    const row = (q) => `<tr${q === p ? ' class="self"' : ''}>
      <td><div class="dpet">${petImg(q, 28)}<div>${locIcon(q.loc)} <b>${esc(q === p ? 'This pet · ' + nameOnly(q) : nameOnly(q))}</b> <span class="muted">${result.locked.has(q.id) ? '<span title="Locked">🔒</span>' : ''}${q.named ? ' "' + esc(q.name) + '"' : ''}</span>
        <div>${comparedFirst(q)}</div></div></div></td>
      <td class="num">${strCell(q)}</td>${mine.map((c) => `<td class="num">${esc(catValue(c, q.cats[c]))}</td>`).join('')}${cont ? `<td class="num">${STAMINA_MIN[q.species] ?? '?'} min</td>` : ''}<td class="num">${(q.dust ?? 0).toLocaleString()}</td></tr>`;
    const tables = x.beatenBy.length
      ? `<div class="sub"><table>${head}${shown.map(row).join('')}</table>${rows.length > shown.length ? `<div class="muted">+${rows.length - shown.length} more</div>` : ''}</div>`
      : '<div class="muted">No pet beats it at all of these.</div>';
    return `<div class="role">${verdict}${tables}</div>`;
  }).join('') || '<span class="muted">No useful abilities under your rules, so any pet beats it.</span>';
}

// Why a pet is kept for your collection, in words
const collectionWhy = (p) => p.collection === 'three abilities' ? 'best three-ability pet of its kind'
  : String(p.collection).startsWith('only ') ? String(p.collection).replace(/with (\w+)$/, (_, a) => 'with ' + pretty(a))
  : `your best ${p.collection} ${p.species}`;
function renderKept(bar, body) {
  const ready = net.readiness(true);
  const rows = [
    ...result.keptByYou.map(({ p, why }) => [p, why, settings.pinned.includes(p.id)]),
    ...result.savedByCollection.map((p) => [p, collectionWhy(p), false]),
    ...result.savedByName.map((p) => [p, 'named', false]),
  ];
  bar.innerHTML = `<span class="grow"><b>${rows.length}</b> pets the rules would flag, but one of your keep rules saves · click a row to see what beats it</span>
    <span class="muted" title="Where each pet is">🎒 inventory · 🏠 hutch · 🌱 active</span>`;
  body.innerHTML = rows.length
    ? `<div class="list">${rows.map(([p, why, pinned]) => petRow(p, { ready, kept: why, pinned })).join('')}</div>`
    : '<div class="note">Nothing here.</div>';
}

// Pets only a softer rule keeps: sellable one at a time, each with the reason it's kept
function renderMaybe(bar, body) {
  const ready = net.readiness(true);
  const list = result.maybe ?? [];
  bar.innerHTML = `<span class="grow"><b>${list.length}</b> pets you might sell: looser rules flag them, but a softer rule keeps them (shown on each). Your call — sell one at a time.</span>
    <span class="muted" title="Where each pet is">🎒 inventory · 🏠 hutch · 🌱 active</span>`;
  body.innerHTML = list.length ? `<div class="list">${list.map(({ p, why }) => petRow(p, { ready, maybe: why })).join('')}</div>` : '<div class="note ok">Nothing borderline right now.</div>';
}
// ---------- Crop journal ----------
// Every crop's journal page has a Normal, Max Weight, Gold, Rainbow and one entry per weather/lunar mutation. Pick a
// mutation to see which crops still need it (instead of scrolling the game's journal), and log crops you're holding.
// Names: the game's mutation ids and journal names differ for a few (Ambershine = Amberlit, Dawncharged = Dawnbound,
// Ambercharged = Amberbound), so both are accepted.
const CROP_VARIANTS = ['Normal', 'Max Weight', 'Gold', 'Rainbow', 'Wet', 'Chilled', 'Frozen', 'Thunderstruck', 'Thundercharged', 'Dawnlit', 'Amberlit', 'Dawnbound', 'Amberbound'];
const VARIANT_ALIAS = { ambershine: 'Amberlit', dawncharged: 'Dawnbound', ambercharged: 'Amberbound', maxweight: 'Max Weight' };
const canonVariant = (v) => { const k = String(v ?? '').replace(/[^a-z]/gi, '').toLowerCase(); return VARIANT_ALIAS[k] ?? CROP_VARIANTS.find((x) => x.replace(/ /g, '').toLowerCase() === k) ?? String(v); };
const VARIANT_ICON = { Normal: '🌱', 'Max Weight': '⚖️', Gold: '🟡', Rainbow: '🌈', Wet: '💧', Chilled: '❄️', Frozen: '🧊', Thunderstruck: '⚡', Thundercharged: '🌩️', Dawnlit: '🌅', Amberlit: '🟠', Dawnbound: '🌄', Amberbound: '🔶' };
let cropFilter = null; // the mutation picked in the crop journal
const unwrapLive = (o) => (o && typeof o === 'object' && o.data && !Array.isArray(o.data) ? o.data : o);
// Crops and which variants each has logged
function cropJournalState() {
  const cj = result?.cropJournal;
  if (!cj) return null;
  const plants = unwrapLive(liveData?.plants) ?? {};
  const species = [...new Set([...Object.keys(plants).filter((k) => plants[k]?.crop), ...Object.keys(cj)])];
  const logged = (sp) => new Set((cj[sp]?.variantsLogged ?? []).map((x) => canonVariant(x?.variant ?? x)));
  return species.map((sp) => ({ sp, name: plants[sp]?.crop?.name ?? pretty(sp), logged: logged(sp), maxScale: Number(plants[sp]?.crop?.maxSizeMultiplier) || null }));
}
// What logging this crop item would add: its mutations, Normal if it has none, Max Weight if it's full size
function cropVariantsOf(item, maxScale) {
  const muts = (item.mutations ?? []).map(canonVariant);
  const out = muts.length ? muts : ['Normal'];
  // crop items carry size 50-100 (100 = max weight); older formats used scale vs the species' maxSizeMultiplier
  if (item.size != null ? Number(item.size) >= 100 : (maxScale && Number(item.scale ?? 0) >= maxScale - 1e-6)) out.push('Max Weight');
  return out;
}
// Crops in your inventory that would add a new journal entry
function loggableCrops() {
  const st = cropJournalState(); if (!st) return [];
  const bySp = new Map(st.map((x) => [x.sp, x]));
  const inv = game.readStorage(settings.gardenOwner);
  const covered = new Set(), picks = [];
  const consider = (it, target, where) => {
    const c = bySp.get(it.species); if (!c) return;
    const adds = cropVariantsOf(it, c.maxScale).filter((v) => !c.logged.has(v) && !covered.has(it.species + '|' + v));
    if (!adds.length) return;
    adds.forEach((v) => covered.add(it.species + '|' + v));
    picks.push({ item: it, target, where, name: c.name, adds });
  };
  for (const it of inv.items.filter((x) => x?.id && x.itemType === 'Produce' && x.species)) consider(it, { kind: 'inventoryItem', itemId: it.id }, 'inventory');
  // Ripe crops still growing in your garden (the ones the game marks with a "?" photo): photographed where they grow
  const now = Date.now();
  for (const g of game.readPets(settings.gardenOwner)?.gardenCrops ?? []) {
    if (g.endTime != null && g.endTime > now) continue; // not ripe yet
    consider({ species: g.species, mutations: g.mutations, size: g.size ?? undefined, scale: g.targetScale }, { kind: 'growSlot', slot: g.tile, slotsIndex: g.slotId ?? g.slotsIndex }, 'garden');
  }
  return picks;
}
// You can only journal with a camera: the mod never logs anything unless you own one (inventory or a storage)
function hasCamera() {
  if (settings.featLogging === false) return false;
  const inv = game.readStorage(settings.gardenOwner);
  const isCam = (x) => /camera/i.test(String(x?.toolId ?? x?.itemId ?? ''));
  return inv.items.some(isCam) || Object.values(inv.storageItems ?? {}).some((list) => list.some(isCam));
}
function renderCropJournal() {
  if (settings.featCropJournal === false) return '';
  const st = cropJournalState();
  if (!st) return '<div class="note">Couldn\'t read your crop journal from the game.</div>';
  const missing = (v) => st.filter((c) => !c.logged.has(v));
  const chips = CROP_VARIANTS.map((v) => `<button class="mini${cropFilter === v ? ' on' : ''}" data-cropf="${esc(v)}" title="Crops that haven't logged ${esc(v)} yet">${VARIANT_ICON[v] ?? ''} ${esc(v)} <b>${missing(v).length}</b></button>`).join('');
  const list = cropFilter ? missing(cropFilter).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const img = (sp) => { const srcs = cropSprites(sp); return `<span class="pimg" style="width:28px;height:28px"><img src="${esc(srcs[0])}" data-alt="${esc(srcs.slice(1).join('|'))}" alt="" loading="lazy" onerror="const a=(this.dataset.alt||'').split('|').filter(Boolean);if(a.length){this.dataset.alt=a.slice(1).join('|');this.src=a[0];}else this.remove()"></span>`; };
  const loggable = loggableCrops();
  const ready = net.readiness(), cam = hasCamera();
  const block = settings.featLogging === false ? 'Logging is turned off in Settings → Features.' : !cam ? "You need a Camera to log: the journal is filled in with photos." : !ready.ok ? ready.reason : !loggable.length ? 'No crop in your inventory or ripe in your garden adds a new entry.' : '';
  return `<div class="team wide"><div class="thd"><b>🌱 Crop journal</b><span class="tval">${st.length} crops</span>
      <button data-a="logcrops" ${block || logBusy ? 'disabled' : ''} title="${esc(block)}">${logBusy ? esc(logBusy) : `📖 Log ${loggable.length} crop${loggable.length === 1 ? '' : 's'}`}</button></div>
    <div class="muted">Pick a mutation to see which crops still need it logged. ${loggable.length ? `Would add: ${esc(loggable.map((x) => `${x.name} (${x.adds.join(', ')}${x.where === 'garden' ? ', in the garden' : ''})`).join('; '))}.` : ''}</div>
    <div class="cropf">${chips}</div>
    ${cropFilter ? (list.length ? `<div class="croplist">${list.map((c) => { const n = siloSeeds(c.sp); return `<span class="cropc">${img(c.sp)}${esc(c.name)}${n ? ` <button class="mini" data-getseed="${esc(c.sp)}" title="${esc(seedTitle(c.sp, n))}">🌱 Get ${n}</button>` : ''}</span>`; }).join('')}</div>`
      : `<div class="note ok">Every crop has ${esc(cropFilter)} logged.</div>`) : ''}</div>`;
}
// Seeds of a species in your Seed Silo (0 if none or no silo)
function siloSeeds(sp) {
  if (settings.featSeedButtons === false) return 0;
  const seed = seedSpeciesOf(sp);
  const silo = game.readStorage(settings.gardenOwner).storageItems?.SeedSilo ?? [];
  return silo.filter((x) => x?.species === seed).reduce((t, x) => t + (Number(x.quantity) || 1), 0);
}
function seedTitle(sp, n) {
  const seed = seedSpeciesOf(sp), name = unwrapLive(liveData?.plants)?.[seed]?.seed?.name ?? `${pretty(seed)} Seed`;
  return `Take all ${n} × ${name} out of your Seed Silo` + (seed !== sp ? ` (${pretty(sp)} is a rare variant grown from it)` : '');
}
// Pictures for a crop: the crop sprite from the live data, then the plant and seed sprites, then the plain name
function cropSprites(sp) {
  const d = unwrapLive(liveData?.plants)?.[sp] ?? {};
  const fallback = `https://mg-api.ariedam.fr/assets/sprites/plants/${encodeURIComponent(sp === 'OrangeTulip' ? 'Tulip' : sp)}.png`;
  return [...new Set([d.crop?.sprite, d.plant?.sprite, fallback, d.seed?.sprite].filter((x) => typeof x === 'string' && /^https:\/\//.test(x)))];
}
// The seed a crop grows from. Rare variants (Four-Leaf Clover, Purple Daisy, Double Snowdrop, Variegated Cattail,
// Embercrown, Stormcap, …) have no seed of their own in the silo: they share their base plant's seed (same seed picture).
function seedSpeciesOf(sp) {
  const plants = unwrapLive(liveData?.plants) ?? {};
  const pic = (k) => String(plants[k]?.seed?.sprite ?? '').split('?')[0].split('/').pop().replace(/\.png$/i, '');
  const mine = pic(sp);
  if (!mine || (plants[sp]?.seed?.eligibleShops ?? []).length) return sp;
  if (mine !== sp && plants[mine]?.seed) return mine;
  return Object.keys(plants).find((k) => k !== sp && pic(k) === mine && (plants[k]?.seed?.eligibleShops ?? []).length) ?? sp;
}
// Take every seed of one species out of the Seed Silo into your inventory (stacks without a uuid go by species)
async function getSeeds(cropSp) {
  const sp = seedSpeciesOf(cropSp);
  const inv = game.readStorage(settings.gardenOwner);
  const stacks = (inv.storageItems?.SeedSilo ?? []).filter((x) => x?.species === sp);
  if (!stacks.length) return;
  const hasStack = inv.items.some((x) => x?.itemType === 'Seed' && x.species === sp);
  if (!hasStack && inv.items.length >= INVENTORY_MAX) { logMsg = { ok: false, text: 'Your inventory is full, so the seeds can\'t come out of the silo.' }; render(); return; }
  for (const x of stacks) {
    const r = await net.send({ type: 'RetrieveItemFromStorage', itemId: x.id ?? sp, storageId: 'SeedSilo' });
    if (!r.ok) { logMsg = { ok: false, text: `Couldn't take the ${pretty(sp)} seeds out of the silo (${r.reason || r.code}).` }; render(); return; }
  }
  logMsg = { ok: true, text: `${pretty(sp)} seeds are in your inventory now.` };
  await sleep(300); render();
}
async function logCrops() {
  if (logBusy) return;
  if (!hasCamera()) { logMsg = { ok: false, text: 'You need a Camera to log.' }; render(); return; }
  const picks = loggableCrops(); if (!picks.length) return;
  logMsg = null;
  const refused = [];
  try {
    for (let i = 0; i < picks.length; i++) {
      logBusy = `Logging crop ${i + 1}/${picks.length}…`; render();
      const r = await net.send({ type: 'LogItem', target: picks[i].target });
      if (!r.ok) {
        if (['not_ready', 'timeout', 'send_failed', 'blocked', 'rate_limited', 'invalid_sequence'].includes(r.code)) { logMsg = { ok: false, text: `Stopped: ${r.reason || r.code}.` }; return; }
        refused.push(`${picks[i].name} (${r.code})`);
      }
      await sleep(40);
    }
    await sleep(400);
    logMsg = { ok: !refused.length, text: `Logged ${picks.length - refused.length} crop${picks.length - refused.length === 1 ? '' : 's'}.${refused.length ? ` The game refused: ${refused.join(', ')}.` : ''}` };
  } finally { logBusy = ''; analyze(); render(); }
}
function renderJournal(bar, body) {
  const ready = net.readiness();
  if (!result.journalReadable) { bar.innerHTML = ''; body.innerHTML = "<div class=\"note\">Couldn't read your journal from the game, so selling is held back to be safe.</div>"; return; }
  const needed = new Set(result.journalPets.flatMap((p) => p.unlogged.map((v) => p.species + ' ' + v)));
  const loggable = result.journalPets;
  const back = [...movedForLog].filter((id) => game.where(id, settings.gardenOwner) === 'inventory').length;
  const block = settings.featLogging === false ? 'Logging is turned off in Settings → Features.' : !hasCamera() ? "You need a Camera to log: the journal is filled in with photos." : !ready.ok ? ready.reason : !loggable.length ? 'Nothing to log.' : '';
  bar.innerHTML = `<span class="grow"><b>${result.journalPets.length}</b> pets would add <b>${needed.size}</b> new journal entries.
      <span class="muted">Log takes one photo per new entry (the camera's LogItem command). Active pets are logged where they are; hutch pets are brought to your inventory for it and put back after.</span></span>
    ${back && !logBusy ? `<button data-a="logback" title="Return the pets brought out of the hutch for logging">Put ${back} back in hutch</button>` : ''}
    <button data-a="logpets" ${block || logBusy ? 'disabled' : ''} title="${esc(block)}">${logBusy ? esc(logBusy) : `📖 Log ${loggable.length} pet${loggable.length === 1 ? '' : 's'}`}</button>`;
  body.innerHTML = (logMsg ? `<div class="note${logMsg.ok ? ' ok' : ' warn'}">${esc(logMsg.text)}</div>` : '') + (settings.featCropJournal === false ? '' : `<div class="teams">${renderCropJournal()}</div>`) + '<h4 style="margin:4px 12px 4px">🐾 Pets</h4>' + (result.journalPets.length
    ? `<div class="list">${result.journalPets.map((p) => petRow(p, { ready, kept: 'needs: ' + p.unlogged.join(', ') })).join('')}</div>`
    : '<div class="note ok">Every pet you have is already in your journal.</div>');
}

// ---------- Logging pets into the journal ----------
// The camera sends LogItem { target }: { kind: 'inventoryItem', itemId } for an inventory item, { kind: 'petSlot', petId }
// for an active pet (format as documented in Arie's MG-Websocket-Helper). Hutch pets have no target, so they're
// brought to the inventory first and put back after.
const INVENTORY_MAX = 100;
const movedForLog = new Set(); // pets this mod took out of the hutch for logging (to put back)
let logBusy = '', logMsg = null;
const logTarget = (p) => (p.loc === 'garden' ? { kind: 'petSlot', petId: p.id } : { kind: 'inventoryItem', itemId: p.id });
async function logPets() {
  if (logBusy) return;
  if (!hasCamera()) { logMsg = { ok: false, text: 'You need a Camera to log.' }; render(); return; }
  analyze();
  const targets = result.journalPets;
  if (!targets.length) return;
  // One pet per new entry is enough, preferring ones that need no moving (inventory or active) over hutch pets
  const prefer = (p) => (p.loc === 'hutch' ? 1 : 0);
  const covered = new Set(), picks = [];
  for (const p of [...targets].sort((x, y) => prefer(x) - prefer(y))) {
    const adds = p.unlogged.filter((v) => !covered.has(p.species + '|' + v));
    if (!adds.length) continue;
    adds.forEach((v) => covered.add(p.species + '|' + v));
    picks.push(p);
  }
  const fromHutch = picks.filter((p) => p.loc === 'hutch');
  const room = Math.max(0, INVENTORY_MAX - (result.inventoryCount ?? 0));
  const bring = fromHutch.slice(0, room);
  const usable = picks.filter((p) => p.loc !== 'hutch' || bring.includes(p));
  const before = picks.map((p) => p.id);
  logMsg = null;
  const step = (t) => { logBusy = t; render(); };
  const inInv = (id) => () => game.where(id, settings.gardenOwner) === 'inventory';
  try {
    for (let i = 0; i < bring.length; i++) {
      const p = bring[i];
      step(`Bringing out ${i + 1}/${bring.length}…`);
      const r = await net.send({ type: 'RetrieveItemFromStorage', itemId: p.id, storageId: 'PetHutch' });
      if (!r.ok) { logMsg = { ok: false, text: `Couldn't take ${nameOnly(p)} out of the hutch (${r.reason || r.code}).` }; return; }
      movedForLog.add(p.id);
      if (!(await game.waitFor(inInv(p.id), 4000))) { logMsg = { ok: false, text: `${nameOnly(p)} didn't reach your inventory.` }; return; }
    }
    const refused = [];
    for (let i = 0; i < usable.length; i++) {
      const p = usable[i];
      step(`Logging ${i + 1}/${usable.length}…`);
      // a pet brought out of the hutch is in the inventory now
      const r = await net.send({ type: 'LogItem', target: logTarget(movedForLog.has(p.id) ? { ...p, loc: 'inventory' } : p) });
      if (!r.ok) {
        if (['not_ready', 'timeout', 'send_failed', 'blocked', 'rate_limited', 'invalid_sequence'].includes(r.code)) { logMsg = { ok: false, text: `Stopped: ${r.reason || r.code}.${movedForLog.size ? ' Pets brought out of the hutch are in your inventory; "Put back in hutch" returns them.' : ''}` }; return; }
        refused.push(`${nameOnly(p)} (${r.code})`);
      }
      await sleep(40);
    }
    const stillUnlogged = () => { analyze(); return result.journalPets.filter((p) => before.includes(p.id)).length; };
    await game.waitFor(() => stillUnlogged() === 0, 3000);
    const left = stillUnlogged();
    await putBack(step);
    const skipped = fromHutch.length - bring.length;
    logMsg = { ok: !left, text: left ? `Sent, but ${left} pet${left === 1 ? ' is' : 's are'} still not in your journal${skipped ? ` (${skipped} didn't fit in your inventory: press Log again)` : ''}.`
      : `Logged ${usable.length - refused.length} pet${usable.length - refused.length === 1 ? '' : 's'}.` };
    if (refused.length) logMsg = { ok: false, text: logMsg.text + ` The game refused: ${refused.join(', ')}.` };
  } finally { logBusy = ''; analyze(); render(); }
}
// Built outside the loop (keeps Tampermonkey's code checker happy)
const inHutchNow = (id) => () => game.where(id, settings.gardenOwner) === 'hutch';
// Return pets that logging took out of the hutch
async function putBack(step = () => {}) {
  const ids = [...movedForLog];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (game.where(id, settings.gardenOwner) !== 'inventory') { movedForLog.delete(id); continue; }
    step(`Putting back ${i + 1}/${ids.length}…`);
    const r = await net.send({ type: 'PutItemInStorage', itemId: id, storageId: 'PetHutch' });
    if (!r.ok) break;
    if (await game.waitFor(inHutchNow(id), 4000)) movedForLog.delete(id);
  }
}

// ---------- Teams: the best 3 pets to have out for one job, from everything you own ----------
// Uses CURRENT strength (+10 if the Strength Crystal is on: these are all one-time-use jobs).
const TEAM_SIZE = 3;
// With pity forcing a Gold/Rainbow at pull 2/p, the long-run hit rate is p / (1 - (1-p)^(2/p)); a boost b on p raises it
// by b x 0.69-0.73 for the usual b (5-43%), for Gold (1%, pity 200) and Rainbow (0.1%, pity 2000) alike: ~70%.
const PITY_MUT_DEFAULT = 0.7;
let strAtMax = null; // null = current strength; a Set of pet ids (or 'all') = use those pets' max strength instead
const teamStr = (p) => ((strAtMax === 'all' || strAtMax?.has?.(p.id)) ? (p.baseStr ?? 0) : (p.curStr ?? p.baseStr ?? 0)) + (settings.crystal ? 10 : 0);
const withStr = (mode, fn) => { const old = strAtMax; strAtMax = mode; try { return fn(); } finally { strAtMax = old; } };
// Sum of one category over a pet's abilities, at current strength
const abilitySum = (p, cat) => {
  let v = 0;
  for (const a of p.abilities) if (A_TABLE[a]?.[0] === cat) v += result.effect(a, teamStr(p)) ?? 0;
  return v;
};
// Chance that at least one of several independent rolls succeeds
const atLeastOne = (chances) => 1 - chances.reduce((q, c) => q * (1 - Math.min(0.99, c)), 1);
// Repeats forever: a double-hatched sibling can double-hatch again, a refunded pet can be refunded again, ...
// so one try with chance c gives 1 + c + c² + … = 1 / (1 - c) in total.
const chain = (c) => 1 / (1 - Math.min(0.99, c));
const TEAM_GOALS = [
  { key: 'maxStr', title: 'Max STR hatching', icon: '💪', cats: ['hatchSize'],
    why: 'Expected boost to max STR on every pet you hatch.',
    score: (t) => t.reduce((s, p) => s + abilitySum(p, 'hatchSize'), 0),
    show: (v) => `+${v.toFixed(2)}% max STR per hatch` },
  { key: 'mutation', title: 'Gold / Rainbow hatching', icon: '🌈', cats: ['petMut', 'doubleHatch'],
    why: 'Pet Mutation Boost raises the Gold/Rainbow chance (pity trims it to ~70%); Double Hatch adds whole extra hatches, which also count toward pity.',
    score: (t) => (1 + atLeastOne(t.map((p) => abilitySum(p, 'doubleHatch')))) * (1 + (settings.pityMutFactor ?? PITY_MUT_DEFAULT) * t.reduce((s, p) => s + abilitySum(p, 'petMut'), 0) / 100) - 1,
    show: (v) => `+${(v * 100).toFixed(1)}% Gold/Rainbow pets per egg` },
  { key: 'rare', title: 'Rare pet hatching', icon: '🥚', cats: ['doubleHatch'],
    why: 'Double Hatch gives a chance of one extra pet per egg (the extra pet doesn\'t double again), and it counts toward the rare-species pity.',
    score: (t) => (1 + atLeastOne(t.map((p) => abilitySum(p, 'doubleHatch')))) - 1,
    show: (v) => `+${(v * 100).toFixed(2)}% extra hatches` },
  { key: 'sell', title: 'Crop selling', icon: '💰', cats: ['sell'],
    why: 'Sell Boost raises the price of a sale (each pet rolls on its own, so their bonuses add up). Crop Refund gives each crop sold a chance of not being removed: you\'re paid and keep it, so it can be sold again (with the boost again): coins x (1 + boost) / (1 - refund chance).',
    score: (t) => {
      let boost = 0; const refunds = [];
      for (const p of t) {
        for (const a of p.abilities) {
          if (A_TABLE[a]?.[0] !== 'sell') continue;
          if (a === 'ProduceRefund') refunds.push(Math.min(0.99, (A_TABLE[a][1] / 100) * teamStr(p) / 100));
          else boost += (result.effect(a, teamStr(p)) ?? 0) / 100;
        }
      }
      return (1 + boost) * chain(atLeastOne(refunds)) - 1;
    },
    show: (v) => `+${(v * 100).toFixed(1)}% coins per crop` },
  { key: 'harvest', title: 'Harvesting', icon: '🧺', cats: ['doubleHarvest'],
    why: 'Double Harvest gives an extra crop when you harvest. Each pet rolls on its own (per the game\'s activity log).',
    score: (t) => t.reduce((s2, p) => s2 + abilitySum(p, 'doubleHarvest'), 0),
    show: (v) => `+${(v * 100).toFixed(2)}% extra crops per harvest` },
  { key: 'charge', title: 'Charge & capture', icon: '🌩️', cats: ['capture:Thunder', 'capture:Dawn', 'capture:Amber'],
    why: 'One of each pressable ability: Thundercharger (Thunderstruck → Thundercharged), Dawn Capture and Amber Capture (Dawn/Amber mutations → capsules). Each can be pressed once every 5 min. Strongest copy of each; a spare slot gets a second copy.',
    score: (t) => {
      const kinds = new Set(); let extra = 0, str = 0;
      for (const p of t) { for (const c of ['capture:Thunder', 'capture:Dawn', 'capture:Amber']) {
        const v = abilitySum(p, c); if (!(v > 0)) continue;
        if (kinds.has(c)) extra += 0.1; else kinds.add(c);
        str += Math.min(v, 10) * 1e-3;
      } }
      return kinds.size + extra + str;
    },
    show: (v) => { const n = Math.floor(v + 1e-9); return `${n} of 3 abilities covered`; } },
  { key: 'refund', title: 'Pet refund (selling pets)', icon: '♻️', cats: ['petRefund'],
    why: 'Chance to get an egg back when you sell a pet (the egg it hatched from, per the ability text and the activity log).',
    score: (t) => atLeastOne(t.map((p) => abilitySum(p, 'petRefund'))),
    show: (v) => `${(v * 100).toFixed(1)}% chance of an egg back per pet sold` },
  { key: 'dust', title: 'Pet dust (selling pets)', icon: '✨', cats: ['dust', 'petRefund'],
    why: 'Dust Boost raises the dust from each pet you sell. Free slots go to Pet Refund (an egg back now and then); it doesn\'t add dust itself, since the egg has to be hatched into a new pet first.',
    score: (t) => t.reduce((s, p) => s + abilitySum(p, 'dust'), 0) / 100 + 1e-4 * atLeastOne(t.map((p) => abilitySum(p, 'petRefund'))),
    show: (v) => `+${(Math.floor(v * 1000 + 1e-6) / 10).toFixed(1)}% dust per pet sold` },
];
function teamGoals() { return TEAM_GOALS.filter((g) => g.key !== 'charge' || settings.featChargeTeam !== false); }
// Best team for a goal: tries every combination of the pets that help (ties: keep pets that are already out)
// Ties between equally good pets always go to the older one (more XP), then by id, so picks don't flip between refreshes
const older = (x, y) => (Number(y.xp) || 0) - (Number(x.xp) || 0) || String(x.id).localeCompare(String(y.id));
function bestTeam(goal) {
  // a pet helps if it adds anything on its own (Crop Refund has no size, only a chance, so abilitySum alone misses it)
  const helps = result.pets.filter((p) => goal.cats.some((c) => abilitySum(p, c) > 0) || goal.score([p]) > 1e-9)
    .sort((a, b) => goal.score([b]) - goal.score([a]) || older(a, b)).slice(0, 40);
  const tie = (t) => t.filter((p) => p.loc === 'garden').length * 1e-9;
  let best = { team: [], value: 0 };
  const n = Math.min(TEAM_SIZE, helps.length);
  const pick = (start, team) => {
    if (team.length === n) { const v = goal.score(team); if (v + tie(team) > best.value + tie(best.team) + 1e-12) best = { team: [...team], value: v }; return; }
    for (let i = start; i < helps.length; i++) { team.push(helps[i]); pick(i + 1, team); team.pop(); }
  };
  pick(0, []);
  best.team.sort((a, b) => goal.score([b]) - goal.score([a]) || older(a, b));
  return best;
}
let teamBusy = null; // goal key being applied
const teamMsg = {}; // goal key -> last result text

function renderTeams(bar, body) {
  const ready = net.readiness();
  const active = result.pets.filter((p) => p.loc === 'garden');
  bar.innerHTML = `<span class="grow">Best ${TEAM_SIZE} pets for each job, using <b>current</b> strength${settings.crystal ? ' + Strength Crystal' : ''}. Apply swaps them into your active slots (nothing is sold).</span>
    <span class="muted">Out now: ${active.length ? active.map((p) => esc(nameOnly(p)) + ' ' + teamStr(p)).join(' · ') : 'none'}</span>`;
  // Eggs ready to hatch: the hatching teams and the egg planner go first
  const eggsReady = (game.readPets(settings.gardenOwner)?.eggs ?? []).filter((e) => e.maturedAt && e.maturedAt <= Date.now()).length;
  const HATCH_GOALS = ['maxStr', 'mutation', 'rare'];
  const goalCard = (g) => {
    const { team, value } = bestTeam(g);
    const isOut = team.length && team.every((p) => p.loc === 'garden');
    const block = !team.length ? 'You have no pets with these abilities.'
      : !ready.ok ? ready.reason
      : active.length < team.filter((p) => p.loc !== 'garden').length + team.filter((p) => p.loc === 'garden').length
        ? `Put out ${TEAM_SIZE - active.length} more pet${TEAM_SIZE - active.length === 1 ? '' : 's'} (any) first, so there are slots to swap into.` : '';
    const btn = isOut ? '<span class="chip keep">✔ out now</span>'
      : `<button data-team="${g.key}" ${block || teamBusy ? 'disabled' : ''} title="${esc(block)}">${teamBusy === g.key ? 'Applying…' : 'Apply'}</button>`;
    return `<div class="team"><div class="thd"><b>${g.icon} ${esc(g.title)}</b><span class="tval">${team.length ? esc(g.show(value)) : '—'}</span>${btn}</div>
      <div class="muted why">${esc(g.why)}</div>
      ${block && !isOut && team.length ? `<div class="warn">${esc(block)}</div>` : ''}${teamMsg[g.key] ? `<div class="muted">${esc(teamMsg[g.key])}</div>` : ''}
      <div class="tpets">${team.map((p) => `<div class="tpet${p.loc === 'garden' ? ' out' : ''}">${petImg(p, 28)}<div class="tl">${locIcon(p.loc)} <b>${esc(nameOnly(p))}</b> <span class="muted">STR ${teamStr(p)}</span>
        ${orderAbilities(p.abilities).filter((a) => { const c = String(A_TABLE[a]?.[0] ?? ''); return g.cats.includes(c) || g.cats.includes(c.split(':')[0]); }).map(abilityTag).join('')}
        <span class="muted">${[...g.cats.map((c) => abilitySum(p, c) > 0 ? catValue(c, abilitySum(p, c)) : ''),
          p.abilities.includes('ProduceRefund') && g.key === 'sell' ? `${(Math.min(0.99, (A_TABLE.ProduceRefund?.[1] ?? 20) / 100 * teamStr(p) / 100) * 100).toFixed(1)}% crop refund` : ''].filter(Boolean).join(' · ')}</span></div></div>`).join('')}</div></div>`;
  };
  // Pets in your Useless list: the pet refund / pet dust teams (the ones for selling pets) also go to the top
  const toSell = result.useless?.length ?? 0;
  const SELL_GOALS = ['refund', 'dust'];
  const ordered = settings.featTeamsOrder !== false;
  const first = ordered ? [...(eggsReady ? HATCH_GOALS : []), ...(toSell ? SELL_GOALS : [])] : [];
  const notes = [eggsReady ? `🥚 ${eggsReady} egg${eggsReady === 1 ? ' is' : 's are'} ready to hatch` : '', toSell ? `💰 ${toSell} pet${toSell === 1 ? '' : 's'} to sell` : ''].filter(Boolean);
  body.innerHTML = first.length
    ? `<div class="note ok">${notes.join(' · ')}: ${eggsReady && toSell ? 'hatching and selling' : eggsReady ? 'hatching' : 'pet selling'} teams first.</div>
      <div class="teams">${first.map((k) => TEAM_GOALS.find((g) => g.key === k)).filter(Boolean).map(goalCard).join('')}${eggsReady ? renderJournalPlan() : ''}
      ${teamGoals().filter((g) => !first.includes(g.key)).map(goalCard).join('')}${renderLevelUp()}${eggsReady ? '' : renderJournalPlan()}</div>`
    : (() => {
      // Nothing to hatch or sell right now: if pets still need growing, Level up goes first
      const lvl = renderLevelUp();
      const growing = ordered && lvl && !lvl.includes('Nothing to grow');
      return growing
        ? `<div class="note ok">📈 Nothing to hatch or sell right now: Level up first.</div><div class="teams">${lvl}${teamGoals().map(goalCard).join('')}${renderJournalPlan()}</div>`
        : `<div class="teams">${teamGoals().map(goalCard).join('')}${lvl}${renderJournalPlan()}</div>`;
    })();
}


// ---------- Level-up preset: grow the pets your best teams will want once they're fully grown ----------
// Pets gain about 1 XP a second while out (60/min); a pet is fully grown after hours-to-mature x 3600 XP.
const BASE_XP_MIN = 60;
const xpLeftHours = (p) => Math.max(0, (RULES_META.HOURS_TO_MATURE?.[p.species] ?? 0) - (p.xp || 0) / 3600);
function levelGoalOrder() {
  const keys = teamGoals().map((g) => g.key);
  const mine = (settings.levelOrder ?? []).filter((k) => keys.includes(k));
  return [...mine, ...keys.filter((k) => !mine.includes(k))];
}
function levelUpPlan() {
  // 1. Which pets would be in the best teams once fully grown, and still aren't
  const want = new Map(); // pet -> { goals, gain }
  for (const g of teamGoals()) {
    const { team, value } = withStr('all', () => bestTeam(g));
    if (!value) continue;
    for (const p of team) {
      if ((p.curStr ?? 0) >= (p.baseStr ?? 0)) continue;
      // how much of the team's (fully grown) value this pet still has to gain
      const ids = new Set(team.filter((q) => q !== p).map((q) => q.id));
      const now = withStr(ids, () => g.score(team));
      const gain = Math.max(0, (value - now) / value);
      const w = want.get(p) ?? { goals: [], gain: 0 };
      w.goals.push(g); w.gain += gain; want.set(p, w);
    }
  }
  // Your choices: goals switched off are skipped; in 'list' mode the goal order decides; pinned pets always go first
  const order = levelGoalOrder();
  const rankOf = (goals) => Math.min(...goals.map((g) => order.indexOf(g.key)).filter((i) => i >= 0), 99);
  const pinned = settings.levelPinned ?? [];
  const pinRank = (p) => { const i = pinned.indexOf(p.id); return i < 0 ? 1e9 : i; };
  const queue = [...want.entries()]
    .map(([p, w]) => ({ p, goals: w.goals.filter((g) => !(settings.levelOff ?? []).includes(g.key)), gain: w.gain, hours: xpLeftHours(p), rate: w.gain / Math.max(0.5, xpLeftHours(p)) }))
    .filter((x) => x.goals.length || pinned.includes(x.p.id))
    .sort((a, b) => pinRank(a.p) - pinRank(b.p) || (settings.levelMode === 'list' ? rankOf(a.goals) - rankOf(b.goals) : 0) || b.rate - a.rate || older(a.p, b.p));
  // 2. Hunger. A pet with an empty hunger bar earns no XP (and a hungry booster boosts nothing), so each layout is
  //    scored by how much of the time its pets stay fed. You feed the hunger pet by hand; the others rely on it:
  //    - a full bar lasts the species' stamina (minutes); Hunger Boost cuts how fast every active pet empties (% x STR)
  //    - Hunger Restore rolls once a minute (chance x STR) to refill pct x STR of ONE active pet's bar; assumed to pick
  //      any active pet at random (incl. itself), so each other pet gets a third of it
  //    Ability numbers from mg-api.ariedam.fr /data/abilities; weather-only (Snowy) versions aren't counted.
  const trainees = new Set(queue.map((x) => x.p));
  const hungerAbility = (p) => {
    let restore = 0, boost = 0; // restore: bar fraction a minute (before sharing); boost: depletion cut (0-1)
    const S = (p.curStr ?? p.baseStr ?? 0) / 100;
    for (const ab of p.abilities) {
      const d = A_TABLE[ab]; if (!d) continue;
      const [cat, weather] = d[0].split(':');
      // Weather-only hunger abilities (Snowy …) aren't counted: that weather is up only a small, unpredictable share
      // of the time, so they can't be relied on to keep a team fed (as Arie's Mod's team stats do)
      if (weather) continue;
      if (cat === 'hungerRestore') {
        // The chance is per minute but checked every second (so it can fire more than once a minute), and each
        // refill is a uniform roll from 1 to the cap (chance x STR, cap = amount x STR of the bar): it averages half
        // the cap. Same as Arie's Mod (services/petTeamStats.ts).
        const pMin = Math.min(1, (d[1] / 100) * S);
        const perMin = pMin >= 1 ? 60 : (1 - Math.pow(1 - pMin, 1 / 60)) * 60;
        restore += perMin * ((d[2] / 100) * S) / 2;
      }
      if (cat === 'hungerBoost') boost += (d[2] / 100) * S;
    }
    return { restore, boost: Math.min(0.9, boost) };
  };
  // 'self': you feed every pet by hand (playing actively), so no slot goes to a feeder and everyone counts as fed
  const selfFed = settings.levelFeeder === 'self';
  const fedShare = (t, hungerPet) => {
    if (selfFed) return () => 1;
    const h = hungerPet ? hungerAbility(hungerPet) : { restore: 0, boost: 0 };
    const perPet = h.restore / Math.max(1, t.length);
    return (p) => {
      if (p === hungerPet) return 1;
      const use = (1 - h.boost) / Math.max(1, STAMINA_MIN[p.species] ?? 60); // bar used per minute
      return Math.min(1, perPet / use);
    };
  };
  const hungerCands = result.pets.filter((p) => !trainees.has(p) && (hungerAbility(p).restore > 0 || hungerAbility(p).boost > 0))
    .sort((x, y) => hungerAbility(y).restore - hungerAbility(x).restore || hungerAbility(y).boost - hungerAbility(x).boost || older(x, y)).slice(0, 6);
  // 3. An XP booster, judged at its CURRENT strength (both its chance and its XP scale with STR, so an ungrown
  //    booster gives much less than at full size). XP Boost rolls once a minute (chance x STR) for XP x STR and goes
  //    to every active pet (as QPM counts it). Each layout is scored by the XP a minute that lands on pets that still
  //    need growing, while they're fed.
  const xpOf = (p) => abilitySum(p, 'xp');
  const usefulXp = (t, hungerPet) => {
    const fed = fedShare(t, hungerPet);
    const boost = t.reduce((s2, p) => s2 + xpOf(p) * fed(p), 0);
    // A starving pet gains no XP of its own, but still gets the booster's XP (confirmed in game); the booster only
    // procs while it's fed itself (boost already counts that)
    return t.filter((p) => trainees.has(p)).reduce((s2, p) => s2 + fed(p) * BASE_XP_MIN + boost, 0);
  };
  let best = null;
  const growers = selfFed ? 3 : 2; // pets growing in the plain layout (no feeder: all three slots)
  const withBoosterTeam = (hunger, b) => [hunger, b, ...queue.filter((x) => x.p !== b).slice(0, growers - 1).map((x) => x.p)].filter(Boolean);
  for (const hunger of selfFed ? [null] : [...hungerCands, null]) {
    const booster = result.pets.filter((p) => p !== hunger && xpOf(p) > 0).sort((x, y) => xpOf(y) - xpOf(x) || older(x, y))[0] ?? null;
    const twoTeam = [hunger, ...queue.slice(0, growers).map((x) => x.p)].filter(Boolean);
    const boostTeam = booster ? withBoosterTeam(hunger, booster) : null;
    for (const [t, layout] of [[twoTeam, 'two'], [boostTeam, 'booster']]) {
      if (!t || !queue.length) continue;
      const v = usefulXp(t, hunger);
      if (!best || v > best.v + 1e-9) best = { v, t, layout, hunger, booster: layout === 'booster' ? booster : null, fed: fedShare(t, hunger) };
    }
  }
  const hunger = best?.hunger ?? null, booster = best?.booster ?? null, layout = best?.layout ?? 'two';
  let team = best?.t ?? [];
  const xpMin = best?.v ?? 0;
  const boosterIsTrainee = !!booster && trainees.has(booster);
  // the other layout with the same hunger pet, for the explanation
  const otherLayout = (() => {
    const bst = result.pets.filter((p) => p !== hunger && xpOf(p) > 0).sort((x, y) => xpOf(y) - xpOf(x) || older(x, y))[0] ?? null;
    const t = layout === 'booster' ? [hunger, ...queue.slice(0, growers).map((x) => x.p)].filter(Boolean) : bst ? withBoosterTeam(hunger, bst) : null;
    return t ? usefulXp(t, hunger) : 0;
  })();
  const twoTrainees = layout === 'two' ? xpMin : otherLayout, withBooster = layout === 'booster' ? xpMin : otherLayout;
  const fed = best?.fed ?? (() => 1);
  team = [...new Set(team)].slice(0, TEAM_SIZE);
  return { team, queue, hunger, booster, boosterIsTrainee, layout, xpMin, twoTrainees, withBooster, fed, selfFed, value: xpMin };
}
let lvlShowAll = false; // Level up: show the whole queue instead of the first 8
function renderLevelUp() {
  if (settings.featLevelUp === false) return '';
  const plan = levelUpPlan();
  const ready = net.readiness();
  const active = result.pets.filter((p) => p.loc === 'garden');
  if (!plan.queue.length) return '<div class="team wide"><div class="thd"><b>📈 Level up</b><span class="tval">Nothing to grow</span></div><div class="muted">Every pet your best teams would use is already fully grown.</div></div>';
  const isOut = plan.team.length && plan.team.every((p) => p.loc === 'garden');
  const block = !ready.ok ? ready.reason : active.length < plan.team.length ? `Put out ${plan.team.length - active.length} more pet${plan.team.length - active.length === 1 ? '' : 's'} (any) first, so there are slots to swap into.` : '';
  const btn = isOut ? '<span class="chip keep">✔ out now</span>' : `<button data-team="levelup" ${block || teamBusy ? 'disabled' : ''} title="${esc(block)}">${teamBusy === 'levelup' ? 'Applying…' : 'Apply'}</button>`;
  const fedTxt = (p) => { const f = plan.fed(p); return f >= 0.995 ? '' : ` · fed ${Math.round(f * 100)}%`; };
  // Time to max level with this team: base 60 XP/min plus the booster's XP/min, only while fed
  const etaTxt = (p) => {
    const left = xpLeftHours(p) * 3600; if (!(left > 0)) return '';
    const boost = plan.layout === 'booster' && plan.booster ? abilitySum(plan.booster, 'xp') * plan.fed(plan.booster) : 0;
    const perMin = Math.max(0.01, 60 * plan.fed(p) + boost); // own XP only while fed; the booster's XP even when starving
    const h = left / perMin / 60, at = new Date(Date.now() + h * 3600000);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const when = h < 20 ? time : h < 144 ? `${at.toLocaleDateString([], { weekday: 'short' })} ${time}` : at.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return ` · max in ${h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : dur(h)} (~${when})`;
  };
  const roleOf = (p) => p === plan.hunger ? '🍖 feeds the team' : p === plan.booster && plan.layout === 'booster' ? `⚡ +${Math.round(abilitySum(p, 'xp'))} XP/min to all${fedTxt(p)}${plan.boosterIsTrainee ? etaTxt(p) : ''}` : `📈 growing${fedTxt(p)}${etaTxt(p)}`;
  const dur = (h) => h >= 24 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`;
  const n = plan.selfFed ? ['two', 'three'] : ['one', 'two'];
  const why = plan.layout === 'booster'
    ? `An XP booster and ${n[0]} pet${plan.selfFed ? 's' : ''} growing (${Math.round(plan.withBooster)} XP/min) beats ${n[1]} pets growing on their own (${Math.round(plan.twoTrainees)} XP/min).`
    : plan.booster ? `${n[1][0].toUpperCase()}${n[1].slice(1)} pets growing (${Math.round(plan.twoTrainees)} XP/min) beats your best XP booster with ${n[0]} (${Math.round(plan.withBooster)} XP/min).`
      : plan.selfFed ? 'The three pets that gain the most per hour of growing.' : 'A hunger manager plus the two pets that gain the most per hour of growing.';
  const feedNote = plan.selfFed ? 'No feeder: you feed all three yourself, so every slot grows.' : `Counts only the time they stay fed (you feed the hunger pet).${plan.hunger ? '' : ' You have no hunger pet, so feed them by hand.'}`;
  return `<div class="team wide"><div class="thd"><b>📈 Level up</b><span class="tval">${Math.round(plan.xpMin)} XP/min into pets that need it</span>${btn}</div>
    <div class="muted">Grows the pets your best teams would use once fully grown. ${esc(feedNote)} ${esc(why)}</div>
    ${block && !isOut ? `<div class="warn">${esc(block)}</div>` : ''}${teamMsg.levelup ? `<div class="muted">${esc(teamMsg.levelup)}</div>` : ''}
    <div class="tpets">${plan.team.map((p) => `<div class="tpet${p.loc === 'garden' ? ' out' : ''}">${petImg(p, 36)}<div><div>${locIcon(p.loc)} <b>${esc(nameOnly(p))}</b> <span class="muted">${strCell(p)}</span></div>
      <div>${abilityTags(p)}</div><div class="muted">${esc(roleOf(p))}</div></div></div>`).join('')}</div>
    <div class="lvlprio"><span class="muted">Team:</span>
      <select data-f="levelFeeder" title="Who keeps the team fed"><option value="pet" ${settings.levelFeeder !== 'self' ? 'selected' : ''}>with a hunger pet</option><option value="self" ${settings.levelFeeder === 'self' ? 'selected' : ''}>no feeder (I feed them)</option></select>
      <span class="muted">Grow first:</span>
      <select data-f="levelMode"><option value="auto" ${settings.levelMode !== 'list' ? 'selected' : ''}>most gain per hour</option><option value="list" ${settings.levelMode === 'list' ? 'selected' : ''}>my priority list</option></select>
      ${levelGoalOrder().map((k, i) => { const g = TEAM_GOALS.find((x) => x.key === k); const off = (settings.levelOff ?? []).includes(k);
        return `<span class="lchip${off ? ' off' : ''}">${settings.levelMode === 'list' ? `<b>${i + 1}.</b> ` : ''}${g.icon} ${esc(g.title)}
          ${settings.levelMode === 'list' && i > 0 ? `<button class="mini" data-lvlup="${k}" title="Higher priority">↑</button>` : ''}<button class="mini" data-lvloff="${k}" title="${off ? 'Include this goal' : 'Skip this goal'}">${off ? '+' : '×'}</button></span>`; }).join('')}
    </div>
    <table class="jplan"><tr><th>Next to grow (${settings.levelMode === 'list' ? 'your priority list' : 'most gain per hour'}; drag ⠿ to reorder, 📌 = put first)</th><th>STR</th><th>For</th><th>Time left</th></tr>${plan.queue.slice(0, lvlShowAll ? plan.queue.length : 8).map((x) => `<tr class="lvlrow" draggable="true" data-lvlrow="${x.p.id}"><td><span class="grip" title="Drag to reorder">⠿</span> ${(settings.levelPinned ?? []).includes(x.p.id) ? `<button class="mini on" data-lvlunpin="${x.p.id}" title="Unpin">📌</button>` : `<button class="mini" data-lvlpin="${x.p.id}" title="Grow this one first">📌</button>`} ${locIcon(x.p.loc)} <b>${esc(nameOnly(x.p))}</b> ${abilityTags(x.p)}</td><td>${strCell(x.p)}</td><td>${x.goals.length ? x.goals.map((g) => g.icon + ' ' + esc(g.title)).join('<br>') : '<span class="muted">pinned</span>'}</td><td>${dur(x.hours)}</td></tr>`).join('')}</table>
    ${plan.queue.length > 8 ? `<button class="mini" data-a="lvlmore" style="margin-top:6px">${lvlShowAll ? 'Show fewer' : `Show ${plan.queue.length - 8} more pet${plan.queue.length - 8 === 1 ? '' : 's'} that need growing`}</button>` : ''}</div>`;
}


// Swap a team into the active slots: SwapPet (inventory) / SwapPetFromStorage (hutch).
// Command shapes from QPM (features/pets/swap.ts, store/petTeams/apply.ts).
// Pets already out stay where they are; the ones replaced go to wherever the incoming pet came from.
async function applyTeam(key) {
  if (teamBusy) return;
  analyze();
  const goal = key === 'levelup' ? { title: 'Level up' } : TEAM_GOALS.find((g) => g.key === key); if (!goal) return;
  const { team } = key === 'levelup' ? levelUpPlan() : bestTeam(goal);
  const incoming = team.filter((p) => p.loc !== 'garden');
  const outgoing = result.pets.filter((p) => p.loc === 'garden' && !team.includes(p));
  if (incoming.length > outgoing.length) { teamMsg[key] = 'Not enough active slots to swap into.'; render(); return; }
  teamBusy = key; teamMsg[key] = ''; render();
  let done = 0, problem = null;
  const arrived = (id) => () => game.where(id, settings.gardenOwner) === 'garden';
  try {
    for (let i = 0; i < incoming.length; i++) {
      const p = incoming[i], out = outgoing[i];
      const now = game.where(p.id, settings.gardenOwner);
      if (now === 'garden') { done++; continue; }
      if (!now) { problem = `${nameOnly(p)} is gone`; break; }
      const cmd = now === 'hutch'
        ? { type: 'SwapPetFromStorage', petSlotId: out.id, storagePetId: p.id, storageId: 'PetHutch' }
        : { type: 'SwapPet', petSlotId: out.id, petInventoryId: p.id };
      const r = await net.send(cmd);
      if (!r.ok) { problem = `${nameOnly(p)}: ${r.reason || r.code}`; break; }
      if (!(await game.waitFor(arrived(p.id), 4000))) { problem = `${nameOnly(p)} didn't appear in the garden`; break; }
      done++;
    }
  } finally {
    teamBusy = null;
    teamMsg[key] = problem ? `Stopped: ${problem} (${done}/${incoming.length} swapped).` : `Done: ${done} pet${done === 1 ? '' : 's'} swapped in.`;
    analyze(); render();
  }
}

// ---------- Journal planner: which hatching team to use for each egg ----------
// Built-in egg contents (mg-api.ariedam.fr /data/eggs, 2026-09-30); replaced by live data when it's loaded.
const EGGS_BUILTIN = {
  CommonEgg: ['Common Egg', { Worm: 65, Snail: 30, Bee: 5 }], UncommonEgg: ['Uncommon Egg', { Chicken: 65, Bunny: 30, Dragonfly: 5 }],
  RareEgg: ['Rare Egg', { Pig: 65, Cow: 30, Turkey: 5 }], LegendaryEgg: ['Legendary Egg', { Squirrel: 65, Turtle: 30, Goat: 5 }],
  SnowEgg: ['Snow Egg', { SnowFox: 65, Stoat: 30, WhiteCaribou: 5 }], DawnEgg: ['Dawn Egg', { Sheep: 65, Horse: 30, Ostrich: 5 }],
  ThunderEgg: ['Thunder Egg', { Bat: 65, Platypus: 30, ThunderWolf: 5 }], AmberEgg: ['Amber Egg', { Rooster: 60, RedFox: 33, FireHorse: 5, Phoenix: 2 }],
  MythicalEgg: ['Mythical Egg', { Butterfly: 65, Peacock: 30, Capybara: 5 }],
};
// Eggs you can't get any more: never suggested, even if the live data still lists them
const retiredEggs = () => new Set(settings.retiredEggs ?? []); // editable in Settings
function eggTable() {
  const live = liveData?.eggs && typeof liveData.eggs === 'object' ? (liveData.eggs.data && !Array.isArray(liveData.eggs.data) ? liveData.eggs.data : liveData.eggs) : null;
  const out = [];
  if (live) for (const [id, e] of Object.entries(live)) if (!retiredEggs().has(id) && e?.faunaSpawnWeights && typeof e.faunaSpawnWeights === 'object') out.push([id, e.name || id, e.faunaSpawnWeights]);
  return out.length ? out : Object.entries(EGGS_BUILTIN).filter(([id]) => !retiredEggs().has(id)).map(([id, [name, w]]) => [id, name, w]);
}
// Order to chase journal entries in (step 1 first): Max Weight, then Gold, then Rainbow.
// Max Weight goes before the mutations: while hunting for size you'll stumble on Gold/Rainbow anyway, not the other way round.
// Rare species need no team: the species pity (40 hatches, Phoenix 100) brings them on its own.
const ENTRY_KIND = {
  'Max Weight': { rank: 1, team: 'maxStr', why: 'Max Weight (a top-size hatch; Max Strength Boost raises size)' },
  Gold: { rank: 2, team: 'mutation', why: 'Gold (~1% a hatch, pity at 200)' },
  Rainbow: { rank: 3, team: 'mutation', why: 'Rainbow (~0.1% a hatch, pity at 2000)' },
};
function journalPlan() {
  const journal = result.journal;
  if (!journal) return null;
  const owned = new Set(result.pets.flatMap((p) => petVariants(p).map((v) => p.species + '|' + v)));
  const logged = (sp, v) => (journal[sp]?.variantsLogged ?? []).some((x) => x.variant === v);
  return eggTable().map(([id, name, weights]) => {
    const total = Object.values(weights).reduce((t, x) => t + (+x || 0), 0) || 1;
    const missing = [];
    for (const [sp, w] of Object.entries(weights)) {
      const share = (+w || 0) / total;
      for (const v of ['Normal', 'Gold', 'Rainbow', 'Max Weight']) {
        if (logged(sp, v)) continue;
        const have = owned.has(sp + '|' + v); // you already own one: just log it, no hatching needed
        const kind = v === 'Normal' ? null : ENTRY_KIND[v];
        missing.push({ sp, v, share, have, kind });
      }
    }
    const toHatch = missing.filter((m) => !m.have);
    const steps = toHatch.filter((m) => m.kind).sort((a, b) => a.kind.rank - b.kind.rank || a.share - b.share);
    const hardest = steps[0];
    const later = [...new Set(steps.map((m) => m.kind.team))].filter((t) => t !== hardest?.kind.team); // the next teams, in order
    // Eggs of this kind planted in your garden: ready ones first
    const planted = (result.eggs ?? []).filter((x) => x.eggId === id);
    const now = Date.now();
    const ready = planted.filter((x) => x.maturedAt && x.maturedAt <= now).length;
    const nextAt = Math.min(...planted.filter((x) => x.maturedAt > now).map((x) => x.maturedAt));
    return { id, name, missing, toHatch, hardest, later, ready, growing: planted.length - ready, nextAt };
  }).filter((e) => e.missing.length || e.ready || e.growing)
    // eggs ready to hatch in your garden come first, then ones still growing (soonest first), then the rest
    .sort((a, b) => (b.ready > 0) - (a.ready > 0) || b.ready - a.ready || (b.growing > 0) - (a.growing > 0) || a.nextAt - b.nextAt);
}
function renderJournalPlan() {
  if (settings.featEggPlan === false) return '';
  const plan = journalPlan();
  if (!plan) return '<div class="team wide"><b>📖 Which team for each egg</b><div class="muted">Couldn\'t read your journal.</div></div>';
  const goalOf = (k) => TEAM_GOALS.find((g) => g.key === k);
  const rows = plan.map((e) => {
    const g = e.hardest ? goalOf(e.hardest.kind.team) : null;
    const best = g ? bestTeam(g) : null;
    const isOut = best?.team.length && best.team.every((p) => p.loc === 'garden');
    const entry = (m) => `<span class="tag${m.have ? ' have' : ''}" title="${m.have ? 'You already own one: log it (📖 Journal tab)' : 'Not owned yet: hatch it'}">${esc(pretty(m.sp))} ${esc(m.v)}${m.have ? ' ✓ owned' : ''}</span>`;
    const pick = !e.missing.length ? '<span class="muted">Journal done for this egg: hatch with whatever team you like (🌈 for Gold/Rainbow dust).</span>'
      : !e.toHatch.length ? '<span class="muted">Nothing to hatch: log the pets you already own.</span>'
      : !g ? '<span class="muted">Only new species left: they come on their own (species pity), so any team.</span>'
      : `<b>${g.icon} ${esc(g.title)}</b> <span class="muted">for ${esc(pretty(e.hardest.sp))} ${esc(e.hardest.kind.why)}</span> ${isOut ? '<span class="chip keep">✔ out now</span>' : `<button data-team="${g.key}" ${teamBusy || !net.readiness().ok ? 'disabled' : ''}>Apply</button>`}${e.later.length ? `<div class="muted">then: ${e.later.map((k) => goalOf(k).icon + ' ' + esc(goalOf(k).title)).join(' → ')}</div>` : ''}`;
    const dur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
    const field = (e.ready ? `<div><span class="chip keep">${e.ready} ready to hatch</span></div>` : '') + (e.growing ? `<div class="muted">${e.growing} growing · next in ${dur(e.nextAt - Date.now())}</div>` : '');
    return `<tr${e.ready ? ' class="ready"' : ''}><td><b>${esc(e.name)}</b>${field}</td><td>${e.missing.length ? e.missing.sort((a, b) => a.have - b.have).map(entry).join('') : '<span class="muted">All logged</span>'}</td><td>${pick}</td></tr>`;
  }).join('');
  return `<div class="team wide"><div class="thd"><b>📖 Which team for each egg (journal)</b></div>
    <div class="muted">Go in order: Max Weight → 💪 (you'll stumble on Gold/Rainbow while hunting size, not the other way round), then Gold, then Rainbow → 🌈. New species need no team: the species pity brings them on its own. Double Hatch helps all of them. Entries you already own just need logging (📖 Journal tab). Eggs ready to hatch in your garden are listed first.</div>
    ${rows ? `<table class="jplan"><tr><th>Egg</th><th>Not in your journal yet</th><th>Hatch with</th></tr>${rows}</table>` : '<div class="note ok">Every egg\'s pets are fully logged.</div>'}</div>`;
}

// ---------- Sharing settings ----------
// One line of text: "MGLH1:" + base64 of the settings JSON. Pinned pets and your garden choice stay out (they only
// mean something on your own account). Importing only takes known settings whose type matches the default.
const SETTINGS_TAG = 'MGLH1:';
const PERSONAL = new Set(['pinned', 'gardenOwner']);
function exportSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (!PERSONAL.has(k) && settings[k] !== undefined) out[k] = settings[k];
  return SETTINGS_TAG + btoa(unescape(encodeURIComponent(JSON.stringify(out))));
}
function parseSettings(text) {
  const raw = String(text).trim();
  let obj;
  try { obj = JSON.parse(raw.startsWith(SETTINGS_TAG) ? decodeURIComponent(escape(atob(raw.slice(SETTINGS_TAG.length)))) : raw); } catch { return { error: "That doesn't look like shared settings." }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: "That doesn't look like shared settings." };
  const taken = {}, skipped = [];
  const sameType = (d, v) => (Array.isArray(d) ? Array.isArray(v) && v.every((x) => typeof x === 'string')
    : d === null ? v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
    : typeof d === typeof v && (typeof v !== 'number' || (Number.isFinite(v) && v >= 0)));
  for (const [k, v] of Object.entries(obj)) {
    if (PERSONAL.has(k) || !(k in DEFAULT_SETTINGS) || !sameType(DEFAULT_SETTINGS[k], v)) { skipped.push(k); continue; }
    taken[k] = v;
  }
  return { taken, skipped };
}
async function copySettings(btn) {
  const text = exportSettings();
  let ok = false;
  try { await W.navigator.clipboard.writeText(text); ok = true; } catch {}
  if (ok) { const old = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = old; }, 1500); return; }
  const m = modal(`<b style="font-size:16px">Your settings</b><div class="muted">Copy this line and share it:</div>
    <textarea readonly style="width:100%;height:90px;font:12px monospace">${esc(text)}</textarea><div class="acts"><button data-m="close">Close</button></div>`);
  m.querySelector('textarea').select();
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-m="close"]')) m.remove(); });
}
function importSettings() {
  const m = modal(`<b style="font-size:16px">Import settings</b><div class="muted">Paste a settings line someone shared (it starts with ${SETTINGS_TAG}). Your pinned pets are kept.</div>
    <textarea style="width:100%;height:90px;font:12px monospace" placeholder="${SETTINGS_TAG}…"></textarea><div class="muted st"></div>
    <div class="acts"><button data-m="cancel">Cancel</button><button data-m="go">Import</button></div>`);
  const ta = m.querySelector('textarea'), st = m.querySelector('.st');
  ta.focus();
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-m="cancel"]')) return m.remove();
    if (!e.target.closest('[data-m="go"]')) return;
    const r = parseSettings(ta.value);
    if (r.error) { st.textContent = r.error; return; }
    if (!Object.keys(r.taken).length) { st.textContent = 'Nothing in there matches this mod\'s settings.'; return; }
    settings = { ...settings, ...r.taken };
    saveSettings(); analyze(); render();
    m.querySelector('.acts').innerHTML = '<button data-m="cancel">Done</button>';
    st.textContent = `Imported ${Object.keys(r.taken).length} setting${Object.keys(r.taken).length === 1 ? '' : 's'}.${r.skipped.length ? ` Skipped (unknown or wrong type): ${r.skipped.join(', ')}.` : ''}`;
  });
}
// Settings groups fold like Advanced; which ones are open is remembered (also across redraws)
let openSecs = new Set(store.get('openSettings', ['features']));
const secOpen = (k) => (openSecs.has(k) ? ' open' : '');
document.addEventListener('toggle', (e) => {
  const d = e.target; if (!d?.dataset?.sec || !d.closest?.('#' + ID)) return;
  d.open ? openSecs.add(d.dataset.sec) : openSecs.delete(d.dataset.sec);
  store.set('openSettings', [...openSecs]);
}, true);
function renderSettings(bar, body) {
  bar.innerHTML = '<span class="grow">Changes apply immediately.</span><button data-a="setcopy" title="Copy your settings as one line of text to share">Copy settings</button><button data-a="setimport" title="Paste settings someone shared">Import…</button><button data-a="reset">Reset to defaults</button>';
  const ignored = new Set(settings.ignored ?? DEFAULT_IGNORED_LIST);
  const chk = (key, text) => `<label><input type="checkbox" data-f="${key}" ${settings[key] ? 'checked' : ''}> ${text}</label>`;
  const num = (key, text, step = 1) => `<label>${text} <input type="number" data-f="${key}" value="${settings[key]}" min="0" step="${step}"></label>`;
  const sel = (key, text, opts) => `<label>${text} <select data-f="${key}">${opts.map(([v, t]) => `<option value="${v}" ${settings[key] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;
  const list = (key, text, ph = '') => `<label>${text} <input data-list="${key}" value="${esc((settings[key] ?? []).join(', '))}" placeholder="${ph}" style="flex:1"></label>`;
  body.innerHTML = `<div class="set">
    <details data-sec="useless"${secOpen('useless')}><summary><b>When is a pet useless?</b></summary>
      ${num('leaveOutThreshold', 'Better pets needed (long-term abilities)')}
      ${num('specificUseThreshold', 'Better pets needed (one-time abilities)')}
      ${chk('extraCopies', 'One more for hunger pets and Rainbows (all three can be out)')}
      ${chk('crystal', 'Count the Strength Crystal (+10 STR)')}
      ${chk('goldNotUpgrade', "Gold Granter doesn't make a pet better")}
      ${chk('mutSameSpecies', 'Compare Gold/Rainbow only with their own species')}</details>
    <details data-sec="keep"${secOpen('keep')}><summary><b>Always keep</b></summary>
      ${chk('protectNamed', 'Named pets')}
      ${chk('teamsProtect', 'Pets on a best team (now or fully grown)')}
      ${chk('collectMutations', 'Gold/Rainbow collection (best of each species and of each ability mix)')}
      ${chk('collectThreeAbility', 'Three-ability pets: only compared with pets that have all three; one better copy is enough to flag (the best copy is kept)')}
      ${chk('protectLongTermGold', 'Gold pets with a long-term ability')}
      ${list('keepSpecies', 'Species:', 'e.g. Peacock, Capybara')}
      ${list('keepAbilities', 'Abilities:', 'e.g. DoubleHarvest')}
      <div class="muted">${settings.pinned.length} pet(s) pinned with "Keep" (unpin on the Kept anyway tab).</div></details>
    <details data-sec="features"${secOpen('features')}><summary><b>Features</b></summary>
      ${chk('featBuyAll', '🛒 Buy everything')}
      ${chk('featLevelUp', '📈 Level up preset (Teams tab)')}
      ${chk('featEggPlan', '📖 Which team for each egg (Teams tab)')}
      ${chk('keepAwake', '💤 Keep the game running in the background (unfocused or hidden tab)')}${settings.keepAwake !== false && keepAwake.othersHandleIt() ? ' <span class="muted">(another mod is already doing this, so this one stays off)</span>' : ''}
      ${chk('featChargeTeam', '🌩️ Charge & capture team (Teams tab)')}
      ${chk('featTeamsOrder', 'Teams tab puts what\'s due first (hatching / selling / growing)')}
      ${chk('featSellFix', 'Sell dialog: swap in the selling team')}
      ${chk('featJoin5', '👥 "5-player room" button (joins a public room with 5 players, so you make it full)')}
      ${chk('cropSellRoomWarn', '💰 Ask before selling valuable crops in a room that isn\'t full')} ${num('cropSellWarnMin', 'worth at least (coins)', 1000000)}
      ${chk('cropSellTeamWarn', '💰 …also when no Sell Boost or Crop Refund pet is out')}
      ${chk('harvestTeamWarn', '🧺 Ask before harvesting a Gold/Rainbow celestial crop without Double Harvest pets out')}
      ${chk('featHatchFix', '🥚 Hatch pop-up: swap in a hatching team')}
      ${chk('featCrystalPlace', '💎 Offer to put the Strength Crystal out')}
      ${chk('featLogging', '📖 Log buttons (needs a Camera)')}
      ${chk('featMountHint', '🐎 Riding a Thundercharger / Capture pet: show what it would do where you stand')}
      ${chk('featPlantHint', '🌱 Missing journal entries above the plant card (when you stand on a plant; right-click the plant picture to toggle)')}
      ${chk('featCropJournal', '🌱 Crop journal filters')}
      ${chk('featSeedButtons', '🌱 "Get seeds" from the Seed Silo')}
      ${settings.buyOff?.length ? `<div><button class="mini" data-a="buyallon">🛒 Switch all ${settings.buyOff.length} switched-off Buy items back on</button></div>` : ''}
      ${chk('featTabOrder', 'Drag tabs to reorder them')} ${settings.tabOrder?.length ? '<button class="mini" data-a="tabreset">Default tab order</button>' : ''}</details>
    <details data-sec="hatch"${secOpen('hatch')}><summary><b>Hatching and selling</b></summary>
      ${chk('crystalBlock', "Stop a hatch if the Strength Crystal isn't out")}
      ${chk('idleBlock', "Stop a hatch if pets out don't help hatching")}
      ${chk('taskWarnings', 'Remind me before selling pets (crystal, idle pets)')}
      ${chk('pityPopup', 'Pity line-up popup (needs QPM)')}
      ${list('retiredEggs', 'Eggs left out of the egg plan:')}</details>
    <details data-sec="shop"${secOpen('shop')}><summary><b>🛒 Shop</b></summary>
      ${chk('buyPotions', 'Also buy XP and Hunger potions (Magic Dust)')}
      <div class="muted">Never bought: buildings, one-time items, other Magic Dust items.</div>
      ${list('noLocalStock', 'No local stock:')}</details>
    <details data-sec="display"${secOpen('display')}><summary><b>Buttons and display</b></summary>
      ${chk('showShopButton', '🛒 button')}
      ${chk('showTeamButton', '🧪 button (eggs ready / pets to sell)')}
      ${chk('fabDrag', 'Drag 🐾 to move the 🐾 / 🛒 / 🧪 buttons')} ${store.get('fabPos', null) ? '<button class="mini" data-a="fabreset">Default spot</button>' : ''}
      ${sel('sortBy', 'Sort pets by', [['species', 'species, then max STR'], ['str', 'max STR'], ['dust', 'dust']])}
      ${sel('abilityOrder', 'Ability order', [['type', 'by type'], ['alpha', 'alphabetical'], ['game', 'as in the game']])}</details>
    <details data-sec="data"${secOpen('data')}><summary><b>Game data</b></summary>${(() => {
      const L = RULES_META.LIVE || {};
      const when = liveStatus.at ? new Date(liveStatus.at).toLocaleString() : '';
      return `<div>${liveStatus.source === 'live' ? `Live from mg-api.ariedam.fr · ${esc(when)}` : 'Built-in (2026-09-30)'}${liveStatus.error ? ` <span class="warn">· couldn't refresh: ${esc(liveStatus.error)}</span>` : ''}</div>
        ${L.newSpecies?.length ? `<div class="muted">New species: ${esc(L.newSpecies.join(', '))} (stamina assumed 60 min)</div>` : ''}
        ${L.newAbilities?.length ? `<div class="muted">New abilities: ${esc(L.newAbilities.map(pretty).join(', '))}</div>` : ''}
        ${L.unmatched?.length ? `<div class="muted">Not recognised (each counts as its own niche): ${esc(L.unmatched.map(pretty).join(', '))}</div>` : ''}
        <button data-a="refreshdata" style="margin-top:6px">Refresh now</button>`;
    })()}</details>
    <details data-sec="advanced"${secOpen('advanced')}><summary><b>Advanced</b></summary>
      ${num('maybeLooser', '🤔 Maybe sell: fewer better pets needed')}
      ${num('tiny', 'Ignore abilities weaker than this share of your best (0 = off)', 0.05)}
      ${num('pityMutFactor', 'Mutation boost left after pity (team maths)', 0.01)}</details>
    <details data-sec="ignored"${secOpen('ignored')}><summary><b>Abilities that never protect a pet</b> <span class="muted">(${ignored.size})</span></summary><div class="grid">${
      allAbilities().map((a) => `<label><input type="checkbox" data-ign="${a}" ${ignored.has(a) ? 'checked' : ''}> ${esc(pretty(a))}</label>`).join('')}</div></details>
    </div>`;
}

function onChange(e) {
  const t = e.target;
  if (t.dataset.sel) { t.checked ? selected.add(t.dataset.sel) : selected.delete(t.dataset.sel); render(); return; }
  if (t.dataset.f) {
    const k = t.dataset.f;
    settings[k] = t.type === 'checkbox' ? t.checked : t.type === 'number' ? Math.max(0, +t.value || 0) : (t.value || null);
    if (k === 'collectMutations') settings.collectUniqueMutated = t.checked; // one switch for the whole Gold/Rainbow collection
  } else if (t.dataset.list) {
    settings[t.dataset.list] = t.value.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (t.dataset.ign) {
    const set = new Set(settings.ignored ?? DEFAULT_IGNORED_LIST);
    t.checked ? set.add(t.dataset.ign) : set.delete(t.dataset.ign);
    settings.ignored = [...set];
  } else return;
  saveSettings(); analyze(); render();
  try { updateShopFab(); updateTeamFab(); } catch {}
}

function onClick(e) {
  const b = e.target.closest('button');
  // Don't leave the clicked button focused: Space (the game's action key) would press it again
  if (b) setTimeout(() => b.blur(), 0);
  const tog = e.target.closest('[data-buyoff]');
  if (tog && !b) {
    const k = tog.dataset.buyoff, offList = settings.buyOff ?? [];
    settings.buyOff = offList.includes(k) ? offList.filter((x) => x !== k) : [...offList, k];
    saveSettings(); render(); updateShopFab(); return;
  }
  if (!b) {
    // Clicking anywhere on a pet row opens/closes its details (not the checkbox, links or the open details themselves)
    const row = e.target.closest('.prow');
    if (row && !e.target.closest('.pmore, input, label, a')) { const id = row.dataset.id; expanded.has(id) ? expanded.delete(id) : expanded.add(id); render(); }
    return;
  }
  if (b.dataset.tab) { tab = b.dataset.tab; render(); return; }
  if (b.dataset.unlock) { if (!b.disabled && (e.isTrusted || TEST_BUILD)) unlockPet(b.dataset.unlock, b); return; }
  if (b.dataset.lvlup) { const o = levelGoalOrder(), i = o.indexOf(b.dataset.lvlup); if (i > 0) { [o[i - 1], o[i]] = [o[i], o[i - 1]]; settings.levelOrder = o; saveSettings(); render(); } return; }
  if (b.dataset.lvloff) { const off = new Set(settings.levelOff ?? []); off.has(b.dataset.lvloff) ? off.delete(b.dataset.lvloff) : off.add(b.dataset.lvloff); settings.levelOff = [...off]; saveSettings(); render(); return; }
  if (b.dataset.a === 'lvlmore') { lvlShowAll = !lvlShowAll; render(); return; }
  if (b.dataset.lvlpin) { settings.levelPinned = [...new Set([...(settings.levelPinned ?? []), b.dataset.lvlpin])]; saveSettings(); render(); return; }
  if (b.dataset.lvlunpin) { settings.levelPinned = (settings.levelPinned ?? []).filter((id) => id !== b.dataset.lvlunpin); saveSettings(); render(); return; }
  if (b.dataset.a === 'shopbuy') { if (!b.disabled && (e.isTrusted || TEST_BUILD)) startShopBuy(); return; }
  if (b.dataset.team) { if (!b.disabled && (e.isTrusted || TEST_BUILD)) applyTeam(b.dataset.team); return; }
  if (b.dataset.sellone) { if (!b.disabled && (e.isTrusted || TEST_BUILD)) startSell([b.dataset.sellone]); return; }
  if (b.dataset.more) { expanded.has(b.dataset.more) ? expanded.delete(b.dataset.more) : expanded.add(b.dataset.more); render(); return; }
  if (b.dataset.pin) { settings.pinned = [...new Set([...settings.pinned, b.dataset.pin])]; selected.delete(b.dataset.pin); saveSettings(); analyze(); render(); return; }
  if (b.dataset.unpin) { settings.pinned = settings.pinned.filter((id) => id !== b.dataset.unpin); saveSettings(); analyze(); render(); return; }
  const a = b.dataset.a;
  if (a === 'logcrops') { if (!b.disabled && (e.isTrusted || TEST_BUILD)) logCrops(); return; }
  if (b.dataset.getseed) { if (e.isTrusted || TEST_BUILD) { b.disabled = true; getSeeds(b.dataset.getseed); } return; }
  if (b.dataset.cropf) { cropFilter = cropFilter === b.dataset.cropf ? null : b.dataset.cropf; render(); return; }
  if (a === 'logpets') { if (!b.disabled && (e.isTrusted || TEST_BUILD)) logPets(); return; }
  if (a === 'logback') { if (!logBusy && (e.isTrusted || TEST_BUILD)) { logBusy = 'Putting back…'; render(); putBack().finally(() => { logBusy = ''; analyze(); render(); }); } return; }
  if (a === 'minimize') { setMinimized(!document.getElementById(ID).classList.contains('min')); return; }
  if (a === 'close') document.getElementById(ID).classList.remove('open');
  if (a === 'refresh') { analyze(); render(); }
  if (a === 'join5') { if (e.isTrusted || TEST_BUILD) joinFivePlayerRoom(b); return; }
  if (a === 'all') { result.useless.filter((p) => !sellBlock(p)).forEach((p) => selected.add(p.id)); render(); }
  if (a === 'none') { selected.clear(); render(); }
  if (a === 'setcopy') { copySettings(b); return; }
  if (a === 'setimport') { importSettings(); return; }
  if (a === 'buyallon') { settings.buyOff = []; saveSettings(); render(); updateShopFab(); return; }
  if (a === 'fabreset') { store.set('fabPos', null); setFabPos(fabPos(), false); avoidOtherButtons(); render(); return; }
  if (a === 'tabreset') { settings.tabOrder = []; saveSettings(); render(); return; }
  if (a === 'reset') { settings = { ...DEFAULT_SETTINGS, pinned: settings.pinned, gardenOwner: settings.gardenOwner }; saveSettings(); analyze(); render(); }
  if (a === 'copy') copyReport(b);
  if (a === 'refreshdata') { b.textContent = 'Refreshing…'; loadLiveData(true); }
  if (a === 'sell') { if (e.isTrusted || TEST_BUILD) startSell([...selected]); }
}

async function copyReport(btn) {
  const lines = [`Useless pets: ${result.useless.length} of ${result.pets.length}`, '',
    ...result.useless.map((p) => `- ${label(p)} [${p.loc}] ${p.abilities.join(', ')} (${p.id.slice(0, 8)})\n    ` +
      Object.entries(p.roles).map(([r, x]) => `${r === 'leaveOut' ? 'left out' : 'specific use'}: ${x.beatenBy.length} better`).join(' | '))];
  const text = lines.join('\n');
  console.log(text);
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied ✔'; } catch { btn.textContent = 'In console'; }
  setTimeout(() => { btn.textContent = 'Copy report'; }, 1500);
}


// Unlock one pet in-game (same as its padlock). Separate from selling on purpose: selling never unlocks anything.
async function unlockPet(id, btn) {
  if (busy) return;
  analyze();
  if (!result.locked.has(id)) { render(); return; } // already unlocked: toggling now would lock it again
  busy = true;
  btn.disabled = true; btn.textContent = 'Unlocking…';
  const r = await net.send({ type: 'ToggleLockItem', itemId: id });
  if (r.ok) await game.waitFor(() => !game.readPets(settings.gardenOwner)?.locked.has(id), 3000);
  busy = false;
  analyze(); render();
  if (!r.ok) LOG('unlock failed', r.code, r.reason || '');
}

// ---------- sell flow ----------
// ---------- Shop: what's in stock, and one confirmed button to buy it ----------
// Shop state, PurchaseShopItem shape and per-player weather stock follow QPM's shop code (store/shopStock*.ts);
// the viewMode field and the Tool/Decor mix in the tool shop come from Arie's mg-afk-android (GameActions.kt).
// Only ever runs when you press the button and confirm (never on a timer or a restock), and stops at the first problem.
const SHOP_NAMES = { seed: '🌱 Seeds', egg: '🥚 Eggs', tool: '🔧 Tools', decor: '🪑 Decor', dawn: '🌅 Dawn', snow: '❄️ Snow', thunder: '⚡ Thunder', amber: '🟠 Amber' };
let shopBusy = false;
// Item picture: the live data's own sprite URL, else mg-api's folder pattern (seeds/, items/, decor/, pets/ for eggs)
const SPRITE_DIR = { Seed: 'seeds', Tool: 'items', Decor: 'decor', Egg: 'pets' };
const SPRITE_NAME = { OrangeTulip: 'Tulip' }; // seeds whose picture has a different name (from the plants data)
function shopImg(i, size = 36) {
  const unwrap = (o) => (o && typeof o === 'object' && o.data && !Array.isArray(o.data) ? o.data : o);
  const live = i.itemType === 'Seed' ? unwrap(liveData?.plants)?.[i.id]?.seed?.sprite
    : (unwrap(liveData?.items)?.[i.id] ?? unwrap(liveData?.decors)?.[i.id] ?? unwrap(liveData?.eggs)?.[i.id])?.sprite;
  const url = live || (SPRITE_DIR[i.itemType] ? `https://mg-api.ariedam.fr/assets/sprites/${SPRITE_DIR[i.itemType]}/${encodeURIComponent(SPRITE_NAME[i.id] ?? i.id)}.png` : '');
  return `<span class="pimg" style="width:${size}px;height:${size}px">${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}
// Everything a shop can sell, even while it's empty (weather shops between weathers): what it has now, what the mod
// has seen it sell before, and the live game data's eligibleShops lists. Used so items can be switched off any time.
let shopSeen = store.get('shopSeen', {}); // { shopKey: { id: { itemType, idField, id, name } } }
function rememberShopItems(shops) {
  let changed = false;
  for (const sh of shops ?? []) { for (const i of sh.items) {
    const m = (shopSeen[sh.key] ??= {});
    if (!m[i.id]) { m[i.id] = { itemType: i.itemType, idField: i.idField, id: i.id, name: i.name }; changed = true; }
  } }
  if (changed) store.set('shopSeen', shopSeen);
}
function shopCatalog(sh) {
  const unwrap = (o) => (o && typeof o === 'object' && o.data && !Array.isArray(o.data) ? o.data : o);
  const all = new Map(Object.values(shopSeen[sh.key] ?? {}).map((x) => [x.id, x]));
  const sources = [['plants', 'Seed', 'species'], ['items', 'Tool', 'toolId'], ['decors', 'Decor', 'decorId'], ['eggs', 'Egg', 'eggId']];
  for (const [kind, itemType, idField] of sources) {
    for (const [id, d] of Object.entries(unwrap(liveData?.[kind]) ?? {})) {
      const el = d?.seed?.eligibleShops ?? d?.eligibleShops;
      if (!Array.isArray(el) || !el.some((x) => String(x).toLowerCase() === sh.key.toLowerCase())) continue;
      if (!all.has(id)) all.set(id, { itemType, idField, id, name: d?.seed?.name ?? d?.name ?? id });
    }
  }
  const have = new Set(sh.items.map((i) => i.id));
  return [...sh.items, ...[...all.values()].filter((x) => !have.has(x.id)).map((x) => ({ ...x, shop: sh.key, stock: 0, left: 0, price: null, dust: false, absent: true }))];
}
const shopLabel = (k) => SHOP_NAMES[k] ?? k[0].toUpperCase() + k.slice(1);
function renderShop(bar, body) {
  const shops = game.readShops(settings.gardenOwner);
  const ready = net.readiness();
  if (!shops) { bar.innerHTML = ''; body.innerHTML = '<div class="note">Couldn\'t read the shops from the game yet.</div>'; return; }
  rememberShopItems(shops);
  const inStock = shops.flatMap((sh) => sh.items.filter((i) => i.left > 0 && !shopSkip(i)));
  const units = inStock.reduce((t, i) => t + i.left, 0);
  const block = !ready.ok ? ready.reason : !inStock.length ? 'Nothing left in any shop.' : '';
  const dur = (sec) => sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
  bar.innerHTML = `<span class="grow"><b>${inStock.length}</b> items in stock across ${shops.length} shops, weather shops included (${units} units). Buildings, one-time purchases and anything costing Magic Dust are skipped. Bought items go into your Seed Silo / Tool Shack / Decor Shed when you have one.</span>
    <button data-a="shopbuy" ${block || shopBusy ? 'disabled' : ''} title="${esc(block)}">🛒 Buy everything…</button>`;
  body.innerHTML = `<div class="teams">${shops.map((sh) => `<div class="team"><div class="thd"><b>${esc(shopLabel(sh.key))}</b><span class="tval">${sh.items.filter((i) => i.left > 0 && !shopSkip(i) && !isBuyOff(sh.key, i.id)).length} to buy</span>${sh.restockIn ? `<span class="muted">restocks in ${dur(sh.restockIn)}</span>` : ''}</div>
    <div class="shopitems">${shopCatalog(sh).map((i) => `<span class="tag${i.left && !shopSkip(i) && !isBuyOff(sh.key, i.id) ? '' : ' have'}${shopSkip(i) ? '' : ' buytog'}"${shopSkip(i) ? '' : ` data-buyoff="${esc(buyOffKey(sh.key, i.id))}"`} title="${shopSkip(i) ? 'Never bought by Buy everything' : `${i.absent ? 'Not in stock now' : `${i.left} of ${i.stock} left`} · click to switch ${isBuyOff(sh.key, i.id) ? 'it back on' : 'it off'} for Buy everything`}">${shopImg(i, 18)} ${esc(pretty(i.name))} ${i.absent ? '' : `<b>×${i.left}</b>`}${shopSkip(i) ? ' · ' + SKIP_LABEL[shopSkip(i)] : isBuyOff(sh.key, i.id) ? ' · ⏸ switched off' : i.absent ? ' · not in stock now' : i.price ? ` · ${i.price.toLocaleString()}🪙` : ''}</span>`).join('') || '<span class="muted">Empty</span>'}</div></div>`).join('')}</div>`;
}
const STORAGE_FOR = { Seed: 'SeedSilo', Tool: 'ToolShack', Decor: 'DecorShed' };
// What "Buy everything" never buys (built-in, from the game data of 2026-09-30; live data adds new ones):
//  - Buildings (Pet Hutch, Seed Silo, Decor Shed, Tool Shack, Feeding Trough): one each, upgraded rather than re-bought
//  - one-time purchases (Shovel, Camera, …)  - anything priced in Magic Dust
const SHOP_BUILDINGS = new Set(['PetHutch', 'SeedSilo', 'DecorShed', 'ToolShack', 'FeedingTrough']);
const SHOP_ONE_TIME = new Set(['Shovel', 'Camera', 'WetPotion', 'DawnlitPotion', 'AmberlitPotion', 'GoldPotion']);
const SHOP_DUST = new Set(['ReplenishPotion', 'XPPotion']);
const DUST_POTIONS = new Set(['XPPotion', 'ReplenishPotion']); // allowed by the "buy XP / Hunger potions" setting
// Seeds the game lists with stock but shows under "No local stock" and refuses to sell (seen 2026-09-30).
// Hard-coded on purpose; update this list when the game changes. Anything else it refuses is caught per restock below.
const noLocalStock = () => new Set(settings.noLocalStock ?? []); // editable in Settings
// Items the game refused this restock (e.g. Grape listed with stock but shown under "No local stock"): the client can't
// see why, so the game's answer is remembered until that shop restocks.
const refusedThisRestock = new Set();
const refusalKey = (i) => `${i.shop}:${i.restockId}:${i.id}`;
// Why did the game refuse a purchase? Its answer is generic ("rejected"), so check the usual causes against the live state.
const INVENTORY_SLOTS = 100;
// Carry limits from the game data (2026-09-30), used when live data isn't loaded
const CARRY_MAX = { WateringCan: 99, CropCleanser: 99, ChilledPotion: 99, FrozenPotion: 99, RainbowPotion: 99, ReplenishPotion: 99, XPPotion: 99 };
function shopMeta(i) {
  const unwrap = (o) => (o && typeof o === 'object' && o.data && !Array.isArray(o.data) ? o.data : o);
  if (i.itemType === 'Seed') { const pl = unwrap(liveData?.plants)?.[i.id]; return pl ? { coinPrice: pl.seed?.coinPrice, max: pl.seed?.maxInventoryQuantity } : null; }
  const m = unwrap(liveData?.items)?.[i.id] ?? unwrap(liveData?.decors)?.[i.id] ?? unwrap(liveData?.eggs)?.[i.id] ?? null;
  return m ? { coinPrice: m.coinPrice, max: m.maxInventoryQuantity } : null;
}
// How many more of this item you can carry (Infinity when there's no limit or it isn't known)
function roomFor(i, inv = game.readStorage(settings.gardenOwner)) {
  const max = Number(shopMeta(i)?.max) || CARRY_MAX[i.id] || 0;
  if (!max) return Infinity;
  const have = inv.items.filter((x) => x[i.idField] === i.id && (!x.itemType || x.itemType === i.itemType)).reduce((t, x) => t + (Number(x.quantity) || 1), 0);
  return Math.max(0, max - have);
}
// Magic Dust price of an item (0 if it's bought with coins)
function dustCost(i) {
  const unwrap = (o) => (o && typeof o === 'object' && o.data && !Array.isArray(o.data) ? o.data : o);
  const m = unwrap(liveData?.items)?.[i.id];
  return Number(m?.dustPrice) > 0 && !(Number(m?.coinPrice) > 0) ? Number(m.dustPrice) : ({ XPPotion: 5000, ReplenishPotion: 250 }[i.id] ?? 0);
}
function explainRefusal(i, code) {
  if (i.itemType === 'Seed' && i.shop === 'seed' && noLocalStock().has(i.id)) return 'no local stock: the game lists it but doesn\'t sell it to you';
  const now = (game.readShops(settings.gardenOwner) ?? []).find((sh) => sh.key === i.shop)?.items.find((x) => x.id === i.id);
  if (now && now.restockId !== i.restockId) return 'the shop restocked while buying';
  if (now && now.left <= 0) return 'sold out';
  const inv = game.readStorage(settings.gardenOwner);
  const meta = shopMeta(i);
  const price = Number(meta?.coinPrice) || i.price || 0;
  if (dustCost(i) && inv.dust < dustCost(i)) return `not enough Magic Dust (costs ${dustCost(i).toLocaleString()}, you have ${inv.dust.toLocaleString()})`;
  if (price && inv.coins < price) return `not enough coins (costs ${price.toLocaleString()}, you have ${inv.coins.toLocaleString()})`;
  const stack = inv.items.find((x) => x[i.idField] === i.id && (!x.itemType || x.itemType === i.itemType));
  const max = Number(meta?.max) || CARRY_MAX[i.id] || 0;
  if (stack && max && (Number(stack.quantity) || 1) >= max) return null; // at its carry limit: obvious, not reported
  if (!stack && inv.items.length >= INVENTORY_SLOTS) return `inventory full (${inv.items.length}/${INVENTORY_SLOTS} slots) and you have no stack of it yet`;
  return `the game refused it ("${code}") without saying why; it isn't coins, stock, inventory space or a carry limit`;
}
// Before buying: trim the list to what your coins, dust and free inventory slots can actually take, in list order,
// so nothing is sent that the game would refuse for those reasons. Returns the trimmed items and what was cut and why.
function preflight(items, inv = game.readStorage(settings.gardenOwner)) {
  inv = { ...inv, storageFree: { ...(inv.storageFree ?? {}) } };
  let coins = inv.coins, dust = inv.dust;
  let freeSlots = INVENTORY_SLOTS - inv.items.length;
  const short = [];
  const out = [];
  for (const i of items) {
    const hasStack = inv.items.some((x) => x[i.idField] === i.id && (!x.itemType || x.itemType === i.itemType));
    // A new stack needs a free slot. If it can be put away (you own its storage) the slot is freed again right after.
    // …unless that storage is full and has no stack of it yet: then it stays in the inventory
    const sid = STORAGE_FOR[i.itemType], inStore = (inv.storageItems?.[sid] ?? []).some((x) => x[i.idField] === i.id);
    const storeFree = inv.storageFree ?? {};
    const putAway = inv.storages.includes(sid) && (inStore || (storeFree[sid] ?? Infinity) > 0);
    if (!hasStack && freeSlots < 1) { short.push({ i, n: i.left, why: 'no free inventory slot' }); continue; }
    const price = Number(shopMeta(i)?.coinPrice) || i.price || 0; // 0 = price unknown: left for the game to decide
    const dPrice = dustCost(i);
    let n = i.left;
    if (price) n = Math.min(n, Math.floor(coins / price));
    if (dPrice) n = Math.min(n, Math.floor(dust / dPrice));
    if (n < i.left) short.push({ i, n: i.left - n, why: dPrice && Math.floor(dust / dPrice) < i.left ? 'not enough Magic Dust' : 'not enough coins' });
    if (n <= 0) continue;
    coins -= n * price; dust -= n * dPrice;
    if (!hasStack && !putAway) freeSlots--;
    if (!hasStack && putAway && !inStore && storeFree[sid] != null) storeFree[sid]--;
    out.push({ ...i, left: n });
  }
  return { items: out, short };
}
function shopSkip(i) {
  if (i.itemType === 'Seed' && i.shop === 'seed' && noLocalStock().has(i.id)) return 'nolocal';
  if (refusedThisRestock.has(refusalKey(i))) return 'refused';
  const unwrap = (o) => (o && typeof o === 'object' && o.data && !Array.isArray(o.data) ? o.data : o);
  const meta = unwrap(liveData?.items)?.[i.id] ?? unwrap(liveData?.decors)?.[i.id] ?? null;
  // Buildings, one-time items and Magic Dust items (except the potions, when you allow them) are never bought
  if ((SHOP_BUILDINGS.has(i.id) || (meta && (meta.baseCapacitySlots != null || Array.isArray(meta.upgrades))))) return 'building';
  if (!(settings.buyPotions && DUST_POTIONS.has(i.id)) && (i.dust || SHOP_DUST.has(i.id) || (meta && Number(meta.dustPrice) > 0 && !(Number(meta.coinPrice) > 0)))) return 'dust';
  if ((SHOP_ONE_TIME.has(i.id) || meta?.isOneTimePurchase === true)) return 'one-time';
  return null;
}
// Items you switched off in the Buy window (click a tile): never bought until you switch them back on
const buyOffKey = (shop, id) => `${shop}:${id}`;
const isBuyOff = (shop, id) => (settings.buyOff ?? []).includes(buyOffKey(shop, id));
const SKIP_LABEL = { nolocal: '⛔ no local stock', refused: '⛔ not sold to you this restock', building: '🏗️ building, skipped', dust: '✨ dust, skipped', 'one-time': '1️⃣ one-time, skipped' };
// Storage ids (SeedSilo, ToolShack, DecorShed) and stack ids (uuid, else species/toolId/decorId) as QPM uses them
// (ui/shop/restockAlerts, store/inventory.ts).
// Put one bought item's stack(s) away: seeds → Seed Silo, tools → Tool Shack, decor → Decor Shed (if you have them)
async function storeItem(i, tally, waitMs = 1500) {
  const storageId = STORAGE_FOR[i.itemType];
  if (!storageId) return; // eggs etc. just stay in the inventory
  const stacksOf = () => game.readStorage(settings.gardenOwner).items.filter((x) => x[i.idField] === i.id && (!x.itemType || x.itemType === i.itemType));
  // The purchase's answer can arrive before the game's state shows the new stack: wait for it, or it'd be left behind
  if (waitMs && !stacksOf().length) await game.waitFor(() => stacksOf().length > 0, waitMs);
  const inv = game.readStorage(settings.gardenOwner);
  const stacks = stacksOf();
  for (const x of stacks) {
    const stackId = x.id ?? x.species ?? x.toolId ?? x.decorId; // stacks without a uuid go by what they are
    if (!stackId) continue;
    if (!inv.storages.includes(storageId)) { tally.kept++; (tally.why ??= new Map()).set(pretty(i.name), `no ${storageId} found (storages seen: ${inv.storages.join(', ') || 'none'})`); continue; }
    const r = await net.send({ type: 'PutItemInStorage', itemId: stackId, storageId });
    if (r.ok) tally.moved++; else { tally.kept++; (tally.why ??= new Map()).set(pretty(i.name), `the game said "${r.reason || r.code}"`); }
  }
}
// Seeds / tools / decor sitting in the inventory while their storage already holds that same kind (so putting them away
// only adds to that stack and needs no free storage spot). Unique tools (the Strength Crystal etc.) are never included.
const STACK_KEY = { Seed: 'species', Tool: 'toolId', Decor: 'decorId' };
function leftoverStacks(inv = game.readStorage(settings.gardenOwner)) {
  return inv.items.filter((x) => {
    const sid = STORAGE_FOR[x.itemType], k = STACK_KEY[x.itemType];
    if (!sid || !k || !x[k] || !inv.storages.includes(sid)) return false;
    if (x.itemType === 'Tool' && (x.remainingActiveSeconds != null || (typeof x.id === 'string' && x.id))) return false;
    return (inv.storageItems?.[sid] ?? []).some((y) => y[k] === x[k]);
  });
}
async function putAwayLeftovers() {
  let moved = 0, kept = 0, why = null;
  for (const x of leftoverStacks()) {
    const k = STACK_KEY[x.itemType];
    const r = await net.send({ type: 'PutItemInStorage', itemId: x.id ?? x[k], storageId: STORAGE_FOR[x.itemType] });
    if (r.ok) moved++; else { kept++; why = r.reason || r.code; }
  }
  return { moved, kept, why };
}
// The always-visible 🛒 button: red with a count when there's something to buy and the mod can send; grey otherwise
function updateShopFab() {
  const b = document.getElementById('mgpc-shopfab'); if (!b) return;
  b.style.display = settings.showShopButton === false || settings.featBuyAll === false ? 'none' : '';
  let n = 0;
  try { const inv = game.readStorage(settings.gardenOwner); const wanted = (game.readShops(settings.gardenOwner) ?? []).flatMap((sh) => sh.items.filter((i) => i.left > 0 && !shopSkip(i) && !isBuyOff(sh.key, i.id)).map((i) => ({ ...i, shop: sh.key, left: Math.min(i.left, roomFor(i, inv)) }))).filter((i) => i.left > 0);
    n = preflight(wanted, inv).items.reduce((a, i) => a + i.left, 0); } catch {}
  const ready = net.readiness();
  const can = n > 0 && ready.ok && !shopBusy;
  b.classList.toggle('can', can);
  b.textContent = can ? `🛒 ${n}` : '🛒';
  b.title = can ? `Buy everything from every shop (${n} purchases): asks to confirm first` : shopBusy ? 'Buying…' : !ready.ok ? ready.reason : 'Nothing to buy right now: opens the Buy window, which waits for the next restock';
}
// The 🧪 button: shows while eggs are ready to hatch or there are pets to sell, and opens the Teams tab
let teamFabCheckedAt = 0, sellable = 0;
function updateTeamFab() {
  const b = document.getElementById('mgpc-teamfab'); if (!b) return;
  let eggs = 0;
  try {
    const d = game.readPets(settings.gardenOwner);
    eggs = (d?.eggs ?? []).filter((e) => e.maturedAt && e.maturedAt <= Date.now()).length;
    // "pets to sell" = your Useless list; the rules are re-run at most every 10 s for this
    if (result?.useless) sellable = result.useless.length; // whatever the panel last worked out
    if (d && Date.now() - teamFabCheckedAt > 10000) { analyze(); if (result) { teamFabCheckedAt = Date.now(); sellable = result.useless?.length ?? 0; } }
  } catch {}
  const show = settings.showTeamButton !== false && (eggs > 0 || sellable > 0);
  b.classList.toggle('show', show);
  b.dataset.main = eggs ? 'teams' : 'useless'; // only pets to sell: straight to Useless
  b.innerHTML = `🧪 Teams${eggs ? ` · 🥚 ${eggs}` : ''}${sellable ? ` · <span data-go="useless" title="Pets to sell: open the Useless tab">💰 ${sellable}</span>` : ''}`;
  b.title = [eggs ? `${eggs} egg${eggs === 1 ? ' is' : 's are'} ready to hatch` : '', sellable ? `${sellable} pet${sellable === 1 ? '' : 's'} in your Useless list` : ''].filter(Boolean).join('; ') + ': open Teams to swap in the right pets';
}
setInterval(updateTeamFab, 3000);
let shopFabQueued = false;
game.onChange(() => { if (shopFabQueued) return; shopFabQueued = true; setTimeout(() => { shopFabQueued = false; updateShopFab(); }, 500); });
setInterval(updateShopFab, 5000);
// What Buy everything will and won't do, from your current settings
function shopRulesText() {
  return ['Coins are spent and can\'t be refunded.',
    settings.buyPotions ? 'XP and Hunger potions are bought with Magic Dust.' : '',
    `Buildings, one-time items (Shovel, Camera, …) and ${settings.buyPotions ? 'other ' : ''}Magic Dust items are never bought.`,
    'Click an item to switch it off (greyed out, not bought) or back on; this is remembered across restocks.',
    'Your coins, dust and free inventory slots are checked first; anything that won\'t fit is listed and not sent.',
    'Each item goes into your Seed Silo / Tool Shack / Decor Shed (if you have them) as soon as it\'s bought.',
    'A refused item is skipped and left alone until that shop restocks. This window can stay open: after each restock, press Buy again.',
  ].filter(Boolean).join(' ');
}
// The Buy everything dialog. It can stay open: it counts down to the next restock, redraws when a shop restocks and
// lights Buy up again, so you can press Buy once per restock. Nothing is ever bought without your press.
let shopDialogOpen = false;
async function startShopBuy() {
  if (settings.featBuyAll === false) return;
  if (shopBusy || shopDialogOpen) return;
  // What would be bought right now (re-read from the game each time)
  const collect = () => {
    const shops = game.readShops(settings.gardenOwner) ?? [];
    const inv0 = game.readStorage(settings.gardenOwner);
    const wanted = shops.flatMap((sh) => sh.items.filter((i) => i.left > 0 && !shopSkip(i) && !isBuyOff(sh.key, i.id)).map((i) => ({ ...i, shop: sh.key, left: Math.min(i.left, roomFor(i, inv0)) }))).filter((i) => i.left > 0);
    const { items, short } = preflight(wanted, inv0); // checked against your coins, dust and free slots first
    const next = Math.min(...shops.map((sh) => sh.restockIn || Infinity));
    const off = shops.flatMap((sh) => sh.items.filter((i) => i.left > 0 && !shopSkip(i) && isBuyOff(sh.key, i.id)).map((i) => ({ ...i, shop: sh.key })));
    return { shops, items, off, short, units: items.reduce((t, i) => t + i.left, 0), next, restocks: shops.map((sh) => sh.key + ':' + sh.restockId).join('|') };
  };
  const shortHtml = (short) => {
    if (!short?.length) return '';
    const noSlot = short.some((x) => x.why === 'no free inventory slot'), left = noSlot ? leftoverStacks().length : 0;
    const used = noSlot ? game.readStorage(settings.gardenOwner).items.length : 0;
    return `<div class="refused"><b>Left out before buying:</b><ul>${short.map((s) => `<li>${esc(pretty(s.i.name))} ×${s.n}: ${esc(s.why)}</li>`).join('')}</ul>${noSlot ? `<div class="muted">Inventory: ${used}/${INVENTORY_SLOTS} slots in use.</div>` : ''}${left ? `<button data-m="putaway" style="margin-top:6px">📦 Put away ${left} stack${left === 1 ? '' : 's'} already kept in your Seed Silo / Tool Shack / Decor Shed</button>` : ''}</div>`;
  };
  const tileHtml = (i, off) => `<div class="buytile${off ? ' off' : ''}" data-buyoff="${esc(buyOffKey(i.shop, i.id))}" title="${esc(pretty(i.name))}: ${off ? 'switched off, click to buy it again' : 'click to switch it off (not bought)'}">${shopImg(i, 40)}<div class="bq">${off ? '⏸' : `×${i.left}`}</div><div class="bn">${esc(pretty(i.name))}</div>${dustCost(i) && !off ? `<div class="bd">✨ ${dustCost(i).toLocaleString()} dust each</div>` : ''}</div>`;
  const listHtml = ({ shops, items, off = [], units, short }) => `${items.length ? `<div>All of the stock you can take: <b>${units} purchases</b>. <span class="muted">Click an item to switch it on or off.</span></div>` : `<div class="muted">Nothing to buy right now.</div>`}${shortHtml(short)}
    ${items.length || off.length ? `<div class="buylist">${shops.map((sh) => [sh, items.filter((i) => i.shop === sh.key), off.filter((i) => i.shop === sh.key)]).filter(([, its, offs]) => its.length || offs.length).map(([sh, its, offs]) => `<div class="buyshop"><b>${esc(shopLabel(sh.key))}</b><div class="buytiles">${its.map((i) => tileHtml(i, false)).join('')}${offs.map((i) => tileHtml(i, true)).join('')}</div></div>`).join('')}</div>` : ''}`;
  const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  let now = collect();
  shopDialogOpen = true;
  const m = modal(`<div class="shopdlg-hd"><b style="font-size:16px">🛒 Buy from every shop</b><span class="state">waiting</span><span class="muted nextrs"></span></div>
    <details class="muted rules"><summary>What gets bought (and what never is)</summary><span class="rulestext">${esc(shopRulesText())}</span></details>
    <label class="dusttoggle"><input type="checkbox" class="buypotions" ${settings.buyPotions ? 'checked' : ''}> ✨ Also buy XP and Hunger potions (paid with Magic Dust)</label>
    <div class="note notready" style="padding:4px 0"></div>
    <div class="buyarea">${listHtml(now)}</div>
    <div class="muted st"></div>
    <div class="acts"><button data-m="cancel">Close</button><button data-m="go" class="danger" disabled>Buy</button></div>`);
  m.classList.add('shopdlg');
  const go = m.querySelector('[data-m="go"]'), st = m.querySelector('.st'), area = m.querySelector('.buyarea'), nextEl = m.querySelector('.nextrs');
  let buying = false, armedAt = Date.now() + 300; // a double-click can't go straight through
  // The window's colour says what to do, for a glance from a split screen: grey = wait, red = press Buy, blue = buying.
  const paint = () => {
    const ready = !buying && !!now.items.length && net.readiness().ok;
    m.classList.toggle('ready', ready);
    m.classList.toggle('buying', buying);
    const r = net.readiness();
    m.querySelector('.state').textContent = buying ? 'buying…' : ready ? 'READY — press Buy' : now.items.length && !r.ok ? 'not connected' : 'waiting';
    const why = m.querySelector('.notready');
    if (why) why.textContent = !buying && now.items.length && !r.ok ? `Can't buy right now: ${r.reason}` : '';
  };
  const refresh = (msg) => { area.innerHTML = listHtml(now); if (msg) st.innerHTML = esc(msg); };
  // Runs right away, every second, and the moment the double-click guard ends, so Buy is never greyed out while the
  // window already says READY
  const update = () => {
    if (!document.body.contains(m)) return;
    const fresh = collect();
    if (!buying && fresh.restocks !== now.restocks) { now = fresh; armedAt = Date.now() + 600; setTimeout(update, 620); refresh(now.items.length ? 'A shop restocked: the list is updated. Press Buy when ready.' : 'A shop restocked: nothing to buy.'); }
    else if (!buying) now = { ...fresh, restocks: now.restocks };
    nextEl.textContent = Number.isFinite(fresh.next) ? ` · next restock in ${mmss(Math.max(0, fresh.next))}` : '';
    go.disabled = buying || !now.items.length || Date.now() < armedAt || !net.readiness().ok;
    paint();
  };
  const tick = setInterval(update, 1000);
  setTimeout(update, 0); setTimeout(update, 320);
  const close = () => { clearInterval(tick); shopDialogOpen = false; m.remove(); };
  m.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !buying) close(); });
  // The potions toggle (same setting as in Settings): redraws the list straight away
  m.querySelector('.buypotions').addEventListener('change', (e) => {
    settings.buyPotions = e.target.checked; saveSettings();
    m.querySelector('.rulestext').textContent = shopRulesText();
    if (!buying) { now = collect(); refresh(); }
    updateShopFab();
  });
  m.addEventListener('click', async (e) => {
    if (e.target === m && !buying) return close();
    const tile = e.target.closest('[data-buyoff]');
    if (tile && !buying && (e.isTrusted || TEST_BUILD)) {
      const k = tile.dataset.buyoff, offList = settings.buyOff ?? [];
      settings.buyOff = offList.includes(k) ? offList.filter((x) => x !== k) : [...offList, k];
      saveSettings(); now = { ...collect(), restocks: now.restocks }; refresh(); update(); updateShopFab();
      return;
    }
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.m === 'cancel' && !buying) return close();
    if (b.dataset.m === 'putaway' && !buying && (e.isTrusted || TEST_BUILD)) {
      b.disabled = true; b.textContent = 'Putting away…';
      const r = await putAwayLeftovers(); await sleep(300);
      now = { ...collect(), restocks: now.restocks }; refresh(`Put away ${r.moved} stack${r.moved === 1 ? '' : 's'}${r.kept ? ` (${r.kept} refused by the game: "${r.why}")` : ''}.`); update(); updateShopFab();
      return;
    }
    if (b.dataset.m !== 'go' || b.disabled || buying || Date.now() < armedAt || !(e.isTrusted || TEST_BUILD)) return;
    // Buy what's in stock at the moment you press Buy
    now = collect();
    if (!now.items.length) { refresh('Nothing to buy right now.'); return; }
    buying = true; go.disabled = true; m.querySelector('[data-m="cancel"]').disabled = true; paint();
    const result = await runShopBuy(now.items, st);
    buying = false; m.querySelector('[data-m="cancel"]').disabled = false;
    now = collect(); armedAt = Date.now() + 600;
    area.innerHTML = listHtml(now);
    st.innerHTML = result;
    paint();
  });
  paint();
  m.querySelector('[data-m="cancel"]').focus();
}
// One buying run; returns the result as HTML
async function runShopBuy(items, st) {
  const plan = items.flatMap((i) => Array(i.left).fill(i));
  shopBusy = true; updateShopFab();
  let done = 0, stopped = null, stored = null, skippedText = '';
  try {
    // Fast but polite: up to 16 commands in flight, at most ~40 a second (~100 purchases in about 2.5 s), well under
    // the ~300 per 10 s the server is understood to allow. Coins, dust and inventory space were already checked
    // (preflight), so nearly everything sent goes through. Every answer is matched to its own command: counts are exact.
    // Each item is put away as soon as its last unit is bought, so the inventory never fills up mid-run.
    // A refused item is skipped (and remembered until the next restock); the run stops on connection problems,
    // or when 3 different items in a row are refused.
    const WINDOW = 16, GAP_MS = 25;
    let nextAt = 0;
    const paced = async (cmd) => { const t = Math.max(Date.now(), nextAt); nextAt = t + GAP_MS; if (t > Date.now()) await sleep(t - Date.now()); return net.send(cmd); };
    const failedItems = new Map(); // item key -> reason
    const unitsLeft = new Map(items.map((i) => [i.shop + ':' + i.id, i.left]));
    const tally = { moved: 0, kept: 0 };
    let refusedInARow = 0;
    const worker = async (queue) => {
      while (queue.length && !stopped) {
        const i = queue.shift();
        const key = i.shop + ':' + i.id;
        if (failedItems.has(key)) continue;
        st.textContent = `Buying… ${done} of ${plan.length} done`;
        // viewMode is required since game bundle 1292 (same fix as Arie's Mod); 'list' is what the shop's list view sends
        const r = await paced({ type: 'PurchaseShopItem', shop: i.shop, item: { itemType: i.itemType, [i.idField]: i.id }, viewMode: 'list' });
        if (!r.ok) {
          const code = r.reason || r.code;
          // No answer: that item is skipped (until its shop restocks) and the run goes on. The next command shows whether the
          // numbering is fine (answered) or needs stepping down (invalid_sequence, handled in net.send).
          if (r.code === 'timeout') { refusedThisRestock.add(refusalKey(i)); failedItems.set(key, `${pretty(i.name)}: no answer from the game (it may or may not have been bought; skipped until the next restock)`); continue; }
          if (['not_ready', 'send_failed', 'blocked', 'rate_limited', 'invalid_sequence'].includes(r.code)) { stopped = `${pretty(i.name)}: ${code}`; break; }
          const why = explainRefusal(i, code);
          failedItems.set(key, why ? `${pretty(i.name)}: ${why}` : null);
          refusedThisRestock.add(refusalKey(i));
          if (++refusedInARow >= 3) { stopped = `3 items in a row were refused${why ? ` (last: ${why})` : ''}`; break; }
          continue;
        }
        refusedInARow = 0;
        done++;
        const n = unitsLeft.get(key) - 1; unitsLeft.set(key, n);
        if (n === 0) await storeItem(i, tally); // last unit of this item: put the stack away now
      }
    };
    const queue = plan.slice();
    await Promise.all(Array.from({ length: WINDOW }, () => worker(queue)));
    // Second pass: anything bought this run that is still in the inventory (e.g. its stack showed up late) goes away now
    await sleep(400);
    const again = { moved: 0, kept: 0 };
    for (const i of items) if (unitsLeft.get(i.shop + ':' + i.id) < i.left) await storeItem(i, again, 0);
    tally.moved += again.moved; tally.kept = Math.max(0, tally.kept - again.moved); tally.why = again.why ?? (again.moved ? null : tally.why);
    const reasons = [...failedItems.values()].filter(Boolean);
    if (reasons.length) skippedText = `<div class="refused"><b>Not bought:</b><ul>${reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    stored = tally;
  } finally {
    shopBusy = false; updateShopFab();
    render();
  }
  return esc(stopped ? `Stopped: ${stopped}. Bought ${done} of ${plan.length}.` : `Bought ${done} of ${plan.length}.`)
    + esc(stored && (stored.moved || stored.kept) ? ` Put away: ${stored.moved} stack${stored.moved === 1 ? '' : 's'}${stored.kept ? `, ${stored.kept} left in your inventory (no room or no storage for them)` : ''}.` : '')
    + (stored?.why?.size ? `<div class="refused"><b>Not put away:</b><ul>${[...stored.why].map(([n, w]) => `<li>${esc(n)}: ${esc(w)}</li>`).join('')}</ul></div>` : '') + skippedText;
}

// ---------- Pity line-up alert (needs QPM's pity tracker) ----------
// The game's pity counts are hidden; QPM estimates them from the hatches it has seen. If, by those estimates, the next
// hatch of an egg is due BOTH a rare species and Gold/Rainbow, this pops up once. Nothing else is done with it.
const PITY_MUTS = { Gold: 200, Rainbow: 2000 };
const PITY_LAUNCH = Date.UTC(2026, 7, 26); // accounts made before this started every count at half (as QPM assumes)
const pityShown = new Set();
function speciesPity(eggId, sp) {
  const w = eggTable().find(([id]) => id === eggId)?.[2]; if (!w) return 0;
  const total = Object.values(w).reduce((t, x) => t + (+x || 0), 0) || 1;
  if (sp === 'Phoenix') return 100;
  return (+w[sp] || 0) / total <= 0.05 ? 40 : 0;
}
function checkPityLineUp() {
  if (settings.pityPopup === false) return;
  let snap;
  try { snap = W.QPM?.pity?.snapshot?.(); } catch { return; }
  if (!snap?.counters) return;
  const created = snap.account?.createdAt ?? null;
  const count = (c, threshold) => {
    const floor = c.hits === 0 && created !== null && created < PITY_LAUNCH ? Math.floor(threshold / 2) : 0;
    return Math.max(c.misses, floor + c.misses + (c.correction ?? 0));
  };
  const byEgg = {};
  for (const [key, c] of Object.entries(snap.counters)) {
    const [kind, eggId, outcome] = key.split(':');
    if (kind !== 'egg' || !eggId || !outcome || !c) continue;
    const threshold = PITY_MUTS[outcome] ?? speciesPity(eggId, outcome);
    if (!threshold || count(c, threshold) < threshold - 1) continue; // due = the next hatch is guaranteed
    (byEgg[eggId] ??= { species: [], muts: [] })[PITY_MUTS[outcome] ? "muts" : "species"].push(outcome);
  }
  for (const [eggId, d] of Object.entries(byEgg)) {
    if (!d.species.length || !d.muts.length) continue;
    const id = eggId + ':' + d.species.join() + ':' + d.muts.join();
    if (pityShown.has(id)) continue;
    pityShown.add(id);
    const name = eggTable().find(([x]) => x === eggId)?.[1] ?? eggId;
    toast(`🎯 Pity line-up: by QPM's estimate, your next <b>${esc(name)}</b> hatch is due both <b>${esc(d.species.map(pretty).join(' / '))}</b> and <b>${esc(d.muts.join(' / '))}</b>.`);
  }
}
// opts.ms: how long it stays (reminders 30 s; short confirmations a couple of seconds);
// opts.key: a new toast with the same key replaces the old one instead of piling up on it
function toast(html, opts = {}) {
  if (opts.key) document.querySelectorAll('.mgpc-toast').forEach((x) => { if (x.dataset.key === opts.key) x.remove(); });
  const t = document.createElement('div'); t.className = 'mgpc-toast';
  if (opts.key) t.dataset.key = opts.key;
  t.innerHTML = `<div>${html}</div><button title="Close">✕</button>`;
  t.querySelector('button').onclick = () => t.remove();
  // stacked in one corner column, so several never sit on top of each other
  let col = document.getElementById('mgpc-toasts');
  if (!col) { col = document.createElement('div'); col.id = 'mgpc-toasts'; document.body.appendChild(col); }
  col.appendChild(t);
  setTimeout(() => t.remove(), opts.ms ?? 30000); // reminders go stale: gone after 30 s
}
setInterval(() => { try { checkPityLineUp(); } catch (e) { console.error(e); } }, 15000);
setTimeout(() => { try { checkPityLineUp(); } catch {} }, 5000);

// ---------- Reminders before hatching / selling pets ----------
// Hatch and sell abilities scale with your active pets' strength (the Strength Crystal adds +10 while it's out), and an
// active pet without an ability for the job is a wasted slot. Selling gets a reminder; hatching is held back and asked
// about (below).
const TASK_CATS = { hatch: ['hatchSize', 'petMut', 'doubleHatch', 'hatchXp'], sellPet: ['petRefund', 'dust'] };
const TASK_NAME = { hatch: 'hatching', sellPet: 'selling pets' };
const crystalOut = () => (game.readPets(settings.gardenOwner)?.strengthCrystal ?? 0) > 0;
// Putting the Strength Crystal back out. The mod remembers the tile it last sat on and, when you pick it up, the
// inventory id the game gives it (PickupCrystal carries that id; command format as in Arie's MG-Websocket-Helper).
// Only a Strength Crystal (an item with its own id) is ever placed, on that same tile: shards are never used.
// Default spot: your bottom-right boardwalk tile (captured 2026-10-02: PlaceCrystal on Boardwalk tile 75). Wherever you
// later put the crystal yourself becomes the spot instead.
const CRYSTAL_SPOT = { tileType: 'Boardwalk', index: 75 };
let crystalMem = { ...CRYSTAL_SPOT, ...store.get('crystalMem', {}) }; // { tileType, index, itemId }
const saveCrystalMem = () => store.set('crystalMem', crystalMem);
game.onChange(() => {
  try {
    const spot = game.readPets(settings.gardenOwner)?.strengthSpot;
    if (spot && (crystalMem?.tileType !== spot.tileType || crystalMem?.index !== spot.index)) { crystalMem = { ...crystalMem, ...spot }; saveCrystalMem(); }
  } catch {}
});
net.onSent((cmd) => {
  if (cmd?.type === 'PickupCrystal' && cmd.crystalType === 'Strength' && cmd.itemId) {
    crystalMem = { tileType: cmd.tileType, index: Number(cmd.localTileIndex), itemId: cmd.itemId }; saveCrystalMem();
  }
});
// Is your Strength Crystal in your inventory or a storage, with a known spot to put it on? (null = can't do it for you)
// In the game a picked-up crystal is a Tool item with toolId 'StrengthShard', its own id and remainingActiveSeconds
// (its lifespan). Shard stacks share the toolId but have no id and no remainingActiveSeconds: those are never used.
const isCrystalItem = (x) => !!x?.id && x.itemType === 'Tool' && /^Strength(Shard|Crystal)$/.test(String(x.toolId ?? ''))
  && x.remainingActiveSeconds != null && Number(x.quantity ?? 1) === 1;
function crystalPlan() {
  if (settings.featCrystalPlace === false) return null;
  if (crystalOut() || crystalMem?.index == null || !crystalMem.tileType) return null;
  const inv = game.readStorage(settings.gardenOwner);
  const mine = (x) => isCrystalItem(x) && x.id === crystalMem.itemId;
  const item = inv.items.find(mine) ?? inv.items.find(isCrystalItem);
  if (item) return { ...crystalMem, itemId: item.id, from: null };
  // not in your inventory: look in the Tool Shack (and any other storage), and take it out first
  const order = Object.entries(inv.storageItems ?? {}).sort(([a], [b]) => (b === 'ToolShack') - (a === 'ToolShack'));
  for (const [storageId, items] of order) {
    const st = (items ?? []).find(mine) ?? (items ?? []).find(isCrystalItem);
    if (st) return { ...crystalMem, itemId: st.id, from: storageId };
  }
  return null;
}
async function putOutCrystal() {
  if (crystalOut()) return { ok: true };
  const plan = crystalPlan();
  if (!plan) return { ok: false, reason: "no picked-up Strength Crystal was found in your inventory or Tool Shack (shards are never placed)" };
  if (plan.from) {
    const g = await net.send({ type: 'RetrieveItemFromStorage', itemId: plan.itemId, storageId: plan.from });
    if (!g.ok) return { ok: false, reason: `couldn't take it out of the ${plan.from} (${g.reason || g.code}); is your inventory full?` };
    await game.waitFor(() => game.readStorage(settings.gardenOwner).items.some((x) => x?.id === plan.itemId), 3000);
  }
  const r = await net.send({ type: 'PlaceCrystal', tileType: plan.tileType, localTileIndex: plan.index, item: { itemType: 'Tool', itemId: plan.itemId }, intent: { type: 'place' } });
  if (!r.ok) return { ok: false, reason: `the game refused it (${r.reason || r.code}); is something else on that tile now?` };
  await game.waitFor(() => crystalOut(), 3000);
  return { ok: crystalOut(), reason: crystalOut() ? null : 'it was sent but has not shown up yet' };
}
// Active pets with no ability for the task
function idleForTask(task) {
  const d = game.readPets(settings.gardenOwner); if (!d) return [];
  return d.pets.filter((p) => p.loc === 'garden' && !p.abilities.some((ab) => TASK_CATS[task].includes(String(A_TABLE[ab]?.[0] ?? '').split(':')[0])));
}
// Warning lines for a task (empty when all is well)
function taskWarnings(task) {
  const out = [];
  if (!crystalOut()) out.push("your Strength Crystal isn't out (no +10 STR)");
  const idle = idleForTask(task);
  if (idle.length) out.push(`${idle.map((p) => `${p.species} (${p.abilities.map(pretty).join(', ') || 'no abilities'})`).join(', ')} ${idle.length === 1 ? 'is' : 'are'} out but ${idle.length === 1 ? "doesn't" : "don't"} help with ${TASK_NAME[task]}`);
  return out;
}
const lastTaskToast = {};
function taskToast(task, when) {
  if (settings.taskWarnings === false) return;
  const w = taskWarnings(task);
  if (!w.length || Date.now() - (lastTaskToast[task] ?? 0) < 120000) return; // at most every 2 minutes per task
  lastTaskToast[task] = Date.now();
  toast(`⚠ <b>${esc(when)}</b>: ${w.map(esc).join('; ')}.`);
}
net.onSent((cmd, ours) => {
  if (cmd?.type === 'SellPet' && !ours) taskToast('sellPet', 'Selling a pet');
});
// Hatching: instead of a reminder afterwards, the hatch is held back and you're asked first when the Strength Crystal
// isn't out (no +10 STR) or pets are out that don't help with hatching. "Hatch anyway" sends the hatch you pressed
// and stops asking until the page is reloaded; "Don't show this again" turns off the check(s) it showed.
let hatchPrompt = null, hatchAsked = false;
const heldHatches = [];
function hatchIssues() {
  if (!game.readPets(settings.gardenOwner)) return null; // can't tell: never block
  const out = {};
  if (settings.crystalBlock !== false && !crystalOut()) out.crystal = true;
  const idle = settings.idleBlock !== false ? idleForTask('hatch') : [];
  if (idle.length) out.idle = idle;
  return Object.keys(out).length ? out : null;
}
let heldEggId = null; // the egg you pressed Hatch on (its tile in your garden)
hatchGuard.onHatch((resend, payload) => {
  if (hatchAsked) return false;
  try {
    const slot = payload?.command?.slot ?? payload?.slot;
    const tiles = game.riding(settings.gardenOwner)?.garden?.tileObjects;
    const t = tiles && slot != null ? tiles[slot] : null;
    heldEggId = t?.objectType === 'egg' ? t.eggId : null;
  } catch { heldEggId = null; }
  const issues = hatchPrompt ? true : hatchIssues();
  if (!issues) return false;
  heldHatches.push(resend);
  if (!hatchPrompt) showHatchPrompt(issues);
  return true;
});
// ---------- Join a public room with 5 players (you'd be the 6th: full room, biggest friend bonus) ----------
// Public room list from Arie's Mod's API (GET https://ariesmod-api.ariedam.fr/rooms, the list its Public rooms menu uses).
// Joining goes to /r/<room code>, as the game's own room links do (the page reloads into that room).
const ROOMS_API = 'https://ariesmod-api.ariedam.fr/rooms';
const currentRoomCode = () => { const m = /\/r\/([^/?#]+)/.exec(location.pathname); return m ? decodeURIComponent(m[1]).toUpperCase() : null; };
async function joinFivePlayerRoom(btn) {
  const label = btn?.textContent;
  try {
    if (btn) { btn.disabled = true; btn.textContent = '👥 Looking…'; }
    const doFetch = typeof W.fetch === 'function' ? W.fetch.bind(W) : fetch;
    const r = await doFetch(`${ROOMS_API}?limit=200`, { credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rooms = await r.json();
    const here = currentRoomCode();
    const pick = (Array.isArray(rooms) ? rooms : [])
      .filter((x) => x && !x.is_private && Number(x.players_count) === 5 && String(x.id).toUpperCase() !== here)
      .sort((a, b) => Date.parse(b.last_updated_at || 0) - Date.parse(a.last_updated_at || 0))[0];
    if (!pick) { toast('👥 No public room with exactly 5 players right now. Try again in a bit.', { key: 'join5', ms: 4000 }); return; }
    toast(`👥 Joining room <b>${esc(pick.id)}</b> (5 players)…`, { key: 'join5', ms: 4000 });
    const url = new URL(location.href); url.pathname = `/r/${encodeURIComponent(pick.id)}`;
    setTimeout(() => { if (!TEST_BUILD) location.assign(url.toString()); else W.__mglhJoined = url.toString(); }, 400);
  } catch (err) {
    toast(`👥 Couldn't get the room list (${esc(err?.message || err)}). In the Discord activity outside links are blocked.`, { key: 'join5', ms: 5000 });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
// ---------- Selling crops in a room that isn't full ----------
// Crop sales get a friend bonus of +10% per other player in the room (game formula, as QPM computes it). Selling
// valuable crops with empty spots in the room leaves coins behind, so Sell All Crops is held back and asked about first.
// Crop value: base price × size (size 50-100 → 1 … the species' max size) × mutations (Gold ×25 / Rainbow ×50, times
// 1 + the sum of the weather/time multipliers − their count; values from QPM's copy of the game's mutation table).
const MUT_COIN = { Wet: 2, Chilled: 2, Frozen: 6, Thunderstruck: 5, Thundercharged: 7, Dawnlit: 4, Dawncharged: 7, Ambershine: 6, Ambercharged: 10 };
function cropValue(it) {
  const d = unwrapLive(liveData?.plants)?.[it.species]?.crop; const base = Number(d?.baseSellPrice) || 0; if (!base) return 0;
  const maxS = Number(d?.maxSizeMultiplier) || 2, size = Number(it.size);
  const scale = Number.isFinite(size) ? 1 + Math.max(0, Math.min(50, size - 50)) / 50 * (maxS - 1) : (Number(it.scale) || 1);
  const muts = it.mutations ?? [];
  const growth = muts.includes('Rainbow') ? 50 : muts.includes('Gold') ? 25 : 1;
  const env = muts.filter((m) => MUT_COIN[m] != null);
  return base * scale * growth * (1 + env.reduce((t, m) => t + MUT_COIN[m], 0) - env.length);
}
const friendBonus = (filled) => Math.min(2, 1 + Math.max(0, filled - 1) * 0.1);
let cropSellPrompt = null;
// Is the team for a job out? (any active pet with an ability for it); its best team, if one exists and isn't out
const teamOutFor = (key) => {
  const g = TEAM_GOALS.find((x) => x.key === key); if (!g) return { out: true };
  const active = (result?.pets ?? []).filter((p) => p.loc === 'garden');
  const helps = (p) => p.abilities.some((ab) => g.cats.includes(String(A_TABLE[ab]?.[0] ?? '')));
  const best = bestTeam(g).team;
  return { out: active.some(helps) || !best.length, best, goal: g };
};
// One pop-up for a held sale or harvest: the problems found, a button to swap in the team, "do it anyway", "not yet"
function heldActionPrompt({ title, lines, teamKey, teamBtn, goLabel, stopLabel, neverKey }, resend, onClose) {
  const m = document.createElement('div'); m.id = 'mgpc-crystal';
  m.innerHTML = `<div class="card">
    <div class="big">${title}</div>
    <ul style="margin:0;padding-left:18px">${lines.map((x) => `<li>${x}</li>`).join('')}</ul>
    <div class="acts">${teamKey ? `<button data-c="team" class="main">${teamBtn}</button>` : ''}<button data-c="ok"${teamKey ? '' : ' class="main"'}>${stopLabel}</button><button data-c="go">${goLabel}</button></div>
    <div class="msg"></div>
    <div class="foot"><label><input type="checkbox" class="never"> Don't ask again (turn it back on in Settings)</label></div></div>`;
  ['keydown', 'keyup', 'keypress'].forEach((t) => m.addEventListener(t, (e) => e.stopPropagation()));
  const close = () => { if (m.querySelector('.never').checked) { for (const k of [].concat(neverKey)) settings[k] = false; saveSettings(); } m.remove(); onClose(); };
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b || !(e.isTrusted || TEST_BUILD)) return;
    if (e.detail === 0 && !TEST_BUILD) return; // made by a key (Space/Enter), not the mouse
    if (b.dataset.c === 'team') {
      // swaps the team in; the sale / harvest isn't sent: do it again yourself once they're out
      m.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      m.querySelector('.msg').textContent = 'Swapping pets…';
      applyTeam(teamKey).then(() => { close(); toast(`${teamBtn.replace(/^\S+\s/, '')}: out. Do it again now.`, { key: 'heldaction', ms: 4000 }); });
      return;
    }
    close();
    if (b.dataset.c === 'go') { try { resend(); } catch {} }
  });
  document.body.appendChild(m);
  // No button gets focus: the game's hold-to-confirm (holding Space) would otherwise "press" it when Space is let go
  try { document.activeElement?.blur?.(); } catch {}
}
// Selling crops: asks first when the crops are worth at least the set amount and the room isn't full (friend bonus),
// or no Sell Boost / Crop Refund pet is out while you have a Crop selling team
hatchGuard.onCommand('SellAllCrops', (resend) => {
  if (cropSellPrompt) return true;
  const roomOn = settings.cropSellRoomWarn !== false, teamOn = settings.cropSellTeamWarn !== false;
  if (!roomOn && !teamOn) return false;
  const inv = game.readStorage(settings.gardenOwner);
  const crops = inv.items.filter((x) => x?.itemType === 'Produce' && !inv.favorites?.has(x.id));
  const value = crops.reduce((t, x) => t + cropValue(x), 0);
  if (value < (Number(settings.cropSellWarnMin) || 0)) return false;
  const lines = [];
  const room = game.room();
  const fmt = (n) => Math.round(n).toLocaleString();
  if (roomOn && room && room.filled < room.slots) {
    const now = friendBonus(room.filled), full = friendBonus(room.slots);
    lines.push(`Your room isn't full (${room.filled} of ${room.slots}): ~${fmt(value * now)} coins now, ~${fmt(value * full)} with a full room, <b>${fmt(value * (full - now))} more</b>.`);
  }
  let teamKey = null;
  try { analyze(); } catch {}
  const t = teamOn ? teamOutFor('sell') : { out: true };
  if (!t.out) { lines.push(`No Sell Boost or Crop Refund pet is out. Your Crop selling team: ${esc(t.best.map(nameOnly).join(', '))}.`); teamKey = 'sell'; }
  if (!lines.length) return false;
  cropSellPrompt = true;
  heldActionPrompt({ title: `💰 Selling ~${fmt(value)} coins of crops`, lines, teamKey, teamBtn: '💰 Swap in the Crop selling team', goLabel: 'Sell anyway', stopLabel: "Don't sell yet", neverKey: ['cropSellRoomWarn', 'cropSellTeamWarn'] }, resend, () => { cropSellPrompt = null; });
  return true;
});
// Harvesting a Gold or Rainbow celestial crop: asks first when no Double Harvest pet is out but you have a Harvesting team
let harvestPrompt = null;
hatchGuard.onCommand('HarvestCrop', (resend, payload) => {
  if (harvestPrompt) return true;
  if (settings.harvestTeamWarn === false) return false;
  try {
    const cmd = payload?.command ?? payload;
    const r = game.riding(settings.gardenOwner); const tile = r?.garden?.tileObjects?.[cmd.slot];
    const slot = (tile?.slots ?? []).find((x) => x && x.slotId === cmd.slotsIndex) ?? tile?.slots?.[cmd.slotsIndex];
    if (!slot) return false;
    const muts = slot.mutations ?? [];
    const plants = unwrapLive(liveData?.plants) ?? {};
    const celestial = /celestial/i.test(String(plants[slot.species]?.seed?.rarity ?? ''));
    if (!celestial || !(muts.includes('Gold') || muts.includes('Rainbow'))) return false;
    analyze();
    const t = teamOutFor('harvest'); if (t.out) return false;
    harvestPrompt = true;
    const name = plants[slot.species]?.crop?.name ?? pretty(slot.species);
    heldActionPrompt({ title: `🧺 Harvesting a ${muts.includes('Rainbow') ? 'Rainbow' : 'Gold'} ${esc(name)}`, lines: [`No Double Harvest pet is out (a chance of a second one). Your Harvesting team: ${esc(t.best.map(nameOnly).join(', '))}.`], teamKey: 'harvest', teamBtn: '🧺 Swap in the Harvesting team', goLabel: 'Harvest anyway', stopLabel: "Don't harvest yet", neverKey: 'harvestTeamWarn' }, resend, () => { harvestPrompt = null; });
    return true;
  } catch { return false; }
});
// Hatch pop-up buttons: one per hatching team that you have pets for (swaps it in; doesn't hatch)
const HATCH_TEAM_KEYS = ['maxStr', 'mutation', 'rare'];
function hatchTeamBtns() {
  if (settings.featHatchFix === false || settings.idleBlock === false) return '';
  try { analyze(); } catch {}
  // The team the egg planner picks for the egg you pressed Hatch on (the journal entry it still needs); with that
  // egg's journal done, Gold / Rainbow (more dust)
  let want = null, why = '';
  try {
    const e = heldEggId && (journalPlan() ?? []).find((x) => x.id === heldEggId);
    if (e) { want = e.hardest?.kind?.team ?? 'mutation'; why = e.hardest ? `${e.name}: for ${pretty(e.hardest.sp)} ${e.hardest.kind.why}` : `${e.name}: journal done, Gold / Rainbow for dust`; }
  } catch {}
  const btns = HATCH_TEAM_KEYS.map((k) => TEAM_GOALS.find((g) => g.key === k)).filter((g) => g && bestTeam(g).team.length)
    .map((g) => `<button data-c="team" data-team-key="${g.key}"${g.key === want ? ' class="main"' : ''} title="${esc((g.key === want ? `★ ${why}\n` : '') + bestTeam(g).team.map(nameOnly).join(', '))}">${g.key === want ? '★ ' : ''}${g.icon} ${esc(g.title)}</button>`);
  return btns.length ? `<div class="hteams"><span class="muted">Swap in a team:</span> ${btns.join('')}</div>${want && why ? `<div class="muted" style="font-size:12px">★ ${esc(why)}</div>` : ''}` : '';
}
function showHatchPrompt(issues) {
  const m = document.createElement('div'); m.id = 'mgpc-crystal';
  const idleText = issues.idle ? issues.idle.map((p) => `${p.species} (${p.abilities.map(pretty).join(', ') || 'no abilities'})`).join(', ') : '';
  m.innerHTML = `<div class="card">
    <div class="big">${issues.crystal ? "💎 Your Strength Crystal isn't out!" : "🐾 Some pets out don't help hatching!"}</div>
    <div>The hatch was stopped.</div>
    <ul style="margin:0;padding-left:18px">
      ${issues.crystal ? '<li>Put the Strength Crystal out first: without it your hatch pets get no +10 STR.</li>' : ''}
      ${issues.idle ? `<li>${esc(idleText)} ${issues.idle.length === 1 ? "is out but doesn't" : "are out but don't"} help with hatching. Swap in hatch pets${settings.featHatchFix === false ? ' (🧪 Teams → Apply)' : ' with a button below'}.</li>` : ''}
    </ul>
    <div class="acts">${issues.crystal && crystalPlan() ? '<button data-c="place" class="main">💎 Put the crystal out</button>' : ''}<button data-c="ok"${issues.crystal && crystalPlan() ? '' : ' class="main"'}>OK, I'll fix it</button></div>
    ${issues.idle ? hatchTeamBtns() : ''}
    ${issues.crystal && !crystalPlan() && settings.featCrystalPlace !== false ? '<div class="note">No picked-up Strength Crystal found in your inventory or Tool Shack (shards don\'t count), so it can\'t be put out for you.</div>' : ''}
    <div class="msg"></div>
    <div class="foot"><label><input type="checkbox" class="never"> Don't show this again (turn it back on in Settings)</label>
    <a href="#" data-c="anyway" class="anyway">hatch anyway</a></div></div>`;
  ['keydown', 'keyup', 'keypress'].forEach((t) => m.addEventListener(t, (e) => e.stopPropagation()));
  const finish = (hatch, snooze = hatch) => {
    if (m.querySelector('.never').checked) {
      if (issues.crystal) settings.crystalBlock = false;
      if (issues.idle) settings.idleBlock = false;
      saveSettings();
    }
    const held = heldHatches.splice(0);
    m.remove(); hatchPrompt = null;
    if (snooze) hatchAsked = true; // "hatch anyway": stop asking until a reload
    if (hatch) held.forEach((f) => { try { f(); } catch {} });
  };
  // "hatch anyway" is a small link down in the corner, away from OK, and does nothing for the first second
  const armedAt = Date.now() + 1000;
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b || !(e.isTrusted || TEST_BUILD)) return;
    e.preventDefault();
    if (e.detail === 0 && !TEST_BUILD) return; // made by a key (Space/Enter), not the mouse
    if (b.dataset.c === 'anyway' && Date.now() < armedAt && !TEST_BUILD) return;
    if (b.dataset.c === 'place') {
      // Only puts your Strength Crystal (never a shard) on its tile. The egg is not hatched: press Hatch again yourself.
      m.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      m.querySelector('.msg').textContent = 'Putting the crystal out…';
      putOutCrystal().then((r) => {
        m.querySelectorAll('button').forEach((x) => { x.disabled = false; });
        if (r.ok && !issues.idle) { finish(false, false); toast('💎 The crystal is out. Press Hatch again.', { key: 'hatchfix', ms: 4000 }); return; }
        m.querySelector('.msg').textContent = r.ok ? '💎 The crystal is out. Fix the pets, then press Hatch again.' : `Couldn't: ${r.reason}.`;
        if (r.ok) m.querySelector('[data-c="place"]')?.remove();
      });
      return;
    }
    if (b.dataset.c === 'team') {
      // Swaps the chosen hatching team into your active slots. The egg is not hatched: press Hatch again yourself.
      const key = b.dataset.teamKey;
      m.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      m.querySelector('.msg').textContent = 'Swapping pets…';
      applyTeam(key).then(() => {
        m.querySelectorAll('button').forEach((x) => { x.disabled = false; });
        const stillIdle = idleForTask('hatch').length;
        const crystalNeeded = issues.crystal && !crystalOut();
        if (!stillIdle && !crystalNeeded) { finish(false, false); toast('🐾 Hatching team is out. Press Hatch again.', { key: 'hatchfix', ms: 4000 }); return; }
        m.querySelector('.msg').textContent = stillIdle ? (teamMsg[key] || 'Some pets out still don\'t help hatching.') : '🐾 Hatching team is out. Put the crystal out, then press Hatch again.';
        if (!stillIdle) m.querySelector('.hteams')?.remove();
      });
      return;
    }
    finish(b.dataset.c === 'anyway');
  });
  document.body.appendChild(m);
  hatchPrompt = m;
  // the egg's recommended team is the main button then
  const rec = m.querySelector('.hteams .main');
  if (rec) m.querySelector('[data-c="ok"]').classList.remove('main');
  try { document.activeElement?.blur?.(); } catch {} // no button focused: a held Space (hold-to-confirm) mustn't press it
}

function modal(html) {
  document.getElementById('mgpc-modal')?.remove();
  const m = document.createElement('div'); m.id = 'mgpc-modal';
  m.innerHTML = `<div class="card">${html}</div>`;
  ['keydown', 'keyup', 'keypress'].forEach((t) => m.addEventListener(t, (e) => e.stopPropagation()));
  document.body.appendChild(m);
  return m;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startSell(ids) {
  if (busy) return;
  // Re-read and re-check right before asking: only pets that are STILL useless, sellable and selected
  analyze();
  const want = new Set(ids || []);
  const picks = [...result.useless, ...(result.maybe ?? []).map((x) => x.p)].filter((p) => want.has(p.id) && !sellBlock(p));
  if (!picks.length) { render(); return; }
  const fromHutch = picks.filter((p) => p.loc === 'hutch').length;
  const dust = picks.reduce((t, p) => t + (p.dust || 0), 0).toLocaleString();
  const rainbow = picks.filter((p) => p.mutations.includes('Rainbow')).length; // only Rainbow pets need the extra tick
  const warns = settings.taskWarnings === false ? [] : taskWarnings('sellPet');
  const m = modal(`<b style="font-size:16px">Sell ${picks.length} pet${picks.length === 1 ? '' : 's'} for ~${dust} dust?</b>
    ${warns.length ? `<div class="sellwarn"><div class="big">⚠ Your pets out aren't set up for selling</div>
      <ul>${warns.map((x) => `<li>${esc(x[0].toUpperCase() + x.slice(1))}</li>`).join('')}</ul>
      <div>Pet Refund and Dust Boost only work from your active pets.${settings.featSellFix === false ? '' : ' Fix it first:'}</div>
      ${settings.featSellFix === false ? '' : `<label class="sellteam">Team: <select data-m="sellteam"><option value="dust" ${settings.sellTeam !== 'refund' ? 'selected' : ''}>✨ Pet dust (refund + dust boost)</option><option value="refund" ${settings.sellTeam === 'refund' ? 'selected' : ''}>♻️ Pet refund only</option></select></label>
      <div class="acts" style="justify-content:flex-start;flex-wrap:wrap">${!crystalOut() && crystalPlan() ? '<button data-m="fixboth" class="main">Put out the crystal + swap in the team</button><button data-m="crystalout">Just the crystal</button><button data-m="swapsell">Just the team</button>' : `<button data-m="swapsell" class="main">Swap in the team</button>${crystalOut() || settings.featCrystalPlace === false ? '' : '<span class="muted">(Put the crystal out by hand this time, where you want it: after that the mod remembers the spot and can do it for you.)</span>'}`}<span class="muted swapst"></span></div>`}</div>` : ''}
    <div class="muted">Sold pets can't be recovered.${fromHutch ? ` ${fromHutch} will be moved out of the hutch first.` : ''} Selling stops at the first problem. Locked pets, active pets and pets not yet in your journal are never sold.</div>
    <div class="list">${picks.map((p) => `<div class="row" data-row="${esc(p.id)}" style="display:flex;gap:8px;align-items:flex-start">${petImg(p, 32)}<div>${locIcon(p.loc)} <b>${esc(label(p))}</b> <span class="muted">~${(p.dust || 0).toLocaleString()} dust</span><div>${abilityTags(p)}</div><div class="muted st"></div></div></div>`).join('')}</div>
    ${rainbow ? `<label style="display:flex;gap:8px;align-items:center;color:#e6c46a"><input type="checkbox" data-m="yes"> 🌈 Includes ${rainbow} Rainbow pet${rainbow === 1 ? '' : 's'} — yes, sell ${rainbow === 1 ? 'it' : 'them'}.</label>` : ''}
    <div class="acts"><button data-m="cancel">Cancel</button><button data-m="go" class="danger" disabled>Sell ${picks.length}</button></div>`);
  const go = m.querySelector('[data-m="go"]'), yes = m.querySelector('[data-m="yes"]');
  const ticked = () => !yes || yes.checked;
  m.querySelector('[data-m="cancel"]').focus();
  let armed = false;
  setTimeout(() => { armed = true; go.disabled = !ticked(); }, rainbow ? 1500 : 600); // a double-click can't go straight through
  if (yes) yes.addEventListener('change', () => { go.disabled = !(ticked() && armed); });
  m.querySelector('[data-m="sellteam"]')?.addEventListener('change', (e) => { settings.sellTeam = e.target.value; saveSettings(); });
  const choice = await new Promise((res) => {
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') res('cancel'); });
    m.addEventListener('click', (e) => {
      if (e.target === m) return res('cancel');
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.m === 'cancel') return res('cancel');
      if (['swapsell', 'crystalout', 'fixboth'].includes(b.dataset.m) && (e.isTrusted || TEST_BUILD)) {
        // Fix it right here: put the crystal out and/or swap the best pet dust team (refund + dust) in, then re-check
        const box = m.querySelector('.sellwarn'), st = m.querySelector('.swapst');
        box.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        (async () => {
          const notes = [];
          if (b.dataset.m !== 'swapsell') { st.textContent = 'Putting the crystal out…'; const r = await putOutCrystal(); if (!r.ok) notes.push(`Crystal: ${r.reason}.`); }
          const teamKey = settings.sellTeam === 'refund' ? 'refund' : 'dust';
          if (b.dataset.m !== 'crystalout') { st.textContent = 'Swapping…'; await applyTeam(teamKey); if (teamMsg[teamKey]) notes.push(teamMsg[teamKey]); }
          const left = taskWarnings('sellPet');
          if (!left.length) { box.classList.add('ok'); box.innerHTML = `✅ Crystal and ${teamKey === 'refund' ? 'pet refund' : 'pet dust'} team are out. Ready to sell.`; return; }
          box.querySelector('ul').innerHTML = left.map((x) => `<li>${esc(x[0].toUpperCase() + x.slice(1))}</li>`).join('');
          box.querySelectorAll('button').forEach((x) => { x.disabled = false; });
          if (crystalOut()) box.querySelectorAll('[data-m="fixboth"], [data-m="crystalout"]').forEach((x) => x.remove());
          st.textContent = notes.join(' ') || 'Done.';
        })();
        return;
      }
      if (b.dataset.m === 'go' && !b.disabled && ticked() && armed && (e.isTrusted || TEST_BUILD)) return res('go');
    });
  });
  if (choice !== 'go') { m.remove(); return; }
  m.querySelector('.acts').innerHTML = '<span class="muted">Selling… keep this tab open.</span>';
  if (yes) yes.disabled = true;

  busy = true;
  net.authorizeSell(picks.map((p) => p.id)); // the command sender refuses any SellPet not in this list
  const status = (id, text, cls) => { const row = m.querySelector(`[data-row="${CSS.escape(id)}"]`); if (row) { row.querySelector('.st').textContent = text; if (cls) row.classList.add(cls); } };
  let sold = 0, stopped = null;
  // Built outside the loop (keeps Tampermonkey's code checker happy)
  const arrivedIn = (id, loc) => () => game.where(id, settings.gardenOwner) === loc;
  const goneFrom = (id) => () => !game.where(id, settings.gardenOwner);
  try {
    for (const p of picks) {
      if (!net.readiness(true).ok) throw new Error(net.readiness(true).reason);
      // Re-check this pet against the live game right before touching it
      analyze();
      const now = result?.pets.find((q) => q.id === p.id);
      if (!now) { status(p.id, 'already gone — skipped'); continue; }
      if (now.loc === 'garden') { status(p.id, 'now in your garden — skipped'); continue; }
      if (result.locked.has(p.id)) { status(p.id, 'now locked — skipped'); continue; }
      if (!result.useless.find((q) => q.id === p.id) && !result.maybe?.find((x) => x.p.id === p.id)) { status(p.id, 'no longer useless under your rules — skipped'); continue; }
      if (now.species !== p.species || now.abilities.join() !== p.abilities.join()) { status(p.id, 'changed — skipped'); continue; }
      if (!result.journalReadable || now.unlogged?.length) { status(p.id, 'not in your journal yet — skipped'); continue; }
      if (now.loc === 'hutch') {
        status(p.id, 'moving out of the hutch…');
        const r = await net.send({ type: 'RetrieveItemFromStorage', itemId: p.id, storageId: 'PetHutch' });
        if (!r.ok) { status(p.id, `couldn't move it out of the hutch (${r.code})`, 'bad'); throw new Error(`Moving a pet out of the hutch failed (${r.code}). Is your inventory full?`); }
        const moved = await game.waitFor(arrivedIn(p.id, 'inventory'));
        if (!moved) { status(p.id, 'did not arrive in inventory', 'bad'); throw new Error('A pet did not arrive in your inventory.'); }
        await sleep(150);
      }
      status(p.id, 'selling…');
      const r = await net.send({ type: 'SellPet', itemId: p.id });
      if (!r.ok) { status(p.id, `sell failed (${r.code})`, 'bad'); throw new Error(`The game refused a sale (${r.code}).`); }
      await game.waitFor(goneFrom(p.id), 3000);
      status(p.id, 'sold ✔', 'ok'); sold += 1; selected.delete(p.id);
      await sleep(250);
    }
  } catch (err) {
    stopped = err.message || String(err);
  } finally {
    net.revokeSell();
    busy = false;
  }
  m.querySelector('.acts').innerHTML = `<span class="muted" style="flex:1">${stopped ? `Stopped: ${esc(stopped)} ` : ''}Sold ${sold} of ${picks.length}.</span><button data-m="done">Done</button>`;
  m.querySelector('[data-m="done"]').onclick = () => { m.remove(); analyze(); render(); };
}

// ---------- start ----------
// Only show up once a game room is open (the script also loads on the sites' other pages, e.g. the home page)
loadLiveData(false);
// Mount once the page and the game connection exist
// ---------- Keep awake: the game keeps running while its tab is unfocused or hidden ----------
// Same approach as Arie's Mod's anti-AFK: the page is told it's always visible and focused (visibility/focus events are
// swallowed before the game sees them), a silent audio tone stops the browser from throttling the tab, and every 60 s the
// player's current position is resent so the server doesn't treat you as idle. Turning it off undoes all of it.
const keepAwake = (() => {
  const STOP = ['visibilitychange', 'blur', 'focus', 'focusout', 'pagehide', 'freeze', 'resume']; // Arie's Mod's list
  const docProto = Object.getPrototypeOf(document);
  const saved = { hidden: Object.getOwnPropertyDescriptor(docProto, 'hidden'), vis: Object.getOwnPropertyDescriptor(docProto, 'visibilityState'), hasFocus: document.hasFocus };
  const notHidden = () => false, visible = () => 'visible';
  const swallow = (e) => { e.stopImmediatePropagation(); };
  let on = false, audio = null, ping = null, beat = null;
  // Another mod (Arie's Mod, QPM's Anti-AFK) already keeping the game awake: its own patch sits on document.hidden
  const othersHandleIt = () => {
    const d = Object.getOwnPropertyDescriptor(docProto, 'hidden');
    if (!d || !d.get || d.get === notHidden) return false;
    if (d.get !== saved.hidden?.get) return true; // patched after this mod started
    // already patched before this mod started (the browser's own getter is native code)
    if (TEST_BUILD) return false; // the test page's getters aren't native
    try { return !/\[native code\]/.test(Function.prototype.toString.call(d.get)); } catch { return true; }
  };
  const startAudio = () => {
    if (audio || !on) return;
    try {
      const AC = W.AudioContext || W.webkitAudioContext; if (!AC) return;
      const ctx = new AC(); const gain = ctx.createGain(); gain.gain.value = 0.00001;
      const osc = ctx.createOscillator(); osc.frequency.value = 1; osc.connect(gain).connect(ctx.destination); osc.start();
      audio = { ctx, osc, gain };
    } catch { audio = null; }
  };
  // browsers only let audio start after a click or key press
  const onGesture = () => { startAudio(); if (audio?.ctx.state !== 'running') audio?.ctx.resume?.().catch(() => {}); };
  return {
    get on() { return on; },
    othersHandleIt,
    start() {
      if (on || othersHandleIt()) return; on = true;
      try { Object.defineProperty(docProto, 'hidden', { configurable: true, get: notHidden }); } catch {}
      try { Object.defineProperty(docProto, 'visibilityState', { configurable: true, get: visible }); } catch {}
      try { document.hasFocus = () => true; } catch {}
      for (const t of STOP) { W.addEventListener(t, swallow, true); document.addEventListener(t, swallow, true); }
      W.addEventListener('pointerdown', onGesture, true); W.addEventListener('keydown', onGesture, true);
      startAudio();
      net.pingPosition();
      ping = setInterval(() => { net.pingPosition(); if (audio && audio.ctx.state !== 'running') audio.ctx.resume?.().catch(() => {}); }, 60000);
      beat = setInterval(() => { try { (document.querySelector('canvas') || document.body)?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 })); } catch {} }, 25000);
    },
    stop() {
      if (!on) return; on = false;
      for (const t of STOP) { W.removeEventListener(t, swallow, true); document.removeEventListener(t, swallow, true); }
      W.removeEventListener('pointerdown', onGesture, true); W.removeEventListener('keydown', onGesture, true);
      // only undo what is still ours (another mod may have put its own patch on top)
      try { if (Object.getOwnPropertyDescriptor(docProto, 'hidden')?.get === notHidden) { if (saved.hidden) Object.defineProperty(docProto, 'hidden', saved.hidden); else delete docProto.hidden; } } catch {}
      try { if (Object.getOwnPropertyDescriptor(docProto, 'visibilityState')?.get === visible && saved.vis) Object.defineProperty(docProto, 'visibilityState', saved.vis); } catch {}
      try { if (saved.hasFocus && !othersHandleIt()) document.hasFocus = saved.hasFocus; } catch {}
      clearInterval(ping); clearInterval(beat); ping = beat = null;
      try { audio?.osc.stop(); audio?.ctx.close(); } catch {}
      audio = null;
    },
  };
})();
// ---------- Plant card hint: a plant's missing journal entries, shown above the game's plant card ----------
// The game draws that card with Pixi (labels GardenInfoCardSystem / GardenInfoObjectCard, as Arie's Mod reads them).
// The renderer is picked up the way Arie's Mod does (the __PIXI_*_INIT__ hooks the game calls, or __PIXI_DEVTOOLS__).
// Read-only: it only looks at the card's title to know the species and draws a row of icons above it.
const pixi = { app: null, renderer: null };
(() => {
  const hook = (name, cb) => {
    const prev = W[name];
    W[name] = function (...args) { try { cb(...args); } catch {} if (typeof prev === 'function') { try { return prev.apply(this, args); } catch {} } };
  };
  hook('__PIXI_APP_INIT__', (a) => { pixi.app = a; if (a?.renderer) pixi.renderer = a.renderer; });
  hook('__PIXI_RENDERER_INIT__', (r) => { pixi.renderer = r; });
})();
const MUTATION_SPRITE = { Gold: 'Gold', Rainbow: 'Rainbow', Wet: 'Wet', Chilled: 'Chilled', Frozen: 'Frozen', Thunderstruck: 'Thunderstruck', Thundercharged: 'Thundercharged', Dawnlit: 'Dawnlit', Amberlit: 'Amberlit', Dawnbound: 'Dawncharged', Amberbound: 'Ambercharged' };
const variantIconHtml = (v, px = 22) => MUTATION_SPRITE[v]
  ? `<img src="https://mg-api.ariedam.fr/assets/sprites/ui/Mutation${MUTATION_SPRITE[v]}.png" alt="" style="width:${px}px;height:${px}px;object-fit:contain" onerror="this.replaceWith(document.createTextNode('${VARIANT_ICON[v] ?? ''}'))">`
  : `<span style="font-size:${Math.round(px * 0.8)}px;line-height:${px}px">${VARIANT_ICON[v] ?? ''}</span>`;
(() => { // plant card hint
  let box = null, cardSystem = null, lastFind = 0, lastKey = '';
  const renderer = () => pixi.renderer || pixi.app?.renderer || (() => { try { const d = W.__PIXI_DEVTOOLS__; return d?.renderers?.size ? [...d.renderers][0] : (d?.renderer ?? null); } catch { return null; } })();
  const findIn = (root, pred, limit) => {
    const stack = [root]; let n = 0;
    while (stack.length && n++ < limit) { const x = stack.pop(); if (!x) continue; if (pred(x)) return x; if (Array.isArray(x.children)) for (const c of x.children) stack.push(c); }
    return null;
  };
  const findAll = (root, pred, limit) => {
    const out = [], stack = [root]; let n = 0;
    while (stack.length && n++ < limit) { const x = stack.pop(); if (!x) continue; if (pred(x)) out.push(x); if (Array.isArray(x.children)) for (let i = x.children.length - 1; i >= 0; i--) stack.push(x.children[i]); }
    return out; // in drawing order (first child first)
  };
  const findSystem = (stage) => {
    if (!stage) return null;
    for (const branch of stage.children ?? []) { const f = findIn(branch, (x) => x.label === 'GardenInfoCardSystem', 30000); if (f) return f; }
    return null;
  };
  const visibleUp = (x) => { for (let n = x; n; n = n.parent) if (n.visible === false || n.renderable === false || n.alpha === 0) return false; return true; };
  const hide = () => { if (box) box.style.display = 'none'; lastKey = ''; };
  const speciesFromTitle = (title) => {
    const t = String(title ?? '').trim().toLowerCase(); if (!t) return null;
    const plants = unwrapLive(liveData?.plants) ?? {};
    for (const [sp, d] of Object.entries(plants)) if (String(d?.crop?.name ?? '').toLowerCase() === t || String(d?.plant?.name ?? '').toLowerCase() === t || sp.toLowerCase() === t) return sp;
    return (cropJournalState() ?? []).find((c) => c.name.toLowerCase() === t || c.sp.toLowerCase() === t)?.sp ?? null;
  };
  let iconRect = null; // where the card's plant picture is on the page (right-click toggles the hint)
  const tick = () => {
    iconRect = null;
    try {
      if (!document.body) return hide();
      const r = renderer(); if (!r) return hide();
      const stage = r.lastObjectRendered ?? r.stage ?? pixi.app?.stage; if (!stage) return hide();
      if (!cardSystem || cardSystem.destroyed || !cardSystem.parent) { if (Date.now() - lastFind < 2000) return hide(); lastFind = Date.now(); cardSystem = findSystem(stage); if (!cardSystem) return hide(); }
      // Several cards can be up (e.g. a pet standing on the tile, or a plant with several crops and ‹ › arrows):
      // use the visible one whose texts name a plant
      let card = null, row = null, sp = null;
      for (const cand of findAll(cardSystem, (x) => x.label === 'GardenInfoObjectCard', 3000)) {
        if (!visibleUp(cand)) continue;
        const tr = findIn(cand, (x) => x.label === 'GardenInfoObjectTitleRow', 500);
        const texts = [...(tr ? findAll(tr, (x) => typeof x.text === 'string' && x.text.trim(), 500) : []), ...findAll(cand, (x) => typeof x.text === 'string' && x.text.trim(), 800)];
        for (const t of texts) { const hit = speciesFromTitle(t.text); if (hit) { sp = hit; break; } }
        if (sp) { card = cand; row = tr || cand; break; }
      }
      if (!card) return hide();
      { const cv = r.canvas || r.view, rc = cv?.getBoundingClientRect?.(), cb0 = card.getBounds?.();
        if (rc?.width && cb0) { const kx = rc.width / (r.screen?.width || cv.width), ky = rc.height / (r.screen?.height || cv.height);
          iconRect = { left: rc.left + cb0.x * kx, top: rc.top + cb0.y * ky, right: rc.left + (cb0.x + Math.min(cb0.width, cb0.height)) * kx, bottom: rc.top + (cb0.y + cb0.height) * ky }; } }
      if (settings.featPlantHint === false) return hide();
      const st = cropJournalState(); const c = st?.find((x) => x.sp === sp); if (!c) return hide();
      const missing = CROP_VARIANTS.filter((v) => !c.logged.has(v));
      // Where the card is on screen: its global bounds, scaled from the renderer to the page
      const canvas = r.canvas || r.view; const rect = canvas?.getBoundingClientRect?.(); if (!rect?.width) return hide();
      const b = (row !== card ? row : card).getBounds?.(); const cb = card.getBounds?.(); if (!b || !cb) return hide();
      const sx = rect.width / (r.screen?.width || canvas.width), sy = rect.height / (r.screen?.height || canvas.height);
      // Anchored to the card's fixed hit area (or its title row), not its drawn bounds: the plant picture grows when
      // hovered, which would make the row jump up and down
      let cx, top;
      const ha = card.hitArea;
      if (ha && typeof card.toGlobal === 'function' && Number.isFinite(ha.width)) {
        const g = card.toGlobal({ x: (ha.x ?? 0) + ha.width / 2, y: ha.y ?? 0 });
        cx = rect.left + g.x * sx; top = rect.top + g.y * sy;
      } else {
        cx = rect.left + (b.x + b.width / 2) * sx; top = rect.top + b.y * sy - (row !== card ? 12 : 0);
        if (row === card) cx = rect.left + (cb.x + cb.width / 2) * sx;
      }
      if (!box) { box = document.createElement('div'); box.id = 'mgpc-planthint'; document.body.appendChild(box); }
      const key = sp + '|' + missing.join(',');
      if (key !== lastKey) {
        lastKey = key;
        box.innerHTML = missing.length
          ? `<span class="t">Not logged:</span>${missing.map((v) => `<span class="v" title="${esc(v)}">${variantIconHtml(v)}</span>`).join('')}`
          : '<span class="t">✔ Every variant logged</span>';
      }
      box.style.display = 'flex';
      // Sit above whatever the game draws above the card (the crop's coin value, a mutation's name tooltip, …)
      const bw = box.offsetWidth || 160, bh = box.offsetHeight || 30;
      let bottom = top - 8;
      try {
        const inCard = (x) => { for (let n = x; n; n = n.parent) if (n === card) return true; return false; };
        // the card system itself, plus UI branches next to it that look like labels / tooltips (never the world: plants, pets)
        const layers = [cardSystem, ...(cardSystem.parent?.children ?? []).filter((c) => c !== cardSystem && /tooltip|info|price|value|label|card|popup/i.test(String(c.label ?? '')))];
        const tops = [];
        for (const x of layers.flatMap((ly) => findAll(ly,(n) => !(n.children?.length) && (n.texture || typeof n.text === 'string' || n.context), 3000))) {
          if (inCard(x) || !visibleUp(x)) continue;
          const g = x.getBounds?.(); if (!g || !(g.width > 0) || !(g.height > 0) || g.width * sx > 600) continue;
          const l = rect.left + g.x * sx, rgt = l + g.width * sx, t = rect.top + g.y * sy, btm = t + g.height * sy;
          if (rgt < cx - bw / 2 - 4 || l > cx + bw / 2 + 4 || btm < top - 260 || t > top + 2) continue; // only things just above the card
          tops.push([t, btm]);
        }
        tops.sort((p, q) => q[1] - p[1]);
        for (const [t, btm] of tops) if (btm > bottom - bh - 2 && t < bottom) bottom = t - 4; // stack upward past each overlap
        bottom = Math.max(bottom, top - 8 - 160);
      } catch {}
      box.style.left = Math.round(cx) + 'px'; box.style.top = Math.round(bottom) + 'px';
    } catch { hide(); }
  };
  setInterval(tick, 200);
  // Right-click the plant picture on the game's card: turns the hint on or off (for every plant)
  W.addEventListener('contextmenu', (e) => {
    const k = iconRect; if (!k || e.clientX < k.left || e.clientX > k.right || e.clientY < k.top || e.clientY > k.bottom) return;
    e.preventDefault(); e.stopPropagation();
    settings.featPlantHint = settings.featPlantHint === false; saveSettings(); tick();
    try { render(); } catch {}
  }, true);
  return { tick };
})();
// ---------- Game's client-side values (jotai atoms): the world map and your grid position ----------
// The game keeps some values only in its page store (the world map layout, your position), not in the room state. Read
// the way Arie's Mod / QPM do: atoms from window.jotaiAtomCache by their label; a static atom's value is its init,
// others are read with the store's get, picked up once from the first atom write (atom writes are then restored).
const jotai = (() => {
  let get = null, patching = false;
  const cache = () => W.jotaiAtomCache?.cache;
  const find = (re) => { const c = cache(); if (!c) return null; for (const a of c.values()) { const l = a?.debugLabel || a?.label || ''; if (re.test(String(l))) return a; } return null; };
  const capture = () => {
    const c = cache(); if (!c || get || patching) return;
    patching = true; const patched = [];
    const restore = () => { for (const a of patched) { try { a.write = a.__mgpcWrite; delete a.__mgpcWrite; } catch {} } patched.length = 0; patching = false; };
    const onWrite = (g) => { if (!get) { get = g; setTimeout(restore, 0); } };
    const wrapWrite = (orig) => function (g, ...rest) { onWrite(g); return orig.call(this, g, ...rest); };
    for (const a of c.values()) {
      if (!a || typeof a.write !== 'function' || a.__mgpcWrite) continue;
      a.__mgpcWrite = a.write; patched.push(a);
      a.write = wrapWrite(a.__mgpcWrite);
    }
    setTimeout(restore, 5000);
  };
  const read = (re) => {
    const a = find(re); if (!a) return undefined;
    if (get) { try { return get(a); } catch {} }
    if ('init' in a && a.init != null && typeof a.read !== 'function') return a.init;
    capture();
    return 'init' in a ? a.init : undefined;
  };
  const live = (re) => { const a = find(re); if (!a) return undefined; if (!get) { capture(); return undefined; } try { return get(a); } catch { return undefined; } };
  return { read, live, capture };
})();
try { W.__mglhIdFromStore = () => { const v = jotai.live(/^playerIdAtom$/); if (typeof v === 'string' && v.trim()) return v.trim(); const pl = jotai.live(/^player(?:Data)?Atom$/); return typeof pl?.id === 'string' ? pl.id : null; }; } catch {}
// ---------- Riding a pet with a pressable crop ability: what pressing it would do where you stand ----------
// Thundercharger: Thunderstruck crops in the 3×3 around you become Thundercharged (count of crops).
// Dawn / Amber Capture: Dawn / Amber mutations in the 3×3 become capsules: lit = 1, charged (bound) = 2.
// The 3×3 is the abilities' tileRadius 1; tiles are found through the game's map (grid → your dirt/boardwalk tiles).
const RIDE_ABILITIES = {
  Thundercharger: { icon: '🌩️', name: 'Thundercharger', unit: (n) => `${n} crop${n === 1 ? '' : 's'} to charge`, count: (m) => (m.includes('Thunderstruck') ? 1 : 0), perSlot: true },
  DawnCapture: { icon: '🌅', name: 'Dawn Capture', unit: (n) => `${n} Dawn capsule${n === 1 ? '' : 's'}`, count: (m) => (m.includes('Dawncharged') ? 2 : 0) + (m.includes('Dawnlit') ? 1 : 0) },
  AmberCapture: { icon: '🟠', name: 'Amber Capture', unit: (n) => `${n} Amber capsule${n === 1 ? '' : 's'}`, count: (m) => (m.includes('Ambercharged') ? 2 : 0) + (m.includes('Ambershine') ? 1 : 0) },
};
(() => { // riding hint
  let box = null, lastHtml = '';
  const hide = () => { if (box) box.style.display = 'none'; lastHtml = ''; };
  const tick = () => {
    try {
      if (settings.featMountHint === false || !document.body) return hide();
      const r = game.riding(settings.gardenOwner); if (!r?.petId) return hide();
      const pet = r.pets.find((p) => p.id === r.petId); if (!pet) return hide();
      const abs = (pet.abilities ?? []).filter((a) => RIDE_ABILITIES[a]); if (!abs.length) return hide();
      const map = jotai.read(/^(?:room|garden)?[Mm]ap(?:Data)?Atom$/);
      const posA = jotai.live(/^positionAtom$/); // the store value only (its init is just the spawn point)
      const pos = posA && Number.isFinite(posA.x) ? posA : game.lastPosition();
      if (!map?.cols || !pos || !r.garden) return hide();
      const px = Math.round(pos.x), py = Math.round(pos.y);
      const seen = new Set(), tiles = [];
      for (let dy = -1; dy <= 1; dy++) { for (let dx = -1; dx <= 1; dx++) {
        const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) continue;
        const g = x + y * map.cols;
        const d = map.globalTileIdxToDirtTile?.[g], b = map.globalTileIdxToBoardwalk?.[g];
        if (d?.dirtTileIdx != null && (d.userSlotIdx == null || d.userSlotIdx === r.slotIdx) && !seen.has('d' + d.dirtTileIdx)) { seen.add('d' + d.dirtTileIdx); tiles.push(r.garden.tileObjects?.[d.dirtTileIdx]); }
        if (b?.boardwalkTileIdx != null && (b.userSlotIdx == null || b.userSlotIdx === r.slotIdx) && !seen.has('b' + b.boardwalkTileIdx)) { seen.add('b' + b.boardwalkTileIdx); tiles.push(r.garden.boardwalkTileObjects?.[b.boardwalkTileIdx]); }
      } }
      const slots = tiles.filter((t) => t?.objectType === 'plant').flatMap((t) => (t.slots ?? []).filter(Boolean));
      const parts = abs.map((a) => { const def = RIDE_ABILITIES[a]; const n = slots.reduce((t, sl) => t + def.count(sl.mutations ?? []), 0); return `<span class="v">${def.icon} ${esc(def.name)}: <b>${esc(def.unit(n))}</b></span>`; });
      if (!box) { box = document.createElement('div'); box.id = 'mgpc-mounthint'; document.body.appendChild(box); }
      const html = `<span class="t">Here:</span>${parts.join('')}`;
      if (html !== lastHtml) { box.innerHTML = html; lastHtml = html; }
      box.style.display = 'flex';
    } catch { hide(); }
  };
  setInterval(tick, 300);
  return { tick };
})();
// Runs only when switched on and no other mod is doing it (checked again every few seconds: mods load in any order)
const applyKeepAwake = () => { if (settings.keepAwake !== false && !keepAwake.othersHandleIt()) keepAwake.start(); else keepAwake.stop(); };
applyKeepAwake();
setInterval(applyKeepAwake, 3000);
const whenRoom = () => (document.body && W.MagicCircle_RoomConnection ? mount() : setTimeout(whenRoom, 500));
whenRoom();
LOG(`v${MOD_VERSION} ready — press Alt+P or click 🐾 (bottom-left).`);

})();
