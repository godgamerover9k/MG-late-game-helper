# MG Lategame Helper

A Tampermonkey userscript for [Magic Garden](https://magicgarden.gg) for late-game players: it finds pets you can sell, builds your best pet teams, plans hatching and levelling, and buys whole shop restocks in one press.

Nothing is ever sold or bought without your press, and credits are never spent.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open **[MG-Lategame-Helper.user.js](https://raw.githubusercontent.com/godgamerover9k/MG-late-game-helper/main/MG-Lategame-Helper.user.js)** and press **Install**.
3. Reload Magic Garden. Open the panel with the 🐾 button or **Alt+P**.

### Updates

Tampermonkey checks this repository for a new version once a day and installs it. To update right away, click the Tampermonkey icon, choose **Check for userscript updates**, then reload the game.

## Phone page

Press **Buy everything** on your PC from your phone, without installing anything on the phone:

1. On the PC, in the game: **Settings → 📱 Phone remote**, switch it on, press **Copy phone link**.
2. Open that link on your phone (send it to yourself) and bookmark it.

The page shows whether your PC's game is connected, what's in stock to buy and when the next restock is, with a **Buy on PC** button (the same list and checks as pressing Buy on the PC) and **Reconnect PC** (reloads the game on the PC after it was disconnected; only when you press it). The phone never joins the game, so nothing gets disconnected. The PC must be on with the game open.

The page is [remote.html](remote.html) in this repository, served by GitHub Pages. It talks to your PC through public MQTT message brokers ([HiveMQ](https://www.hivemq.com/mqtt/public-mqtt-broker/) and [EMQX](https://www.emqx.com/en/mqtt/public-mqtt5-broker), both at once): no account and no daily limit. The pairing code is the part after # in the link; it stays on your phone and PC. Keep the link to yourself; **New code** makes old links stop working. Repeating item alerts can also go to the [ntfy](https://ntfy.sh) phone app, with "Buy on PC" and "Stop" buttons.

**What the remote can do:**
- The PC takes only four commands from a phone: **Buy** (the same as pressing Buy everything on the PC, with all its rules: no selling, no credits, no Magic Dust except the potions you allowed), **Reconnect** (only while the game on the PC is disconnected), **Stop** (repeating alerts) and a status refresh.
- None of these commands take any input. Anything else is ignored, and nothing a phone sends reaches the game.
- The phone only sees whether the game is connected, what's to buy and when the next restock is.

**Security:**
- Messages are encrypted and signed with keys made from the pairing code, on a relay topic that is a hash of it.
- Others on the public brokers can't read them or send commands the PC accepts.
- Each command runs once, and only while it is at most 5 minutes old.

**Several PCs, Buy-only links:** the page can hold several PCs (one card each, plus **Buy on all**) and add or share several codes at once.
- On a PC, **Let people with my Buy-only link press Buy on this PC** (off by default) and **Copy Buy-only link** give a link that can only press Buy and see what's to buy.
- That link can't be turned back into the pairing code.
- Switching sharing off stops it; **New code** cancels it.
- Several people can press Buy at once: there's only one buy at a time, and later presses get its result.

## Features

- **Pets to sell:** lists pets that enough of your other pets beat at everything they do, with a reason for each. "Maybe sell" and "Kept anyway" lists show the borderline cases.
- **Best teams:** max STR hatching, Gold/Rainbow, rare pets, crop selling, harvesting, charge & capture, pet refund and pet dust. One press swaps a team in.
- **Level-up team:** grows the pets your best teams need, with a hunger pet and an XP booster, and shows the time to max level.
- **Egg planner:** which hatching team to use for each egg to fill your pet journal.
- **Safety prompts:**
  - stops a hatch if the Strength Crystal isn't out or your pets don't help hatching;
  - warns before selling pets without the crystal or selling team;
  - asks before selling valuable crops in a room that isn't full;
  - asks before harvesting a Gold/Rainbow celestial crop without Double Harvest pets out.
- **Journal:** pet and crop logging, crop filters by mutation, the missing variants shown above the plant you stand on, and seeds taken from the Seed Silo in one press.
- **Mounts:** while riding a Thundercharger or Capture pet, shows how many crops it would charge or capsules it would make where you stand.
- **Buy everything:** buys every shop's stock in one press per restock and puts purchases away in the Seed Silo, Tool Shack and Decor Shed. A menu lets you choose, for every item in the game, whether it's bought. Buildings, one-time items and Magic Dust items are never bought (XP and Hunger potions optional).
- **Item alerts:** for every item, no alert, once per restock, or repeating until bought (repeating ones also reach your phone). Can be imported from Arie's Mod.
- **Game notifications (phone app):** manage the game's own restock notifications for every item of every shop, open or not; changing an item's alert in the mod switches its phone-app notification too (can be turned off).
- **📱 Phone page:** press Buy or Reconnect on your PC from your phone; several PCs on one page; Buy-only links for others.
- **Other:**
  - joins a public room with 5 players in one press;
  - pity alert (with QPM);
  - keeps the game running in a background tab.
- **Settings:** every feature can be switched off, every rule changed, and settings shared as a code.

Works on its own and alongside [QPM](https://github.com/mg-tokyo/QPM-GR) and Arie's Mod.

## Credits

- [QPM](https://github.com/mg-tokyo/QPM-GR) by TOKYO.#6464: how game commands are sent.
- [Arie's Mod](https://github.com/Ariedam64) by Ariedam64: live game data, sprites and the public room list (mg-api.ariedam.fr, ariesmod-api.ariedam.fr).
- Game rules and numbers from the [Magic Garden Wiki](https://magicgarden.wiki).
- Phone remote through the public MQTT brokers of HiveMQ and EMQX; phone notifications through [ntfy.sh](https://ntfy.sh).

This is a fan-made mod, not affiliated with Magic Garden.
