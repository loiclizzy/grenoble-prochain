# Prochain

Prochains passages tram et bus à Grenoble, en temps réel. Une PWA statique, sans backend ni dépendance.

Données : API ouverte Métromobilité (`data.mobilites-m.fr`), appelée directement depuis le navigateur.

## Lancer en local

```bash
python3 -m http.server 8765
```

Puis ouvrir http://localhost:8765.

## Déployer

Copier le dossier tel quel sur n'importe quel hébergement statique en HTTPS (GitHub Pages, Netlify, Cloudflare Pages). Sur le téléphone : ouvrir l'URL → « Ajouter à l'écran d'accueil ».

Après une modification, incrémenter `CACHE` dans `sw.js` pour que les téléphones récupèrent la nouvelle version.

## Liens utiles

- `?stop=SEM:GENVH` ouvre directement un arrêt.
- `?stop=SEM:GENVH&speak=1` l'annonce à voix haute (raccourci Siri / Google Assistant).
- `#s=SEM:GENVH,SEM:GENGAR` ajoute ces arrêts aux favoris (pour transférer ses favoris sur un autre appareil).

## Fichiers

- `index.html`, `style.css`, `app.js` : l'application
- `sw.js` : cache hors ligne de l'interface (les données temps réel ne sont jamais mises en cache par le SW)
- `manifest.webmanifest`, `icons/` : installation sur l'écran d'accueil
