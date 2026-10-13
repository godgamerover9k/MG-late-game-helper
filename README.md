# MG Lategame Helper

A Tampermonkey userscript for [Magic Garden](https://magicgarden.gg) for late-game players: it finds pets you can sell, builds your best pet teams, plans hatching and levelling, and buys whole shop restocks in one press.

Nothing is ever sold or bought without your press, and credits are never spent.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open **[MG-Lategame-Helper.user.js](https://raw.githubusercontent.com/godgamerover9k/MG-late-game-helper/main/MG-Lategame-Helper.user.js)** and press **Install**.
3. Reload Magic Garden. Open the panel with the 🐾 button or **Alt+P**.

### Updates

Tampermonkey checks this repository for a new version once a day and installs it. To update right away, click the Tampermonkey icon, choose **Check for userscript updates**, then reload the game.

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

This is a fan-made mod, not affiliated with Magic Garden.
