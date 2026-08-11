# Seedbox qBittorrent — plugin TR4K UI

Envoie les torrents vers un qBittorrent distant et affiche l'état de la seedbox
directement dans [TR4K UI](https://github.com/Opmovies/tr4k-ui).

## Installation

```bash
cd tr4k-ui && npm run plugin:pack -- ../seedbox-qbit   # → seedbox-qbit-x.y.z.zip
```

Puis glisse-dépose le zip sur la page **/plugins** de TR4K UI.

## Réglages

| Champ | Description |
|---|---|
| URL du WebUI qBittorrent | Adresse du WebUI, accessible depuis le serveur TR4K UI (pas depuis ton navigateur) |
| Utilisateur / Mot de passe | Identifiants du WebUI (le mot de passe est stocké chiffré côté serveur) |
| Catégorie par défaut | Catégorie qBittorrent appliquée aux torrents envoyés (`tr4k` par défaut, vide = aucune) |

## Fonctionnalités

- Envoi d'un torrent vers la seedbox depuis la fiche torrent, la liste ou les doublons du profil
- Badges d'état (présent sur la seedbox, progression) sur les lignes et fiches torrents
- Panneau d'état de la seedbox (torrents actifs, débits up/down) dans la navigation

## Structure

- `plugin.json` — manifeste (réglages, slots, permissions)
- `client.mjs` — UI injectée dans les slots de TR4K UI
- `server.mjs` — routes serveur qui parlent au WebUI qBittorrent (session, ajout, état)
