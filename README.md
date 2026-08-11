# Seedbox — plugin TR4K UI

Envoie les torrents vers ta ou tes seedbox et affiche leur état directement dans
[TR4K UI](https://github.com/Opmovies/tr4k-ui). Depuis la v2, le plugin gère
**plusieurs configurations** (multi-seedbox) et **plusieurs clients torrent**
derrière un contrat commun : **qBittorrent** et **Hydra**.

## Installation

```bash
cd tr4k-ui && npm run plugin:pack -- ../plugins-src/seedbox-qbit   # → seedbox-qbit-x.y.z.zip
```

Puis glisse-dépose le zip sur la page **/plugins** de TR4K UI.

> La v2 requiert TR4K UI ≥ 1.5 (panneau de réglages rendu via l'ancre
> `plugin.settings.<id>` sans champs déclarés dans le manifest).

## Configurations

Les réglages (Plugins → Seedbox → Réglages) sont une **liste de configurations**,
chacune avec un nom, un client torrent et ses champs propres. L'une d'elles est la
config **par défaut** : c'est elle qui reçoit les envois depuis la liste / la fiche
torrent. Le cross-seed, lui, cible automatiquement la seedbox où la release existe déjà.

- **Tester** : éprouve le brouillon du formulaire **sans rien enregistrer**.
- **Tester et enregistrer** : teste, puis enregistre si la connexion répond.

Les anciens réglages (v1, mono-config qBittorrent) sont migrés automatiquement.

### Providers

| Provider | Champs | Notes |
|---|---|---|
| **qBittorrent** | URL du WebUI, utilisateur, mot de passe, catégorie | WebUI API v2, compatible ≤5.1 (« Ok. », cookie `SID`) et ≥5.2 (204, cookie `QBT_SID_<port>`, contrat JSON de `/torrents/add`) ; auth déléguée à un proxy tolérée ; jamais d'Origin/Referer (reverse-proxies) ; multipart construit à la main (parseur 5.2 strict) ; session par config, re-login unique sur 403 (5.x bannit l'IP après plusieurs échecs de login). |
| **Hydra** ([Kheopsian/Hydra](https://github.com/Kheopsian/Hydra)) | URL, catégorie | Via son shim qBittorrent v2 (sans auth). La catégorie détermine le moteur race/hoard côté Hydra. Débits globaux non exposés ; cross-seed avec `skip_checking=true` (pattern recommandé par la doc Hydra). |

### Le contrat provider

Chaque client torrent implémente le contrat défini dans
[`providers/index.mjs`](providers/index.mjs) :

```
id, label, fields          // identité + schéma de formulaire (champs `secret` masqués)
test(cfg, io)              // vérifie la connexion SANS RIEN MODIFIER (teste les brouillons)
list(cfg, io)              // liste normalisée {hash, name, size, progress, tracker, save_path…}
transfer(cfg, io)          // débits globaux {dl, up}, ou null si non exposés
add(cfg, io, {buf, filename, category, savepath, skipChecking})  // ajout d'un .torrent
```

Ajouter un client (Transmission, Deluge…) = un fichier dans `providers/` + une entrée
dans le registre. Ni `server.mjs` ni `client.mjs` n'ont besoin de changer.

## Fonctionnalités

- Envoi d'un torrent vers la seedbox par défaut depuis la fiche torrent, la liste ou les doublons du profil
- Cross-seed vers la seedbox qui possède déjà la release (autre tracker, mêmes fichiers)
- Badges d'état (présent sur une seedbox, progression) sur les lignes, groupes et fiches — agrégés sur toutes les configs
- Page de suivi avec sélecteur de seedbox (torrents actifs, débits quand le client les expose)
- Filtre « Masquer seedbox » dans la barre d'outils de la liste

## Structure

- `plugin.json` — manifeste (slots, permissions ; pas de champs de réglages : l'UI est fournie par le plugin)
- `client.mjs` — UI injectée dans les slots de TR4K UI + gestionnaire de configurations
- `server.mjs` — store des configs (chiffré par l'hôte), routes torrents branchées sur le contrat
- `providers/` — contrat commun + implémentations (`qbittorrent.mjs`, `hydra.mjs`)
