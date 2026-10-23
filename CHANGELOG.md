# MG Lategame Helper: changelog

## 0.19.0
- 📱 Game notifications (phone app): Settings → 🛒 Shop → "📱 Game notifications (phone app)…". This is a screen for the game's own restock notifications, the ones the Magic Garden phone app sends.
  - They're saved on your account on the game's server, so the app follows what you set here. The app may show it after reopening.
  - Every item of every shop is listed, whether the shop is open now or not (weather shops, the Spooky shop). For each item: 🔔 notify / 🔕 none, its picture and rarity, and the shops that sell it.
  - Search, a filter (all / notifying / not notifying), a shop filter, "all listed" 🔔/🔕 per group (asks first for more than 5 items) and "Turn all off…". Other notifications on your account (weather, day & night, daily quests) are listed too, with their switches.
  - Items sold only in the Spooky shop show "not offered": the game doesn't offer notifications for them.
  - The mod reads and changes the list the same way the game does (…/api/rooms/<room>/notifications/subscriptions, POST …/notifications/subscribe or /unsubscribe with { subject, itemId }, POST …/notifications/unsubscribe-all), one change at a time and only when you press a switch.
- 🔔 → 📱 "When I change an item's alert, also switch its phone-app notification" (on by default; Settings → 🛒 Shop).
  - Setting an item to 🔔 or 🔁 in this mod turns its game notification on; 🔕 turns it off. This covers the alerts menu, the Shop tab's bells, the Arie's Mod import, Reset and the rarity default.
  - Only items whose alert changed are touched, so notifications you set by hand for other items stay.
  - It asks first when one change affects more than 15 items, and shows a short note of what changed.
- Both can be switched off: the whole thing in Settings → Features ("📱 Game notifications screen"), the alert link with its own switch in Settings → 🛒 Shop.

## 0.18.9
- 🔔 Import alerts from Arie's Mod: "Import from Arie's Mod…" in Settings → 🛒 Shop (next to the alerts menu) and in the 🔔 Alerts menu.
  - It reads Arie's Mod's settings in this browser: the shop items it follows, each item's sound rule and its shop defaults.
  - Each followed item maps to: loop → 🔁 repeating, one-shot → 🔔 once, volume 0 → 🔕 off. Items without a rule use Arie's shop default (one-shot at 70% unless changed there). Weather alerts aren't imported.
  - "Replace mine" makes your choices exactly Arie's: items it doesn't follow get no alert. "Add to mine" only changes the items Arie's follows.
- The alerts summary says what happens to items you haven't set ("no alert for the rest", or "once if Divine or rarer").

## 0.18.8
- Buying no longer stays blocked after the game's connection drops and comes back (e.g. after the tab sat in the background). The game opens a new connection, sometimes without the "Welcome" message the mod waited for, and the mod then said it wasn't connected and blocked Buy everything until the page was reloaded.
  - The mod now follows the new connection by the numbers the game shows on it: the last command the server executed (in every room frame) and the highest number sent on it. This works whether the game carries on with its numbering or starts again.
  - If another game connection is already open when the old one closes, the mod switches to it at once.
  - While no game connection is open, Buy shows "Waiting for the game to (re)connect: this clears by itself once the game is back" instead of asking for a reload.
- 📱 The phone remote's connections to the relay servers use the browser's own WebSocket, so the mod's watcher for the game's connection never sees them.

## 0.18.7
- 🤔 Maybe sell leaves out pets you locked in the game (you already chose to keep them). They still show in Useless, with Unlock, when the normal rules flag them. On your pet list from Oct 22: 28 → 23.

