// Plugin Seedbox qBittorrent — partie client (JS pur, sans build).
// Les composants sont des objets Vue à `template` string, compilés par le runtimeCompiler
// de l'hôte. Vue vient de l'hôte via api.vue — ne JAMAIS importer vue ici.
export default function setup(api) {
  const { ref, computed, watch, onMounted, onUnmounted } = api.vue
  const IconSend = api.ui.icons.HardDriveDownload
  const IconCross = api.ui.icons.Shuffle
  const IconCheck = api.ui.icons.Check

  // ================= index de la seedbox (matching des releases) =================
  // map = [{hash, name, size, tracker, progress}] ; null tant que non chargé/indisponible.
  const map = ref(null)
  let byHash = new Map()
  let byName = new Map()
  let bySize = new Map()
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '')
  const isTr4k = (e) => /tr4ker/i.test(e.tracker || '')

  let mapTimer = null
  async function loadMap() {
    try {
      const data = await api.fetch('/map')
      byHash = new Map()
      byName = new Map()
      bySize = new Map()
      for (const e of data) {
        if (e.hash) byHash.set(e.hash, e)
        const n = norm(e.name)
        if (n) byName.set(n, [...(byName.get(n) || []), e])
        if (e.size) bySize.set(e.size, [...(bySize.get(e.size) || []), e])
      }
      map.value = data
      scheduleMap(60_000)
    } catch (e) {
      map.value = null
      // 400 = pas configuré → inutile d'insister ; sinon (seedbox down…) on retente plus tard
      if ((e?.status || e?.statusCode) !== 400) scheduleMap(300_000)
    }
  }
  function scheduleMap(ms) { clearTimeout(mapTimer); mapTimer = setTimeout(loadMap, ms) }
  loadMap()

  /** Statut d'une release vis-à-vis de la seedbox :
   *  'seedbox' = ce torrent y est déjà (hash identique, ou candidat via tracker tr4ker)
   *  'cross'   = même release présente via un AUTRE tracker → cross-seed possible
   *  Candidats = même nom normalisé OU même taille EXACTE à l'octet. La taille exacte est
   *  indispensable pour la LISTE : elle n'expose pas info_hash, et le nom affiché par le
   *  tracker est souvent décoré (« … (Titre français) ») ≠ nom du torrent dans qBittorrent. */
  function matchFor(t) {
    if (!map.value || !t) return { status: null }
    const h = String(t.info_hash || '').toLowerCase()
    if (h && byHash.has(h)) return { status: 'seedbox', e: byHash.get(h) }
    const sz = t.size_bytes || 0
    const cands = [...(byName.get(norm(t.name)) || []), ...(sz ? bySize.get(sz) || [] : [])]
    if (!cands.length) return { status: null }
    const fromTr4k = cands.find(isTr4k)
    if (fromTr4k) return { status: 'seedbox', e: fromTr4k }
    // autre tracker : cross-seed si taille exacte, ou nom identique avec taille proche (±2 %)
    const close = cands.find((e) => e.size === sz || !sz || !e.size || Math.abs(e.size - sz) / Math.max(e.size, sz) <= 0.02)
    return close ? { status: 'cross', e: close } : { status: null }
  }

  // ================= badge « SEEDBOX » (lignes + fiche) =================
  const SeedboxBadge = {
    props: ['ctx'],
    template: `<span v-if="on" class="badge b-cat" title="Cette release est déjà sur ta seedbox">SEEDBOX</span>`,
    setup(props) {
      const on = computed(() => matchFor(props.ctx).status === 'seedbox')
      return { on }
    },
  }
  api.ui.registerSlot('torrent.row.badges', SeedboxBadge)
  api.ui.registerSlot('torrent.detail.badges', SeedboxBadge)

  // en-tête d'un groupe « Par œuvre » : badge si AU MOINS une release du groupe est sur la seedbox
  api.ui.registerSlot('torrent.group.badges', {
    props: ['ctx'], // ctx = groupe { releases[], rep, count… }
    template: `<span v-if="n" class="badge b-cat" :title="n + ' release(s) de ce groupe déjà sur ta seedbox'">SEEDBOX{{ n > 1 ? ' ×' + n : '' }}</span>`,
    setup(props) {
      const n = computed(() => (props.ctx?.releases || []).filter((t) => matchFor(t).status === 'seedbox').length)
      return { n }
    },
  })

  // ================= bouton d'action : envoyer / cross-seed / déjà là =================
  const SendBtn = {
    props: ['ctx', 'wide'],
    components: { IconSend, IconCross, IconCheck },
    template: `
      <span v-if="state === 'seedbox'" class="iconbtn" style="cursor:default; color:var(--accent); border-color:transparent"
            :title="'Déjà sur la seedbox'">
        <IconCheck :size="15" /><template v-if="wide"> Sur la seedbox</template>
      </span>
      <button v-else-if="state === 'cross'" class="iconbtn" :disabled="busy"
              :style="wide ? 'display:inline-flex; gap:7px; align-items:center; padding:8px 16px' : ''"
              title="Cross-seed : cette release est sur la seedbox via un autre tracker — ajouter la version TR4KER sur les mêmes fichiers"
              @click="crossSeed">
        <span v-if="busy" class="spin" /><IconCross v-else :size="15" />
        <template v-if="wide"> Cross-seed</template>
      </button>
      <button v-else class="iconbtn" :disabled="busy"
              :style="wide ? 'display:inline-flex; gap:7px; align-items:center; padding:8px 16px' : ''"
              title="Envoyer à la seedbox" @click="send">
        <span v-if="busy" class="spin" /><IconSend v-else :size="15" />
        <template v-if="wide"> Envoyer à la seedbox</template>
      </button>`,
    setup(props) {
      const busy = ref(false)
      const local = ref('') // devient 'seedbox' après un envoi/cross réussi (avant le refresh du /map)
      const state = computed(() => local.value || matchFor(props.ctx).status)
      async function send() {
        busy.value = true
        try {
          await api.fetch('/add', { method: 'POST', body: { slug: props.ctx.slug } })
          local.value = 'seedbox'
          api.ui.toast('Seedbox', `« ${props.ctx.name || props.ctx.slug} » envoyé à qBittorrent`)
          loadMap()
        } catch (e) {
          api.ui.toast('Seedbox : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        busy.value = false
      }
      async function crossSeed() {
        busy.value = true
        try {
          const target = matchFor(props.ctx).e
          const r = await api.fetch('/cross-seed', { method: 'POST', body: { slug: props.ctx.slug, target_hash: target.hash } })
          local.value = 'seedbox'
          api.ui.toast('Cross-seed lancé', `Ajouté dans ${r.savepath} — qBittorrent vérifie les fichiers existants puis seed`)
          loadMap()
        } catch (e) {
          api.ui.toast('Cross-seed : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        busy.value = false
      }
      return { busy, state, send, crossSeed }
    },
  }
  api.ui.registerSlot('torrent.row.actions', SendBtn)
  api.ui.registerSlot('torrent.detail.actions', {
    props: ['ctx'],
    components: { SendBtn },
    template: `<SendBtn :ctx="ctx" :wide="true" />`,
  })

  // ================= doublons du profil : basculer la seedbox sur la version conservée =================
  // ctx = un doublon {retired_slug/name, kept_slug/name, kept_seeders, size_bytes} (ancre
  // profile.duplicates.actions). Retirée et conservée ont la MÊME taille : c'est le nom
  // normalisé qui départage laquelle des deux est réellement sur la seedbox.
  api.ui.registerSlot('profile.duplicates.actions', {
    props: { ctx: Object },
    components: { IconSend, IconCross, IconCheck },
    template: `
      <span v-if="state === 'done'" class="iconbtn" style="cursor:default; color:var(--accent); border-color:transparent"
            title="La version conservée est déjà sur ta seedbox — rien à faire">
        <IconCheck :size="15" />
      </span>
      <button v-else-if="state === 'cross'" class="iconbtn" :disabled="busy"
              title="La version retirée est sur ta seedbox : cross-seed de la version conservée sur les mêmes fichiers (re-vérification puis seed, aucun re-téléchargement)"
              @click="cross">
        <span v-if="busy" class="spin" /><IconCross v-else :size="15" />
      </button>
      <button v-else-if="state === 'send'" class="iconbtn" :disabled="busy"
              title="Envoyer la version conservée à la seedbox" @click="send">
        <span v-if="busy" class="spin" /><IconSend v-else :size="15" />
      </button>`,
    setup(props) {
      const busy = ref(false)
      const local = ref('') // 'done' après une action réussie, avant le refresh du /map
      const keptHit = () => (byName.get(norm(props.ctx?.kept_name)) || [])[0]
      // cible du cross-seed : la retirée par son nom, sinon n'importe quel torrent de taille EXACTE
      const target = () => (byName.get(norm(props.ctx?.retired_name)) || [])[0]
        || (bySize.get(props.ctx?.size_bytes) || [])[0]
      const state = computed(() => {
        if (local.value) return local.value
        if (!map.value || !props.ctx) return '' // seedbox non configurée → rien
        if (keptHit()) return 'done'
        return target() ? 'cross' : 'send'
      })
      async function cross() {
        busy.value = true
        try {
          const r = await api.fetch('/cross-seed', { method: 'POST', body: { slug: props.ctx.kept_slug, target_hash: target().hash } })
          local.value = 'done'
          api.ui.toast('Cross-seed lancé', `Version conservée ajoutée dans ${r.savepath} — qBittorrent vérifie puis seed`)
          loadMap()
        } catch (e) {
          api.ui.toast('Cross-seed : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        busy.value = false
      }
      async function send() {
        busy.value = true
        try {
          await api.fetch('/add', { method: 'POST', body: { slug: props.ctx.kept_slug } })
          local.value = 'done'
          api.ui.toast('Seedbox', `« ${props.ctx.kept_name} » envoyé à qBittorrent`)
          loadMap()
        } catch (e) {
          api.ui.toast('Seedbox : échec', e?.data?.statusMessage || e?.message || 'Erreur inconnue')
        }
        busy.value = false
      }
      return { busy, state, cross, send }
    },
  })

  // ================= toggle « Masquer seedbox » (barre d'outils de la liste) =================
  const HIDE_KEY = 'tr4kui.seedbox-qbit.hide'
  const hideSb = ref(false)
  try { hideSb.value = localStorage.getItem(HIDE_KEY) === '1' } catch {}
  watch(hideSb, (v) => { try { localStorage.setItem(HIDE_KEY, v ? '1' : '0') } catch {} })

  api.ui.registerSlot('torrent.list.toolbar', {
    components: { IconSend },
    template: `
      <label v-if="ready" class="sw" :class="{ on: hideSb }"
             title="Masquer les releases déjà présentes sur la seedbox" @click="hideSb = !hideSb">
        <span class="track" /> <IconSend :size="13" /> Masquer seedbox
      </label>`,
    setup() {
      const ready = computed(() => !!map.value)
      return { ready, hideSb }
    },
  })

  // filtre de liste : lu par le computed `items` d'index.vue → réactif à hideSb et au /map
  api.filters.addFilter('torrent.list.items', (list) => {
    if (!hideSb.value || !map.value) return list
    return list.filter((t) => matchFor(t).status !== 'seedbox')
  })

  // ================= bouton « Tester la connexion » sous le formulaire de réglages =================
  api.ui.registerSlot('plugin.settings.seedbox-qbit', {
    template: `
      <div style="margin-top:12px; display:flex; gap:10px; align-items:center; flex-wrap:wrap">
        <button class="ghost small" :disabled="busy" @click="test">
          <span v-if="busy" class="spin" /> Tester la connexion
        </button>
        <span v-if="result" :style="result.ok ? 'color:var(--accent); font-size:12.5px' : 'color:#ff6b6b; font-size:12.5px'">
          {{ result.ok ? '● Connecté — qBittorrent v' + (result.version || '?') : '○ ' + result.error }}
        </span>
        <span class="muted" style="font-size:11px; flex-basis:100%">Teste les réglages ENREGISTRÉS — pense à enregistrer d'abord.</span>
      </div>`,
    setup() {
      const busy = ref(false)
      const result = ref(null)
      async function test() {
        busy.value = true
        result.value = null
        try {
          result.value = await api.fetch('/test')
          if (result.value.ok) loadMap()
        } catch (e) { result.value = { ok: false, error: e?.data?.statusMessage || e?.message || 'Erreur' } }
        busy.value = false
      }
      return { busy, result, test }
    },
  })

  // ================= page /p/seedbox-qbit : suivi de la seedbox =================
  const Page = {
    components: { IconSend },
    template: `
      <div style="padding-top:16px; display:flex; flex-direction:column; gap:14px">
        <h1 style="margin:0; font-size:19px; display:flex; gap:9px; align-items:center"><IconSend :size="20" /> Seedbox</h1>

        <div v-if="!configured" class="pill-note">
          Seedbox non configurée : renseigne l'URL du WebUI dans la page <b>Plugins → Seedbox qBittorrent → Réglages</b>.
        </div>

        <div v-else class="card" style="display:flex; gap:18px; align-items:center; flex-wrap:wrap">
          <span v-if="status && status.ok" style="color:var(--accent)">● Connecté</span>
          <span v-else-if="status" style="color:#ff6b6b">○ {{ status.error }}</span>
          <span v-else class="muted"><span class="spin" /> Connexion…</span>
          <template v-if="status && status.ok">
            <span class="mono muted" style="font-size:12px">↓ {{ fmtSpeed(status.dl) }}</span>
            <span class="mono muted" style="font-size:12px">↑ {{ fmtSpeed(status.up) }}</span>
            <span class="mono muted" style="font-size:12px">{{ torrents.length }} torrent(s)</span>
          </template>
          <span style="flex:1" />
          <button class="ghost small" :disabled="loading" @click="refresh">Actualiser</button>
        </div>

        <div v-if="status && status.ok" class="tablewrap">
          <table>
            <thead><tr><th>Nom</th><th class="num">Progression</th><th>État</th><th class="num">↓</th><th class="num">↑</th><th class="num">Ratio</th><th class="num">Taille</th></tr></thead>
            <tbody>
              <tr v-for="t in torrents" :key="t.hash">
                <td class="grow" style="font-size:12.5px; max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" :title="t.name">{{ t.name }}</td>
                <td class="num mono">{{ Math.round((t.progress || 0) * 100) }} %</td>
                <td><span class="badge" :class="stateClass(t.state)">{{ stateLabel(t.state) }}</span></td>
                <td class="num mono">{{ fmtSpeed(t.dlspeed) }}</td>
                <td class="num mono">{{ fmtSpeed(t.upspeed) }}</td>
                <td class="num mono">{{ (t.ratio || 0).toFixed(2) }}</td>
                <td class="num mono">{{ fmtBytes(t.size) }}</td>
              </tr>
              <tr v-if="!torrents.length"><td colspan="7" class="empty">Aucun torrent sur la seedbox.</td></tr>
            </tbody>
          </table>
        </div>
      </div>`,
    setup() {
      const torrents = ref([])
      const status = ref(null)
      const loading = ref(false)
      const configured = ref(true)
      let timer = null
      async function refresh() {
        loading.value = true
        try {
          const s = await api.fetch('/status')
          status.value = { ok: true, dl: s.dl_info_speed, up: s.up_info_speed }
          torrents.value = await api.fetch('/torrents')
        } catch (e) {
          const msg = e?.data?.statusMessage || e?.message || 'Erreur'
          if (e?.status === 400 || e?.statusCode === 400) configured.value = false
          status.value = { ok: false, error: msg }
        }
        loading.value = false
      }
      onMounted(() => { refresh(); timer = setInterval(refresh, 5000) })
      onUnmounted(() => clearInterval(timer))
      const fmtSpeed = (b) => !b ? '—' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' Mo/s' : Math.round(b / 1024) + ' Ko/s'
      const fmtBytes = (b) => !b ? '—' : b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' Go' : (b / 1048576).toFixed(0) + ' Mo'
      const stateLabel = (s) => ({
        downloading: 'Téléchargement', stalledDL: 'En attente ↓', metaDL: 'Métadonnées',
        uploading: 'Seed', stalledUP: 'Seed (calme)', queuedDL: 'File ↓', queuedUP: 'File ↑',
        pausedDL: 'Pause ↓', pausedUP: 'Pause ↑', stoppedDL: 'Arrêté ↓', stoppedUP: 'Arrêté ↑',
        checkingDL: 'Vérification', checkingUP: 'Vérification', error: 'Erreur', missingFiles: 'Fichiers manquants',
      })[s] || s
      const stateClass = (s) => /error|missing/i.test(s) ? 'b-bad' : /up|seed/i.test(s) ? 'b-cat' : ''
      return { torrents, status, loading, configured, refresh, fmtSpeed, fmtBytes, stateLabel, stateClass }
    },
  }
  api.ui.registerPage({ path: '/p/seedbox-qbit', component: Page, title: 'Seedbox', icon: 'HardDriveDownload', order: 40 })
}
