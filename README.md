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

The page is [remote.html](remote.html) in this repository, served by GitHub Pages. It talks to your PC through [ntfy.sh](https://ntfy.sh), a free public relay, on a secret pairing code (the part after # in the link, which stays on your phone). Keep the link to yourself; **New code** makes old links stop working. Rare alerts and Buy results can also go to the ntfy phone app, with a "Buy on PC" button.

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
- **Buy everything:** buys every shop's stock in one press per restock and puts purchases away in the Seed Silo, Tool Shack and Decor Shed. You can switch off individual items. Buildings, one-time items and Magic Dust items are never bought (XP and Hunger potions optional).
- **Rare item alert:** a message, chime and optional system notification when an item you picked (or a rare one) is in a shop.
- **📱 Phone page:** press Buy or Reconnect on your PC from your phone.
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
- Phone remote messages through [ntfy.sh](https://ntfy.sh).

This is a fan-made mod, not affiliated with Magic Garden.