## 0.18.6
- Works with game release 1714. The game's room connection no longer hands out the room state (subscribeToPatches and lastRoomStateJsonable are gone), so the panel stayed on "Waiting for the game… join your garden".
  - The mod now reads the room state from the game's store (stateAtom, through window.__jotaiStore: get, and sub for changes). Nothing in the game is patched.
  - Older releases still use the connection as before.
  - Commands are sent the same way as before (the connection's sendMessage is unchanged).
- The pet-list console script (mg-grab-pets.js) reads the state and your player id from the store too (the connection's address no longer carries the player id).

## 0.18.5
- 🤔 Maybe sell lists only pets that are one backup copy short of the normal rules: the same rules with one fewer better pet needed ("Maybe sell: fewer better pets needed" in Settings).
  - It no longer drops the other protections. The Gold/Rainbow collection (your best Gold/Rainbow of each species and ability mix), extra copies of hunger and Rainbow pets, Gold pets with a long-term ability, the best of each ability mix and pets your journal still needs stay out of it.
  - Hunger and Rainbow pets were loosened by two copies instead of one before; now by one.
  - On the test copy of your pets (Sept 30): 35 → 15.
  - The reason reads e.g. "left out: 1 better pet; sold at 2".
- Two builds of each version from now on: the full one, and one without Buy-only links (no "Let people with my Buy-only link press Buy" setting; the PC ignores Buy-only codes; the phone page only takes pairing codes and has no "Share Buy-only link"). Several of your own PCs on one phone page work in both.

## 0.18.4
- Phone page: a PC removed with ✕ stays removed after reloading the page.
  - The code saved by versions before 0.18.0 was copied back into the list on every load; it's now moved over once and the old entry is deleted.
  - Opening a link or bookmark that still carries a removed PC's code doesn't add it back by itself. The page says so, with an "Add back" button.
  - Pasting the code under "Add or share codes" adds it again as before.

## 0.18.3
- 📱 Several people can press Buy on the same PC at once (your phones, people with the Buy-only link, the ntfy app button, the PC itself). There is still only ever one buy at a time, and nothing is bought twice.
  - A press while a buy is running joins it ("Already buying: progress follows") and gets the same progress and result, instead of an error.
  - A phone press while a buy started on the PC is running gets that buy's result when it ends.
  - A press in the few seconds right after a buy (while the game's stock updates) gets that buy's result. A later press with nothing left says "Nothing left to buy: bought N s ago".
  - The 10-second wait between Buy presses from Buy-only links is gone; joining covers it.

## 0.18.2
- Phone page: one card per PC, never two.
  - Each PC now sends a random id of its own (not tied to the game account or the computer), the same under every code.
  - When two codes on the page belong to the same PC (an old code from before "New code" and the new one, or someone's Buy-only link and your own code), the page keeps one: the live code, your own over a Buy-only one, the newest status. It removes the other from the phone and says so.
  - Adding a code that's already there, or the Buy-only code of a PC whose pairing code is there, adds nothing ("already here").
- 📱 "New code" on the PC first marks the old code as replaced. Phones still on it show "Old code: it was replaced by a new one on this PC" instead of "PC offline", and drop it once the new link is added.
- Settings lists typed as text (ignored species and the like) drop repeated entries.

## 0.18.1
- 🛒 "Choose what Buy everything buys…" (Settings → 🛒 Shop, and "🛒 Choose items…" on the Shop tab): a menu with every item of every shop, in stock or not. Each item has a switch: 🛒 bought or ⏸ switched off. It shows pictures, rarity in the game's colours, what's in stock now and the price.
  - The menu has search, a filter (all / bought / switched off / never bought / in stock now), "all" buttons per shop (they apply to the items matching the search) and "Switch all back on".
  - Buildings, one-time items and Magic Dust items are listed with the reason and can't be switched on (XP and Hunger potions follow "Also buy XP and Hunger potions").
  - The choices are the same as clicking items in the Buy window and apply to Buy everything on the PC and from the 📱 phone page.

## 0.18.0
- 📱 Phone remote, security:
  - The PC only acts on four commands: Buy (the same as pressing Buy everything on the PC), Reconnect (only while the game on the PC is disconnected), Stop (repeating alerts) and a status refresh. None of them takes any input. Anything else is ignored, and nothing a phone sends reaches the game. The phone only gets whether the game is connected, what's to buy (names, amounts, pictures), the time to the next restock and the results of its own commands.
  - Messages are encrypted and signed (AES-GCM) with keys made from the pairing code. The topic on the relay servers is a hash of the code. Anyone listening on the public brokers sees neither the code nor what's in the messages, and can't send commands the PC accepts. A command only runs once (sending the same message again does nothing, including after the page reloads) and only if it is at most 5 minutes old. The phone page says so if the phone's clock is too far off.
  - The ntfy app's "Buy on PC" / "Stop" buttons carry a command encrypted the same way. It runs once and expires after 30 minutes. The ntfy topics are also made from the code: subscribe again in the app to the topic shown under Settings → 📱 Phone remote (the old "<code>-a" topic is no longer used).
  - Not compatible with the earlier phone page: update the mod on the PC and remote.html together. Pairing codes and saved phone links stay the same.
- 📱 Buy-only links (off by default): "Let people with my Buy-only link press Buy on this PC" and "Copy Buy-only link". The link holds a share code made from the pairing code by a one-way hash, so the pairing code can't be worked out from it. With it, a phone can only press Buy and see what's to buy, and only while sharing is on. It can't use Reconnect or Stop, and it doesn't see the last buy's result (only the results of its own presses). While sharing is off, it can't read anything. "New code" makes the link stop working. Buy from a shared link at most once every 10 s.
- 📱 Optional name for the PC shown on phones (Settings → 📱 Phone remote).
- Phone page: several PCs at once, one card each (name, yours / Buy-only, status, Buy, Reconnect for your own, ✕ to remove), and "Buy on all" when there are two or more. "Add or share codes" takes any text with one or more codes or links. "Share Buy-only link" makes one link with the share codes of all PCs on the page (your own pairing codes are never in it). "Copy full link" makes one with the full codes, for your own other devices. A link with several codes adds them all. A code saved by an earlier version is kept.

## 0.17.3
- 📱 Phone remote: with nothing to buy, the PC doesn't refresh its status every minute; nothing changes until the next restock (the seed shop restocks every 5 minutes), so it sends the next status then (at most 6 minutes later). With something to buy it still refreshes every 60 s. The phone page waits accordingly before saying "No word from your PC"; a closed game tab is still shown as offline straight away.

## 0.17.2
- The game's page store (used for your player id, the world map and your position, e.g. for the riding hint) is read through window.__jotaiStore, which the game provides from release 1604 (developers' note). Nothing in the game is patched then; any temporary patch from before the store appeared is undone. On older releases the earlier method (a short-lived patch of atom writes, never of reads) is kept as a fallback.

## 0.17.1
- Phone page: the item pictures no longer flicker (the list is only redrawn when it changes, not every second). When there's something to buy, the Buy button turns red and pulses like the 🛒 button in the game, and the tab title shows the count ("🛒 12 to buy"). No pulsing when the phone asks for reduced motion.

## 0.17.0
- 📱 Phone remote: the phone page and the PC now talk through public MQTT message brokers (HiveMQ and EMQX, both at once, so either can be down) over secure websockets, instead of ntfy.sh. No account and no daily message limit (ntfy.sh's free tier allows 250 messages a day per internet address, which ran out). A browser can't accept connections, so the two still need a server in between; nothing else is sent through it.
- The PC's status is kept on the brokers: the phone page shows it the moment it opens, with no request needed. The PC refreshes it every 60 s, on each restock or change in what's to buy, and after each command. If the PC's game tab closes or loses its internet, the brokers mark it offline by themselves ("PC offline").
- Buy progress to the phone is back to about once a second. The phone page shows "Can't reach the relay servers" when neither broker answers, and reconnects right away after the phone sleeps.
- The ntfy app stays optional, only for notifications: repeating alerts and their "Buy on PC" / "Stop" buttons (and a "Bought on PC" note after a buy from those buttons). The relay-messages-left count is gone from Settings.

## 0.16.5
- 📱 Phone remote now stays within the free relay's limit: ntfy.sh allows 250 messages a day per internet address (a phone and PC on the same Wi-Fi share it), and the PC's status every minute used that up within hours, after which the phone page only showed "Waiting for your PC". Now the PC sends nothing until a phone asks; while the phone page is open (2.5 minutes after its last message) it sends its status when asked, on each restock or change in what's to buy (at most every 10 s), and after commands. The page asks when opened and every 2 minutes while on screen, and after a restock only if nothing came within 20 s.
- Buy progress to the phone: every 2 s, at most 10 updates per buy.
- When the relay refuses because the daily limit is used up, the phone page and Settings → 📱 Phone remote say so. Settings shows how many relay messages are left today (checked every 10 minutes; checking costs nothing).

## 0.16.4
- Phone page: item pictures next to each item to buy ("Show item pictures", on by default, remembered on the phone). The PC sends each item's picture path with its status; if a status would be too big for the relay (4 KB), the last result's text is shortened first, then pictures are left out, then the list is cut.
- Phone page: reconnects by itself when it comes back on screen, comes back online, or hears nothing from the PC for 70 s, keeping the last status shown meanwhile. The relay connection (phone and PC) is reopened when it goes quiet for 75 s (ntfy's keepalive comes every ~45 s), so a connection that died silently no longer needs a page refresh.

## 0.16.3
- 🔔 Alerts reworked: each item has its own setting, 🔕 off, 🔔 once per restock, or 🔁 again until bought. "🔔 Choose alerts for each item…" (Settings → 🛒 Shop) opens a menu with every item of every shop (picture, rarity in the game's colours, in stock now; rarest first), a three-way switch per item, search, a filter (all / alerting / repeating / set by you), "all" buttons per shop and "Reset all". On the 🛒 Shop tab, each item's switch cycles 🔕 → 🔔 → 🔁. Items you haven't set follow the rarity default ("alert once if at least Mythic / Divine / Celestial", or never). The single once/repeat choice is gone; earlier picks carried over.
- Only 🔁 repeating alerts go to the phone (ntfy app), once per item and restock, with "Buy on PC" and "Stop" buttons; Stop silences the PC's repeats until the next restock.
- Repeating alerts stop by themselves once their items are bought (the chime and the message), and don't ring while Buy everything is running.
- Phone page: when the restock countdown reaches 0 it asks the PC for the new stock (again every 10 s until it arrives) and shows "restocking…". While buying, progress ("Buying… 40 of 123 done") updates about once a second. After a buy, Buy stays greyed until a status sent after the purchases arrives (the PC sends one right away and another 2.5 s later), so it no longer looks buyable until pressed again. The PC also sends its status within 5 s whenever the number of items to buy changes. Ages and the countdown use the relay's clock.

## 0.16.2
- 🛒 Shop tab: a shop with no stock and no restock timer shows "closed" instead of "0 to buy" / "Empty"; the Spooky shop, which is only open at night, says so ("Closed: the Spooky shop is only open at night (30 minutes every 10 hours)").

## 0.16.1
- The phone side of 📱 Phone remote is now a web page instead of a phone userscript: remote.html in the mod's GitHub repository (GitHub Pages). "Copy phone link" copies https://godgamerover9k.github.io/MG-late-game-helper/remote.html#<code>; opening it saves the code on the phone. The page shows the PC's connection, items to buy and next restock, with "Buy on PC" and "Reconnect PC" (asks first). It never connects to the game, so nothing on the phone takes the session over.
- MG Lategame Helper Lite (phone) from 0.16.0 is withdrawn.

## 0.16.0
- 📱 Phone remote (Settings → 📱 Phone remote, off by default): the phone can press Buy everything on this PC, and Reconnect when the PC's game is disconnected. Messages go through ntfy.sh (a free public relay) on a secret pairing code ("Copy phone link", "New code"). The PC sends its status (connected, items to buy, next restock, last result) every 60 s and on each restock. A phone Buy runs the same list and checks as pressing Buy on the PC; commands older than 90 s are ignored and each runs once. Reconnect only runs when pressed on the phone and only while the PC is disconnected (it reloads the page).
- Optional: rare alerts and Buy results also go to the ntfy phone app (topic "<code>-a"); rare alerts there have a "Buy on PC" button.
- New companion userscript **MG Lategame Helper Lite (phone)** (MG-Lategame-Helper-Lite.user.js), active only on phones/tablets. magicgarden.gg opens a small page instead of the game (the game isn't loaded): the PC's status and items, "Buy on PC", "Reconnect PC", and "Connect here & open Buy". The last loads the game on the phone with drawing slowed to 2 frames a second, sounds blocked and optionally pictures blocked, opens the Buy window, and offers "Disconnect" / "Disconnect & reconnect PC". If the game hasn't connected after 45 s, "Try again without blocking". Connecting on the phone takes the session over from the PC (the game allows one per account).

## 0.15.53
- 🔔 Rare item alert: "Alert once per restock" or "again until bought". Repeating alerts ring (message, chime, system notification) every 10 s / 15 s / 30 s / 1 min while any alerted item is still in stock, and stop when it's bought or sold out, when the shop restocks, or on "🔕 Stop" (or closing the message) until that item's next restock.
- Chime volume slider (0 = silent) with a "▶ Test" button.

## 0.15.52
- 🔔 Rare item alert: pick items yourself. Every item on the 🛒 Shop tab has a 🔔 / 🔕 switch (alerts when in stock / no alert). Items you haven't picked follow the rarity setting, which now also has "none (only picked items)". Settings → 🛒 Shop shows how many items are picked, with "Clear picks". The "Also alert for" list from 0.15.51 became picks.

## 0.15.51
- 🔔 Rare item alert: when a shop has a rare item in stock, a message lists it (picture, amount, rarity) with an "🛒 Open Buy" button, with a chime. Once per item per restock. Rarity comes from the live game data (seeds, eggs, tools, decor); alerts from Divine up by default (Mythic / Divine / Celestial in Settings → 🛒 Shop). "Also alert for" lists items that always alert. Optional system notification (asks the browser for permission), for when the tab is in the background. Items the mod never buys (no local stock, Magic Dust items, buildings) don't alert unless listed.

## 0.15.50
- Hovering an ability shows what it does (the game's own description; a short built-in line where the game has none), and whether it's ignored in your settings.
- Species with spaces in their name (Red Fox, …) show their picture and their spaced name: the picture is looked up by the game's name when the id doesn't match, then the plain picture, then the initials.

## 0.15.49
- The other weather-only copies of regular abilities joined the default Ignored abilities list, added once to a saved list the same way: Snowy, Thunder and Amber Egg Growth Boost; Snowy Crop Size Boost; Snowy Crop Mutation Boost and Thunder Boost; Snowy Hunger Boost and Snowy Hunger Restore. Dawn Boost and Amber Moon Boost still count; granters (Thunderstruck, Dawnlit, Amberlit) and capture abilities aren't copies and still count.

## 0.15.48
- Weather XP boosters (Snowy, Dawn, Thunder and Amber XP Boost) and weather Plant Growth boosters (Snowy, Dawn, Amber and Thunder Plant Growth Boost) are on the default Ignored abilities list: they no longer keep a pet. Added once to an Ignored list saved by an earlier version; remove them from Settings → Ignored abilities to count them again. (The Level up team already used only the regular XP Boost.)

## 0.15.47
- Settings → When is a pet useless?: "Compare each ability on its own" (off by default). A pet is flagged when, for each of its abilities, enough pets are better at that ability alone (the usual 2 for long-term / 3 for one-time abilities, plus the hunger/Rainbow extra copy); the better pets needn't share its other abilities and can be different for each ability. Ties: bigger, then older.
- With it on, a pet with two or more useful abilities that no other pet beats at all of them together is kept as the best of its ability mix (Kept anyway: "best pet with this ability mix"); weaker copies of that mix are flagged. 🤔 Maybe sell lists those best-of-mix pets.
- A pet's details show, per ability, how many pets are better at it alone.

## 0.15.46
- Settings → 🛒 Shop: "Put purchases away only if that item is already in its storage". When on, a bought item goes into the Seed Silo / Tool Shack / Decor Shed only if that storage already holds that item; anything new stays in the inventory (e.g. Planter Pots you use straight away). Off by default. Free-slot checks before buying account for it.

## 0.15.45
- Buy everything: when a storage turns an item down (e.g. the Tool Shack's Watering Can stack is at its limit), that item isn't offered to it again until that storage's contents change. The result shows a short note ("Tool Shack is full for it; it stays in your inventory") instead of an error. The "📦 Put away" button leaves those stacks out.
- An item is no longer bought once both its storage is full for it and the inventory's stack of it is at its carry limit.

## 0.15.44
- Buy everything runs one buyer per free inventory slot (at most 16), counted when Buy is pressed. Each buyer buys one item, puts its stack away, then takes the next item, so a nearly full inventory no longer overflows mid-run. Units of the same item are still bought together.
- A buyer whose stack can't be put away (eggs, or no storage for it) stops, since its slot is now taken. Items left when no buyers remain are listed as "no free inventory slot (left for the next press)".
- An item refused because the inventory was full is no longer skipped for the rest of the restock.

## 0.15.43
- Storage moves use the game's new MoveItem command (itemId, from, to; "inventory" on one side), which replaced PutItemInStorage / RetrieveItemFromStorage in a game update (the old ones are now answered "invalid_message"). Covers putting purchases away, the "📦 Put away" button, taking seeds out of the Seed Silo, and moving pets in and out of the Pet Hutch. If MoveItem itself is refused as invalid, the old commands are tried.

## 0.15.42
- Buy everything: the result lists each stack that wasn't put away and why (the game's answer, or which storage wasn't found). The "📦 Put away" button shows the game's answer too.
- The connection trace (copy(__mglhNet()) in the F12 console) includes the full storage commands sent, including the game's own when you put something away by hand.

## 0.15.41
- Buy everything: putting a purchase away waits (up to 1.5 s) for its stack to show up in the inventory. The purchase's answer could arrive before the game's state showed the stack, and the stack was then left in the inventory; over several restocks these filled it up.
- After each run, a second pass puts away anything bought that run that is still in the inventory.
- Buy window: when items are left out for lack of inventory slots, it shows the slots in use and a "📦 Put away N stacks" button for seeds / tools / decor whose kind is already in your Seed Silo / Tool Shack / Decor Shed (adds to those stacks; the Strength Crystal and other unique tools are never moved).

## 0.15.40
- Update links in the script header (GitHub: godgamerover9k/MG-late-game-helper): Tampermonkey updates the mod from there.

## 0.15.39
- The plant card's "Not logged" row moves up past what the game draws above the card (the crop's coin value, a mutation's name when its icon is hovered) instead of covering it. Plants and pets in the garden don't move it.

## 0.15.38
- The panel can't be dragged past any edge of the window, minimized or not; it is also pulled back in after minimizing, restoring or resizing the window.
- Minimized, the title bar stays on one line (title and buttons no longer wrap near the screen edge).

## 0.15.37
- Double Hatch: the extra pet doesn't double-hatch again, so a team gives at most one extra pet per egg (chance that at least one Double Hatch pet procs). Rare pet and Gold / Rainbow hatching scores use this instead of the repeating chain.

## 0.15.36
- Level up: a hungry pet gains no XP of its own but still receives XP Boost XP (confirmed in game). Growing pets' XP = base XP × share of time fed + the booster's XP (the booster's own fed share still applies, as it only procs while fed). Team choice and max-level times use this.

## 0.15.35
- Crop Refund is valued as: each crop sold has the refund chance of not being removed (you're paid and keep it), so a crop is sold 1 / (1 − chance) times on average, each time with the Sell Boost. Crop selling score = (1 + Sell Boost) / (1 − chance that at least one refund pet procs) − 1, shown as "% coins per crop". Crop Refund pets are compared with Sell Boost pets on that same scale again.
- The crop-sale pop-up's team check counts Crop Refund pets as selling pets too.

## 0.15.34
- Harvest / sell / hatch pop-ups no longer close by themselves when the action was started by holding Space (the game's hold-to-confirm): no button in them gets keyboard focus, and only mouse clicks press their buttons.

## 0.15.33
- Harvesting a Gold or Rainbow celestial crop while no Double Harvest pet is out (and you have pets for a Harvesting team) holds the harvest and asks first: "🧺 Swap in the Harvesting team" (swaps it in; harvest again yourself), "Don't harvest yet", or "Harvest anyway".
- Selling crops worth at least the set amount while no Sell Boost pet is out (and you have a Crop selling team) holds the sale and asks the same way, with "💰 Swap in the Crop selling team". This shares one pop-up with the room-not-full warning.
- Settings → Features: switches for both ("…also when no Sell Boost pet is out", "Ask before harvesting a Gold/Rainbow celestial crop…").

## 0.15.32
- 🧪 button: clicking the "💰 N" part opens the Useless tab; with only pets to sell (no eggs ready), the whole button opens Useless. Otherwise it opens Teams as before.
- Code clean-up for Tampermonkey's ESLint warnings (curly braces on nested loops, no functions created inside loops, unused variables, an unneeded escape). No change in behaviour.

## 0.15.31
- Hatch pop-up: the team the egg planner picks for the egg you pressed Hatch on is marked ★ and highlighted, with the reason underneath (e.g. "Amber Egg: for Phoenix Max Weight"). When that egg's journal is complete, Gold / Rainbow is marked (more dust).
- Gold / Rainbow team description says ~70% (the corrected pity factor).

## 0.15.30
- Finding your garden: your player id is now also read from the game's own playerIdAtom / playerAtom, from the game connection the mod watches, and from the id remembered last time (if that player is in the room), before asking.
- A garden picked by hand earlier is only used while that player is in the room; otherwise your own garden is found automatically.
- In a room where you have no garden (e.g. it was full and you're watching), the panel says so instead of asking you to pick a garden; while the room is still loading it says "Waiting for the room to load…".

## 0.15.29
Calculation fixes (checked against the game data API and the formulas Arie's Mod and QPM copy from the game):
- Hunger Restore: each refill is a random amount between 1 and its cap (averages half the cap), and its per-minute chance is checked every second. The level-up "fed" share and max-level times were too optimistic before.
- Weather-only hunger abilities (Snowy Hunger Restore / Boost) are no longer counted for keeping a level-up team fed (they were counted at 30% of the time; Snow is up far less, and not predictably).
- XP Boost in the level-up team and its max-level times uses the booster's current STR and how often it's fed, not its full-grown STR.
- Pet Refund gives an egg back, not the pet: the Pet refund team now says "chance of an egg back", and the Pet dust team is scored on Dust Boost alone (Pet Refund only fills free slots) instead of assuming a refunded pet is sold again.
- Crop Refund ("chance to get crops back when selling") is no longer turned into extra coins, since how many crops come back isn't known: the Crop selling team is scored on Sell Boost (Crop Refund fills free slots), and Crop Refund pets are compared only with other Crop Refund pets.
- Crop Size Boost adds its Size points flat; STR only changes how often it procs (it was scaled twice by STR).
- Gold / Rainbow hatching: the share of Pet Mutation Boost left by the pity system is 0.70 (was 0.77; worked out from the pity thresholds). Saved settings still on 0.77 are updated.
- Buy everything: a full Seed Silo / Tool Shack / Decor Shed is taken into account, so the purchase count no longer assumes a new stack can always be put away.
- Shop restock countdown: reads deadlineMs (newer game builds no longer send secondsUntilRestock).

## 0.15.28
- Plant card hint: works when more than one card is up (e.g. a pet standing on the tile with its VIEW button) and on plants with several crops (‹ › arrows): the card used is the visible one whose texts name a plant, checking every text on it rather than only the first.

## 0.15.27
- Riding a pet with Thundercharger, Dawn Capture or Amber Capture: a bar at the top of the screen shows what pressing the ability would do where you stand (the 3×3 around you): Thundercharger the number of Thunderstruck crops it would charge, Dawn / Amber Capture the number of capsules (lit = 1, charged/bound = 2). Your tiles come from the game's world map and your grid position (read from the game's page store, as Arie's Mod and QPM do). Switch in Settings → Features.
- Plant card hint: right-clicking the card no longer shows a "Not logged: shown / hidden" message.

## 0.15.26
- Selling crops: pressing Sell All Crops while the room has empty spots and the crops (favourites not counted) are worth at least 1,000,000,000 coins holds the sale and asks first. The pop-up shows the coins now, the coins with a full room (+10% friend bonus per other player, +50% with 6), and the difference. "Don't sell yet" keeps the crops; "Sell anyway" sends the sale.
- Crop value: base price × size × mutation multiplier (Gold ×25, Rainbow ×50, times 1 + the sum of the weather/time multipliers − their count).
- Settings → Features: switch and the minimum value ("worth at least").
- 👥 "5-player room" button in the panel header: gets the public room list from Arie's Mod's API (ariesmod-api.ariedam.fr/rooms) and joins the most recently active public room with exactly 5 players (the page reloads into it), so the room is full with you in it. Says so when none is available. Switch in Settings → Features.
- Level up team: shorter pet lines ("⚡ +108 XP/min to all", "🍖 feeds the team", "📈 growing · max in 2.1 h (~9:40 PM)"); the fed share is only shown when below 100%.

## 0.15.25
- Plant card hint toggle: the confirmation is a short "🌱 Not logged: shown / hidden" that disappears after 1.5 s, and a new one replaces the previous one instead of piling up.
- Messages in the corner are stacked in one column instead of drawn on top of each other. The "crystal is out" / "hatching team is out" messages disappear after 4 s; reminders still last 30 s.

## 0.15.24
- Plant card hint: the "Not logged" row is placed from the card's fixed hit area (or its title row) instead of its drawn size, so it no longer moves up and down when hovering makes the card picture grow.

## 0.15.23
- Plant card hint: right-clicking the plant picture on the game's plant card turns the "Not logged" row on or off for all plants (same setting as Settings → Features), with a short message saying which.

## 0.15.22
- Plant card hint: when standing on a plant, a row above the game's plant card shows the journal variants that species still lacks, using the game's mutation icons (Normal and Max Weight use 🌱 / ⚖️). Shows "Every variant logged" when complete. Read-only; finds the card the way Arie's Mod does (Pixi labels GardenInfoCardSystem / GardenInfoObjectCard). Switch: Settings → Features.
- Level up: each growing pet on the team shows its time to max level and the expected time, counting base XP, the team's XP booster (XP Boost) and the share of time it stays fed.

## 0.15.21
- Settings → Buttons and display: "Drag 🐾 to move the 🐾 / 🛒 / 🧪 buttons" switch (on by default). When off, the buttons can't be dragged and stay where they are.

## 0.15.20
- Three-ability pets not kept for another reason are flagged when 1 better pet with all of their abilities exists (instead of the usual 2 or 3). The best copy of each mix is still kept.
- 🤔 Maybe sell applies the same three-ability comparison, so three-ability pets no longer appear there from comparisons with one- or two-ability pets.

## 0.15.19
- Three-ability pets (not counting Gold/Rainbow Granter) are only compared with other three-ability pets that have each of their abilities at the same or a higher tier. Pets with one or two of those abilities no longer count toward flagging them. The usual thresholds apply (e.g. 2 such pets for a left-out pet, 3 for specific use).
- The best copy of each three-ability mix is still always kept.
- The comparison table notes "three abilities: only pets with all three count". The setting is "Three-ability pets" under Always keep.

## 0.15.18
- The 🐾 / 🛒 / 🧪 buttons can be moved together by dragging 🐾; the spot is remembered. A drag doesn't open or close the panel.
- Until they've been moved by hand, the buttons step to the right, past other mods' buttons in the bottom-left corner (e.g. Garden Companion, Vaxen's Fav Rooms). Checked a few times in the first 20 s after loading, since other mods add their buttons later.
- Settings → Buttons and display: "Default spot" button (shown after the buttons have been moved).

## 0.15.17
- Hatch pop-up: when pets out don't help hatching, it shows one button per hatching team you have pets for (💪 Max STR, 🌈 Gold / Rainbow, 🥚 Rare pet). Pressing one swaps that team into your active slots; the egg is not hatched. When nothing is left to fix, the pop-up closes and Hatch has to be pressed again.
- Settings → Features: "Hatch pop-up: swap in a hatching team" switch.

## 0.15.16
- Settings: every group (When is a pet useless?, Always keep, Features, Hatching and selling, Shop, Buttons and display, Game data, Advanced, Abilities that never protect a pet) folds open and closed like Advanced. Only Features starts open; which groups are open is remembered, including after a setting changes.

## 0.15.15
- 🐾 button and Alt+P: on a minimized panel they expand it instead of closing it; on a closed panel they open it expanded. An open, expanded panel is closed as before.
- Keep awake does not run while another mod (Arie's Mod, QPM's Anti-AFK) is already keeping the game awake. It checks every 3 s (mods load in any order), steps aside without undoing the other mod's patch, and Settings shows "another mod is already doing this".

## 0.15.14
- Keep awake matches Arie's Mod's anti-AFK: the same events are stopped (visibilitychange, blur, focus, focusout, pagehide, freeze, resume) and the position is also sent once when it starts. The silent audio additionally starts on the first click or key press, since browsers block audio before that.

## 0.15.13
- Keep awake: the game keeps running while its tab is unfocused, in the background or minimized. Same approach as Arie's Mod's anti-AFK: the page always reports itself visible and focused (visibility/blur events are stopped before the game sees them), a silent audio tone stops the browser from throttling the tab (it starts after the first click or key press), a mouse-move heartbeat every 25 s, and the player's current position is resent every 60 s.
- On by default; Settings → Features: "Keep the game running in the background". Turning it off restores the page's normal behaviour immediately.

## 0.15.12
- The Thundercharged crops team is now "🌩️ Charge & capture": one of each pressable ability, Thundercharger, Dawn Capture and Amber Capture, the strongest copy of each. A slot left free (an ability nobody has) gets a second copy. Thunderstruck Granters are no longer added.
- Settings → Features switch renamed to "Charge & capture team".

## 0.15.11
- Teams tab: new 🌩️ Thundercharged crops team. Picks Thundercharger pets first (each charges the Thunderstruck crops around it once every 5 min, so the count matters; ties go to the stronger pet), and fills free slots with Thunderstruck Granters.
- Pets on this team count as used in a best team (kept), like the other teams, and it is included in Level up goals.
- Settings → Features: "Thundercharged crops team" switch.
- Dawncharged and Ambercharged are not covered: no pet ability makes them (Dawn and Amber Capture remove those mutations).

## 0.15.10
- Buy everything: an item that gets no answer no longer stops the run. It is skipped (until its shop restocks, reported as "may or may not have been bought") and the remaining items are bought.
- A command with no answer whose number the server has since passed is known not to have happened, and is sent again once.
- After the counter is corrected for one command, the other commands that were in flight are resent with the corrected number instead of failing.
- Diagnostics: running copy(__mglhNet()) in the F12 console copies the recent command numbers, answers and timeouts.

## 0.15.9
- Commands are never numbered at or below the server's executed count. A command the server ignored for an old number (no answer) is sent once more with a current number.
- A command with no answer no longer blocks buying, team swaps or logging: the next press goes out and confirms the numbering (an invalid_sequence answer steps it down as before). Selling still waits until a later command is answered.
- A late answer to the unanswered command, or the server's executed count passing it, clears the wait.
- Buy everything: an item that gets no answer is skipped until its shop restocks; pressing Buy again continues with the rest.

## 0.15.8
- Garden crop logging: the photo target uses the grow slot's slotId as slotsIndex (as in the game's own code), not its position in the slots list; the wrong slot was being targeted and the game refused it.
- Growing crops: Max Weight is read from the slot's size (100 = max weight).
- Buy window: when there is stock but the mod can't send commands (e.g. another script replaced the game connection's send), the status shows "not connected" and the reason is shown above the list, instead of only "waiting".

## 0.15.7
- Shop tab: every item a shop can sell is listed even while the shop is empty (e.g. weather shops between weathers), marked "not in stock now", and can be switched off or on. The list comes from items seen in that shop before and the game data's eligibleShops.
- An item switched off while out of stock stays off when it comes into stock.

## 0.15.6
- Crop logging includes ripe crops still growing in the garden (dirt tiles), photographed where they grow (LogItem target { kind: "growSlot", slot, slotsIndex }, the format used by Arie's MG-Websocket-Helper). Unripe crops are skipped.
- Garden crops count toward "Log N crops", and the "Would add" line marks them "in the garden". Max Weight for a growing crop is its targetScale reaching the species' maxSizeMultiplier.

## 0.15.5
- Buy everything: clicking an item in the Buy window switches it off (greyed out, ⏸, not bought) or back on. Switched-off items stay off across restocks until switched back on.
- Shop tab: clicking an item there does the same; switched-off items show "⏸ switched off" and are not counted in "to buy".
- The 🛒 button count leaves switched-off items out.
- Settings → Features: "Switch all N switched-off Buy items back on" button (shown when any are off).

## 0.15.4
- Panel tabs can be dragged to reorder them; the order is saved with the settings (and included in Copy settings).
- Settings → Features: "Drag tabs to reorder them" switch, and a "Default tab order" button once the order has been changed.

## 0.15.3
- Crop journal: "Get N" on a rare variant (Four-Leaf Clover, Purple Daisy, Double Snowdrop, Variegated Cattail, Embercrown, Stormcap, …) takes out the base plant's seeds it grows from (e.g. Cattail Seed for Variegated Cattail, Thunderspire Pod for Stormcap). The base seed is found from the shared seed picture in the game data.
- Crop journal pictures use the crop sprite from the game data, falling back to the plant and seed sprites, so crops whose picture file has a different name (Habanero, Marigold, Stormcap, Thunderpeel, …) show a picture.

## 0.15.2
- Hatch pop-up: the button is now "💎 Put the crystal out". It only places the Strength Crystal; the egg is not hatched. The pop-up closes and Hatch has to be pressed again.
- The button is also shown when pets out don't help hatching; the pop-up then stays open until the pets are fixed.
- Journal tab: the Crop journal card has the same side margins as the Teams cards instead of touching the panel edges.

## 0.15.1
- Strength Crystal detection matches the game's item format: a picked-up crystal is a Tool item with toolId "StrengthShard", its own id and remainingActiveSeconds. "Put the crystal out" buttons now appear when it is in the inventory or the Tool Shack.
- Shard stacks (same toolId, no id, no remainingActiveSeconds) and any stack of more than one are never placed or taken out.
- With no picked-up crystal found, the hatch pop-up says so instead of asking to place it by hand first.
- Crop journal: Max Weight is detected from the crop's size (100 = max weight).

## 0.15.0
- Crop journal section in the Journal tab: one filter per variant (Normal, Max Weight, Gold, Rainbow, Wet, Chilled, Frozen, Thunderstruck, Thundercharged, Dawnlit, Amberlit, Dawnbound, Amberbound), each showing how many crops still lack it; selecting one lists those crops.
- Crop logging: "Log crops" logs inventory crops that add a new journal entry (one LogItem per crop).
- "Get N" button next to a listed crop takes all of that crop's seeds out of the Seed Silo into the inventory.
- Logging requires a Camera in the inventory or a storage; without one the Log buttons are disabled.
- Settings → Features: on/off switches for Buy everything, Level up, the egg planner, Teams ordering, the sell-dialog team swap, placing the Strength Crystal, logging, the crop journal and the Seed Silo button.

## 0.14.16
- **Level up first when nothing else is due:** if no eggs are ready to hatch and there are no pets to sell, but some pets still need growing, the Teams tab puts Level up at the top (with a note saying so).

## 0.14.15
- **Crystal spot hardcoded to your bottom-right boardwalk tile** (Boardwalk tile 75, captured from the game), so putting the crystal out works without placing it by hand first. If you put it somewhere else yourself, that spot is used from then on.
- **Finds the crystal in the Tool Shack too:** if your Strength Crystal is in the Tool Shack (or another storage), the mod takes it out first and then puts it out. It also recognises your Strength Crystal even if it never saw you pick it up. Shards are still never used.

## 0.14.14
- **Space no longer re-presses panel buttons.** After you click Minimize (or any button in the panel, or the 🐾 / 🛒 / 🧪 buttons), it no longer keeps keyboard focus, so pressing Space in the game doesn't trigger it again.

## 0.14.13
- **Put the crystal out from the hatch pop-up:** when a hatch is stopped only because the Strength Crystal isn't out, the pop-up now offers **💎 Put the crystal out and hatch**. One press puts your crystal back on its tile and then sends the hatch you pressed. (If pets out don't help hatching either, it offers **Put the crystal out for me** and you fix the pets yourself.) As before, only your Strength Crystal is placed, never a shard, and the mod needs to have seen you put it out by hand once to know the spot.

## 0.14.12
- **Buy button always on screen:** on a short window the Buy window used to run off the bottom, hiding Buy. Now only the item list scrolls, and the explanation is folded into "What gets bought (and what never is)" (click to open), so the header, the potions toggle and the Close/Buy buttons always fit.

## 0.14.11
- **No more "timeout" when another mod swallows a purchase.** If a command never reaches the connection (QPM's Locker does this for purchases when your inventory is nearly full), the mod now says so after 1.5 s ("another mod stopped it before it was sent…") instead of waiting 6 s, giving up, and refusing everything until a reload.
- **Safer command numbering:** the counter is no longer pulled down on a guess (a number that's too low is silently ignored by the server, which is what caused the timeout). Every answered command now confirms its number; if a number is too high, the same command is retried one number lower at a time. And if a command ever does go unanswered, sending resumes on its own as soon as any later command is answered, instead of needing a reload.

## 0.14.10
- **Buy works the moment the window opens.** Before, the Buy button stayed greyed out until the first one-second tick (when the countdown appeared), even though the window already said READY; pressing it early did nothing.
- **Only a Strength Crystal is ever put out, never a shard.** The mod places your Strength Crystal (the item with its own lifespan) on the tile it last sat on, so put it where you want it (e.g. bottom right) by hand once and it'll use that spot from then on.

## 0.14.9
- **Choose the team in the sell dialog:** a "Team" pick in the red box lets you swap in **✨ Pet dust (refund + dust boost)** or **♻️ Pet refund only**. The buttons ("Put out the crystal + swap in the team", "Just the team") use whichever you pick, and it's remembered.

## 0.14.8
- **Seed Finder I counts again on Gold and Rainbow pets.** It's still ignored on plain pets, but a Gold/Rainbow Seed Finder I pet keeps it, so (for example) your Gold Worm 96 with Gold Granter + Seed Finder I is kept again.
- **Put the Strength Crystal out from the sell dialog:** when the crystal isn't out, the red box now offers **Put out the crystal + swap in the pet dust team** (or just one of them). The mod remembers which crystal you picked up and the tile it was on, and puts that same crystal back there; it never uses up a new shard. The first time, put it out by hand: once the mod has seen you pick it up, it can do it for you.

## 0.14.7
- **Seed Finder I no longer protects a pet** (it only finds Common/Uncommon seeds, which the shop sells). It's now on the ignored list by default; if you'd customised that list, it's added once (untick it in Settings to undo). Gold/Rainbow Seed Finder pets are still kept by the collection rules, and Seed Finder II–IV still count.
- **New 🧺 Harvesting team:** the best Double Harvest pets to have out when you harvest (each pet rolls on its own, so their chances add up). It's also a Level up goal, so Double Harvest pets that still need growing show up in the queue.

## 0.14.6
- **Command numbering heals itself:** the mod now reads the server's own count of executed commands. If one of its commands is refused only for its number (invalid_sequence), it waits for everything in flight to come back, continues from the server's count and retries once. No more "A command number was rejected. Reload the page", and another mod's refused command no longer blocks this one.
- **Much clearer sell warning:** when your pets out don't help selling (or the crystal isn't out), the sell dialog shows a bold red box listing each problem and a **Swap in the pet dust team** button. One press swaps the team in; the box turns green once all is well.

## 0.14.5
- **Pet selling teams first when you have pets to sell:** if your Useless list isn't empty, the Pet refund and Pet dust teams move to the top of the Teams tab (after the hatching teams when eggs are ready too). The note at the top says why.

## 0.14.4
- **"+3 more" is now a button** under the Level up queue: "Show 3 more pets that need growing" lists the rest (and "Show fewer" hides them again). You can drag and pin those too.

## 0.14.3
- **Drag to reorder the Level up queue:** each row in "Next to grow" has a ⠿ handle. Drag a pet up or down; where you drop it sticks (the rows above it get pinned in that order, so they grow first). The 📌 buttons still work as before.
- **Crop selling team now uses your Crop Refund pets.** Crop Refund only has a chance (no size), so it was scored as zero and never picked; the team was built from Sell Boost pets instead. With your three Capybaras the crop selling team is now about +72% per sale instead of +16%, and Sell Boost pets are no longer grown for it in Level up. Team cards show each Capybara's refund chance.

## 0.14.2
- **Fixed "Stopped: invalid_sequence" after the hatch check.** When the hatch check held a hatch back, the game had already given it a command number, so the next command left a gap in the numbering. The server then refused the following commands (Log, Buy, Apply) until you reloaded. The mod now always sends commands numbered one after another, so a held-back hatch leaves no gap.

## 0.14.1
- **Level up: "no feeder" option.** Teams → Level up → Team: "no feeder (I feed them)". For when you're playing and feeding pets yourself: no slot goes to a hunger pet, so all three slots grow (or an XP booster plus two growing). The default stays "with a hunger pet".
- **Hatching first when eggs are ready:** if any egg is ready to hatch, the Teams tab shows the hatching teams (Max STR, Gold/Rainbow, Rare) and the egg planner first, with a note saying how many eggs are ready.
- **Buildings and one-time items are never bought**, whatever the settings (those two options are gone).
- **Clearer Magic Dust option:** one checkbox, "Also buy XP and Hunger potions (paid with Magic Dust)". No other dust item is ever bought.
- **Potions toggle in the Buy window too:** tick or untick it right there and the list updates straight away (same setting as in Settings).
- **Settings streamlined:** regrouped into "When is a pet useless?", "Always keep", "Hatching and selling", "🛒 Shop", "Buttons and display" and "Game data", with shorter labels. The rarely-changed numbers are under a collapsed "Advanced" section, and the ignored-abilities list is collapsed too.
- **One Gold/Rainbow collection switch** replaces the two overlapping ones (best of each species + best of each ability mix).

## 0.14.0
- **Every three-ability pet is kept** unless another three-ability pet of the same species is better: it has each of its abilities (same or higher tier), at least its mutations, and is at least as strong. Only that weaker copy can be sold. (Replaces the old "two per species, only where rare" rule.)

## 0.13.9
- **Three-ability pets kept more reliably:** for species where you own fewer than 6 pets, whether 3 abilities is rare is judged across all your pets (about 1 in 20 have 3) instead of that tiny sample. Before, owning 2 SnowFoxes with one having 3 abilities counted as "half have 3", so it wasn't kept.

## 0.13.8
- **🧪 Teams button shows up sooner:** it checks every 3 s (was 5 s), re-runs the sell rules every 10 s (was 30 s), and uses the panel's latest count straight away.

## 0.13.7
- **Faster Buy everything:** up to 16 purchases in flight at about 40 a second, so a full restock takes about 2.5 s instead of 6–7 s. Counts stay exact and it still stops after 3 refusals in a row.
- **New 🧪 Teams button** (above 🛒): shows while eggs are ready to hatch or pets are in your Useless list, with counts (🥚 / 💰). Clicking it opens the panel on the Teams tab. You can turn it off in Settings.
- **🛒 always opens the Buy window**, even with nothing to buy. The window waits (grey) and turns red at the next restock.

## 0.13.6
- **Buy window note follows your settings:** the text at the top now says what will and won't be bought (potions, dust items, buildings, one-time items) and mentions the coins/dust/space check.

## 0.13.5
- **"Hatch anyway" is harder to misclick:** it's now a small link in the corner, away from the big "OK, I'll fix it" button, and ignores clicks for the first second.

## 0.13.4
- **Hatch check covers idle pets:** pressing Hatch also stops and asks when pets out don't help with hatching (one pop-up lists every problem). Each check has its own switch in Settings.
- **Removed the "eggs are ready to hatch" reminder.** Reminder pop-ups now disappear after 30 s.
- **Ties go to the older pet:** when two pets are equally good (e.g. SUPERFOOD and SUPERFOOD 2), Level up and every team now always pick the one with more XP.

## 0.13.3
- **Strength Crystal hatch stop:** pressing Hatch while the crystal isn't out stops the hatch and asks first (OK / hatch anyway / don't show again).
- **Buy everything pre-check:** coins, Magic Dust and free inventory slots are checked before buying. Anything that won't fit is listed under "Left out before buying" and not sent.
- **Good Gold/Rainbow collection:** the best copy of each different ability mix per species is kept; only weaker duplicates can be sold.

## 0.13.2
- **XP/Hunger potion toggle:** Settings → 🛒 Shop, "But do buy XP and Hunger potions (spends Magic Dust)", off by default. Tiles show the dust price, and a dust shortfall is explained.
- **Credits can never be spent:** any command that would spend credits is blocked.
